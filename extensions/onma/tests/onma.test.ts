// Fixtures in tests/fixtures were captured live from https://onma.me on
// 2026-11-05 with a browser UA and `Accept-Language: ar,en;q=0.8`:
//   home.html    GET /
//   list.html    GET /filterList?page=1&sortBy=views&asc=false (an HTML fragment)
//   series.html  GET /manga/one-piece-   (969 chapters inline)
//   chapter.html GET /manga/one-piece-/1198 (13 pages)
//   search.json  GET /search?query=one   (autocomplete JSON: { suggestions: [{ value, data }] })
// The series slug really ends in a hyphen. `sortBy=name` is accepted too and an
// unknown sortBy answers HTTP 500.
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

const SITE = "https://onma.me";
const SERIES = `${SITE}/manga/one-piece-`;
const CHAPTER = `${SERIES}/1198`;

const home = read("home.html");
const series = read("series.html");
const chapterHtml = read("chapter.html");
const search = JSON.parse(read("search.json")) as { suggestions: Array<{ value: string; data: string }> };

const responses = {
  "/filterList": read("list.html"),
  "/search?": read("search.json"),
  "/manga/one-piece-/1198": chapterHtml,
  "/manga/one-piece-": series,
  [`${SITE}/`]: home,
};

/** Distinct `/manga/one-piece-/<n>` hrefs inside the series page's chapter list. */
const seriesChapterUrls = () => {
  const list = series.slice(series.indexOf('<ul class="chapters">'));
  return [...new Set([...list.matchAll(/href="(https:\/\/onma\.me\/manga\/one-piece-\/[^"]+)"/g)].map((m) => m[1]))];
};

describe("onma", () => {
  it("canHandle accepts onma.me and www.onma.me only", () => {
    const source = createSource(createTestHost());
    expect(source.canHandle(SERIES)).toBe(true);
    expect(source.canHandle("https://www.onma.me/manga/x")).toBe(true);
    expect(source.canHandle("https://onma.top/manga/x")).toBe(false);
  });

  it("home sections: latest (one card per series) then popular", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const sections = await createSource(createTestHost({ responses, calls })).getHomeSections();
    expect(sections.map((s) => s.id)).toEqual(["latest", "popular"]);
    expect(calls.map((c) => c.url).sort()).toEqual(
      [`${SITE}/`, `${SITE}/filterList?page=1&sortBy=views&asc=false`].sort(),
    );

    const latestBlock = home.slice(home.indexOf('class="latest-managa"'), home.indexOf('<h2 class="listmanga-header">', home.indexOf("</h2>", home.indexOf("latest-managa"))));
    const hrefs = [...latestBlock.matchAll(/<h3 class="manga-heading[^>]*>\s*<i[^>]*><\/i>\s*<a href="([^"]+)"/g)].map((m) => m[1]);
    const distinct = [...new Set(hrefs)];
    expect(hrefs.length).toBeGreaterThan(distinct.length);
    expect(sections[0].cards.map((c) => c.url)).toEqual(distinct);
    for (const c of sections[0].cards) {
      expect(c.title).not.toBe("");
      expect(c.coverUrl).toMatch(/^https:\/\/onma\.me\/uploads\/manga\/.+\/cover\//);
      expect(c.contentType).toBe("manga");
    }
    expect(sections[0].cards[0]).toMatchObject({ url: SERIES, title: "One Piece" });

    const list = read("list.html");
    const expected = [...list.matchAll(/class="chart-title"/g)].length;
    expect(expected).toBeGreaterThan(0);
    expect(sections[1].cards).toHaveLength(expected);
    expect(sections[1].cards[0]).toMatchObject({ url: SERIES, title: "One Piece", contentType: "manga" });
    expect(sections[1].cards[0].coverUrl).toBe(`https://www.onma.me/uploads/manga/one-piece-/cover/cover_250x350.jpg`);
  });

  it("search reads the suggestion list", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const source = createSource(createTestHost({ responses, calls }));
    const res = await source.search("one", 1);
    expect(calls[0].url).toBe(`${SITE}/search?query=one`);
    expect(res.cards).toHaveLength(search.suggestions.length);
    expect(res.cards[0]).toEqual({
      url: SERIES,
      title: "One Piece",
      coverUrl: `${SITE}/uploads/manga/one-piece-/cover/cover_250x350.jpg`,
      contentType: "manga",
    });
    expect(res.hasMore).toBe(false);
    expect(res.query).toBe("one");
    // The endpoint has one page; page 2 asks nothing.
    const again = await source.search("one", 2);
    expect(again.cards).toEqual([]);
    expect(calls).toHaveLength(1);
    const empty = await source.search("  ", 1);
    expect(empty.cards).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("every chapter is listed", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const novel = await createSource(createTestHost({ responses, calls })).getNovel(SERIES);
    expect(calls.map((c) => c.url)).toEqual([SERIES]);
    const urls = seriesChapterUrls();
    expect(urls.length).toBeGreaterThan(900);
    expect(novel.volumes).toHaveLength(1);
    const chapters = novel.volumes[0].chapters;
    expect(chapters).toHaveLength(urls.length);
    expect(new Set(chapters.map((c) => c.id)).size).toBe(chapters.length);
    // Oldest first, numbers from the URL (decimals included).
    const numbers = chapters.map((c) => c.number as number);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(numbers[0]).toBe(0);
    expect(numbers.at(-1)).toBe(Math.max(...urls.map((u) => Number(u.split("/").pop()))));
    expect(numbers).toContain(1000.5);
    expect(chapters.at(-1)).toMatchObject({ url: CHAPTER, title: "1198 : جزيرة الوحوش" });
    expect(chapters.some((c) => c.lock)).toBe(false);
  });

  it("series details", async () => {
    const novel = await createSource(createTestHost({ responses })).getNovel(SERIES);
    expect(novel.title).toBe("One Piece");
    expect(novel.author).toBe("Oda Eiichiro");
    expect(novel.language).toBe("ar");
    expect(novel.direction).toBe("rtl");
    expect(novel.contentType).toBe("manga");
    expect(novel.coverUrl).toBe("https://www.onma.me/uploads/manga/one-piece-/cover/cover_250x350.jpg");
    expect(novel.status).toBe("مستمرة");
    expect(novel.tags).toContain("أكشن");
    expect(novel.tags).toContain("خارق للطبيعة");
    expect(novel.description).toMatch(/^القوة والشهرة والثروة/);
    expect(novel.description).not.toMatch(/<|&\w+;/);
    expect(novel.description).toContain('"ون بيس"');
  });

  it("a non-series URL is an onma error", async () => {
    const source = createSource(createTestHost({ responses }));
    await expect(source.getNovel(`${SITE}/`)).rejects.toThrow("onma: ");
    await expect(
      createSource(createTestHost({ responses: { "/manga/x": "<html><body>nothing</body></html>" } })).getNovel(`${SITE}/manga/x`),
    ).rejects.toThrow("onma: ");
  });

  it("pages come from var pages", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const source = createSource(createTestHost({ responses, calls }));
    const { pages } = await source.getChapterPages!({ id: 1, title: "1198", url: CHAPTER, lines: [] });
    expect(calls.map((c) => c.url)).toEqual([CHAPTER]);
    const json = JSON.parse(/var pages = (\[.*?\]);/s.exec(chapterHtml)![1]) as Array<{ page_image: string }>;
    expect(json.length).toBeGreaterThan(1);
    expect(pages).toHaveLength(json.length);
    // imageBase is the first scan-page img's host (www.onma.me, not onma.me).
    expect(pages.map((p) => p.url)).toEqual(
      json.map((p) => `https://www.onma.me/uploads/manga/one-piece-/chapters/1198/${p.page_image}`),
    );
    expect(pages[0].url).toBe("https://www.onma.me/uploads/manga/one-piece-/chapters/1198/01.jpg");
    const lines = await source.getChapterContent({ id: 1, title: "1198", url: CHAPTER, lines: [] });
    expect(lines).toEqual(pages.map((p) => ({ type: "image", content: p.url })));
  });

  it("an external page keeps its own URL", async () => {
    const html =
      `<img class="img-responsive scan-page" src=' https://cdn.example.net/uploads/manga/x/chapters/3/01.jpg '>` +
      `<script>var pages = [{"page_image":"01.jpg","page_slug":1,"external":0},` +
      `{"page_image":"https://img.example.org/a/02.png","page_slug":2,"external":1}];</script>`;
    const source = createSource(createTestHost({ responses: { "/manga/x/3": html } }));
    const { pages } = await source.getChapterPages!({ id: 1, title: "3", url: `${SITE}/manga/x/3`, lines: [] });
    expect(pages.map((p) => p.url)).toEqual([
      "https://cdn.example.net/uploads/manga/x/chapters/3/01.jpg",
      "https://img.example.org/a/02.png",
    ]);
  });

  it("a chapter without var pages is an onma error; a locked one asks nothing", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const source = createSource(createTestHost({ responses: { "/manga/x/3": "<html></html>" }, calls }));
    await expect(
      source.getChapterPages!({ id: 1, title: "3", url: `${SITE}/manga/x/3`, lines: [] }),
    ).rejects.toThrow("onma: ");
    calls.length = 0;
    const locked = { id: 1, title: "3", url: `${SITE}/manga/x/3`, lines: [], lock: { reason: "paid", openUrl: `${SITE}/manga/x/3` } };
    await expect(source.getChapterPages!(locked)).rejects.toThrow("onma: chapter is locked");
    expect(calls).toEqual([]);
  });

  it("a Cloudflare challenge is reported as such", async () => {
    const source = createSource(
      createTestHost({ responses: { [SITE]: "<html>Just a moment</html>" }, status: { "onma.me": 403 }, headers: { "onma.me": { "cf-mitigated": "challenge" } } }),
    );
    await expect(source.search("one", 1)).rejects.toThrow("onma: blocked by a Cloudflare check");
  });
});
