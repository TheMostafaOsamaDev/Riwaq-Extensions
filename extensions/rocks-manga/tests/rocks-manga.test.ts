// Fixtures in tests/fixtures were captured live from https://rocksmanga.com on
// 2026-11-05 with a browser UA and `Accept-Language: ar,en;q=0.8`:
//   browse.html   GET /browse?sort=most_viewed&page=1&search=&type=&status=&genre=  (24 cards)
//   series.html   GET /manga/baki-rahen            (32 chapters inline; sidebar lists other series)
//   chapter.html  GET /manga/baki-rahen/chapter/1  (34 pages)
// Series and chapter data sit in the page's self.__next_f.push([1, "..."]) payloads.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createTestHost } from "@riwaq/extension-api/testing";
import createSource from "../src/index";

// fileURLToPath rather than `new URL(rel, import.meta.url)`: see the note in
// extensions/cenele/tests/cenele.test.ts (happy-dom patches global URL).
const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");
const read = (name: string) => readFileSync(join(FIXTURES_DIR, name), "utf8");

const SITE = "https://rocksmanga.com";
const API = "https://api.rocksmanga.com";
const SERIES = `${SITE}/manga/baki-rahen`;
const CHAPTER = `${SERIES}/chapter/1`;

const browse = read("browse.html");
const seriesHtml = read("series.html");
const chapterHtml = read("chapter.html");

/** The page's flight payload, joined: what the fixture's own scripts say. */
function flight(html: string): string {
  const out: string[] = [];
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) out.push(JSON.parse(m[1]));
  return out.join("");
}

/** Raw chapter list of the fixture, parsed independently of the source. */
function fixtureChapters(): Array<{ id: number; number: string; title: string }> {
  const text = flight(seriesHtml);
  const start = text.indexOf('"chapters":[', text.indexOf('"mangaSlug":"baki-rahen"')) + '"chapters":'.length;
  let depth = 0;
  let i = start;
  for (; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]" && --depth === 0) break;
  }
  return JSON.parse(text.slice(start, i + 1));
}

const responses = {
  "/browse?": browse,
  "/manga/baki-rahen/chapter/1": chapterHtml,
  "/manga/baki-rahen": seriesHtml,
};

/** A flight-data page around `payload`, split in two pushes like the real ones. */
function page(payload: string): string {
  const mid = Math.floor(payload.length / 2);
  const push = (s: string) => `<script>self.__next_f.push([1,${JSON.stringify(s)}])</script>`;
  return `<html><body>${push(payload.slice(0, mid))}${push(payload.slice(mid))}</body></html>`;
}

const seriesPayload = (chapters: unknown[], manga: Record<string, unknown> = {}) =>
  `8:[["$","aside",null,{"items":[{"id":9,"slug":"other","title":"Other","is_nsfw":true,"synopsis":"x"}]}],` +
  `["$","div",null,{"manga":${JSON.stringify({ id: 1, slug: "baki-rahen", title: "Baki", synopsis: "s", cover_url: "/storage/manga/1/c.webp", type: "MANGA", status: "RELEASING", is_nsfw: false, authors: [], genres: [], ...manga })}}],` +
  `["$","$L34",null,{"mangaSlug":"baki-rahen","chapters":${JSON.stringify(chapters)}}]]`;

describe("rocks-manga", () => {
  it("canHandle accepts rocksmanga.com and www only", () => {
    const source = createSource(createTestHost());
    expect(source.canHandle(SERIES)).toBe(true);
    expect(source.canHandle("https://www.rocksmanga.com/browse")).toBe(true);
    expect(source.canHandle("https://api.rocksmanga.com/x")).toBe(false);
  });

  it("home sections: latest then popular, 24 manga cards each", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const sections = await createSource(createTestHost({ responses, calls })).getHomeSections();
    expect(sections.map((s) => s.id)).toEqual(["latest", "popular"]);
    expect(calls.map((c) => c.url).sort()).toEqual(
      [`${SITE}/browse?sort=latest&page=1`, `${SITE}/browse?sort=most_viewed&page=1`].sort(),
    );
    const units = (browse.match(/class="unit"/g) ?? []).length;
    expect(units).toBeGreaterThan(0);
    for (const s of sections) {
      expect(s.cards).toHaveLength(units);
      for (const c of s.cards) {
        expect(c.contentType).toBe("manga");
        expect(c.url).toMatch(/^https:\/\/rocksmanga\.com\/manga\/[^/]+$/);
        expect(c.title).not.toBe("");
        expect(c.coverUrl).toMatch(/^https:\/\/api\.rocksmanga\.com\/storage\/manga\//);
      }
    }
    expect(sections[0].cards[0].url).toBe(`${SITE}/manga/juujika-no-rokunin`);
    expect(sections[0].cards[0].title).toBe("Juujika no Rokunin");
  });

  it("cards carry nsfw from the flight data's per-item isNsfw", async () => {
    const text = flight(browse);
    const items = JSON.parse(
      text.slice(text.indexOf('"cards":[') + 8).replace(/^(\[(?:[^[\]]|\[[^\]]*\])*\]).*$/s, "$1"),
    ) as Array<{ slug: string; isNsfw: boolean }>;
    expect(items.length).toBeGreaterThan(0);
    const [home] = await createSource(createTestHost({ responses })).getHomeSections();
    for (const card of home.cards) {
      const item = items.find((i) => card.url === `${SITE}/manga/${i.slug}`)!;
      expect(card.nsfw).toBe(item.isNsfw);
    }
    const html = page(
      `{"cards":[{"slug":"a","title":"A","isNsfw":false},{"slug":"b","title":"B","isNsfw":true}]}`,
    ).replace(
      "</body>",
      `<div class="unit"><a class="poster" href="/manga/a"></a><div class="info"><a href="/manga/a">A</a></div></div>` +
        `<div class="unit"><a class="poster" href="/manga/b"></a><div class="info"><a href="/manga/b">B</a></div></div></body>`,
    );
    const r = await createSource(createTestHost({ responses: { "/browse?": html } })).search("x", 1);
    expect(r.cards.map((c) => [c.title, c.nsfw])).toEqual([["A", false], ["B", true]]);
  });

  it("search builds the browse URL and reads hasMore from rel=next", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const source = createSource(createTestHost({ responses, calls }));
    const result = await source.search("باكي", 2);
    expect(calls[0].url).toBe(`${SITE}/browse?sort=latest&page=2&search=${encodeURIComponent("باكي")}`);
    expect(result.page).toBe(2);
    expect(result.query).toBe("باكي");
    expect(result.cards.length).toBeGreaterThan(0);
    expect(result.hasMore).toBe(/rel="next"/.test(browse));
    const last = await createSource(
      createTestHost({ responses: { "/browse?": browse.replace(/rel="next"/g, 'rel="x"') } }),
    ).search("x", 1);
    expect(last.hasMore).toBe(false);
    const empty = await createSource(createTestHost({ calls: [] })).search("  ", 1);
    expect(empty.cards).toEqual([]);
  });

  it("series data is matched by slug, not the first object", async () => {
    // The sidebar objects (other series, one nsfw) come first in the payload.
    // The fixture's sidebar carries other series' objects with their own slug.
    expect(flight(seriesHtml)).toMatch(/"slug":"(?!baki-rahen")[^"]+","title"/);
    const novel = await createSource(createTestHost({ responses })).getNovel(SERIES);
    const raw = fixtureChapters();
    expect(novel.title).toBe("Baki Rahen");
    expect(novel.contentType).toBe("manga");
    expect(novel.direction).toBe("rtl");
    expect(novel.language).toBe("ar");
    expect(novel.coverUrl).toMatch(/^https:\/\/api\.rocksmanga\.com\/storage\/manga\/195\/cover\.webp/);
    expect(novel.description).toContain("باكي");
    expect(novel.tags).toContain("أكشن");
    const chapters = novel.volumes[0].chapters;
    expect(chapters).toHaveLength(raw.length);
    expect(chapters.map((c) => c.id).sort((a, b) => a - b)).toEqual(raw.map((c) => c.id).sort((a, b) => a - b));
    // Oldest first.
    const numbers = chapters.map((c) => c.number!);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(chapters[0].url).toBe(`${SERIES}/chapter/${raw.find((c) => c.id === chapters[0].id)!.number}`);
    expect(chapters.every((c) => c.lock === undefined)).toBe(true);
  });

  it("series matching ignores a sidebar series that comes first", async () => {
    const html = page(seriesPayload([{ id: 11, number: "1", title: "", created_at: "x" }]));
    const novel = await createSource(createTestHost({ responses: { "/manga/baki-rahen": html } })).getNovel(SERIES);
    expect(novel.title).toBe("Baki");
    expect(novel.contentType).toBe("manga");
    expect(novel.nsfw).toBe(false);
  });

  it("decimal chapters keep their decimal", async () => {
    const raw = fixtureChapters();
    const novel = await createSource(createTestHost({ responses })).getNovel(SERIES);
    for (const c of novel.volumes[0].chapters) {
      const r = raw.find((x) => x.id === c.id)!;
      expect(c.number).toBe(Number(r.number));
    }
    const html = page(
      seriesPayload([
        { id: 3, number: "65.2", title: "", created_at: "x" },
        { id: 2, number: "65", title: "T", created_at: "x" },
        { id: 4, number: "66", title: "", created_at: "x" },
      ]),
    );
    const n = await createSource(createTestHost({ responses: { "/manga/baki-rahen": html } })).getNovel(SERIES);
    const cs = n.volumes[0].chapters;
    expect(cs.map((c) => c.number)).toEqual([65, 65.2, 66]);
    expect(cs[1].url).toBe(`${SERIES}/chapter/65.2`);
    expect(cs[0].title).toBe("65 - T");
  });

  it("nsfw follows is_nsfw", async () => {
    const make = (nsfw: boolean) =>
      page(seriesPayload([{ id: 2, number: "1", title: "", created_at: "x" }], { is_nsfw: nsfw }));
    const get = (nsfw: boolean) =>
      createSource(createTestHost({ responses: { "/manga/baki-rahen": make(nsfw) } })).getNovel(SERIES);
    expect((await get(true)).nsfw).toBe(true);
    expect((await get(false)).nsfw).toBe(false);
  });

  it("pages are absolute URLs on api.rocksmanga.com", async () => {
    const source = createSource(createTestHost({ responses }));
    const novel = await source.getNovel(SERIES);
    const chapter = novel.volumes[0].chapters.find((c) => c.url === CHAPTER)!;
    const { pages } = await source.getChapterPages!(chapter);
    const listed = /"pages":(\[[^\]]*\])/.exec(flight(chapterHtml))![1];
    const expected = (JSON.parse(listed) as string[]).map((u) => `${API}${u}`);
    expect(expected.length).toBeGreaterThan(0);
    expect(pages.map((p) => p.url)).toEqual(expected);
    for (const p of pages) expect(p.url).toMatch(/^https:\/\/api\.rocksmanga\.com\/storage\/chapters\/5210\/pages\//);
    const lines = await source.getChapterContent(chapter);
    expect(lines.map((l) => l.content)).toEqual(pages.map((p) => p.url));
  });

  it("a locked chapter is flagged and never requested", async () => {
    const html = page(seriesPayload([{ id: 5, number: "1", title: "", created_at: "x", is_locked: true }]));
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const source = createSource(createTestHost({ responses: { "/manga/baki-rahen": html }, calls }));
    const chapter = (await source.getNovel(SERIES)).volumes[0].chapters[0];
    expect(chapter.lock).toEqual({ reason: "locked", openUrl: chapter.url });
    calls.length = 0;
    await expect(source.getChapterPages!(chapter)).rejects.toThrow("rocks-manga: chapter is locked");
    expect(calls).toEqual([]);
  });

  it("errors start with the manifest id", async () => {
    const source = createSource(createTestHost({ responses: { "/manga/x": "<html></html>" } }));
    await expect(source.getNovel(`${SITE}/manga/x`)).rejects.toThrow(/^rocks-manga: /);
    await expect(source.getNovel(`${SITE}/nowhere`)).rejects.toThrow(/^rocks-manga: /);
    await expect(
      source.getChapterPages!({ id: 1, title: "", url: `${SITE}/manga/x/chapter/1`, lines: [] }),
    ).rejects.toThrow(/^rocks-manga: /);
  });
});
