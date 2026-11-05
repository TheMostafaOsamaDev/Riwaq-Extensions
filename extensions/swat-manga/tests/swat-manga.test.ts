// Fixtures in tests/fixtures were captured live from https://meshmanga.com on
// 2026-11-05 with a browser UA and `Accept-Language: ar,en;q=0.8`:
//   releases.json     GET /v2/api/v2/series/releases/?page=1
//   series-list.json  GET /v2/api/v2/series/?order_by=-followers_count&page=1
//   series.json       GET /v2/api/v2/series/1528804/
//   chapters.json     GET /v2/api/v2/chapters/?serie=1528804&order_by=-order&page_size=200
//   chapter.json      GET /v2/api/v2/chapters/1767111/
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
const json = (name: string) => JSON.parse(read(name)) as any;

const SITE = "https://meshmanga.com";
const API = `${SITE}/v2/api/v2`;
const SERIES = `${SITE}/series/1528804`;

const releases = json("releases.json");
const seriesList = json("series-list.json");
const series = json("series.json");
const chapters = json("chapters.json");
const chapterDoc = json("chapter.json");

const responses = {
  [`${API}/series/releases/`]: read("releases.json"),
  [`${API}/series/?order_by=-followers_count`]: read("series-list.json"),
  [`${API}/series/1528804/`]: read("series.json"),
  [`${API}/chapters/?serie=1528804`]: read("chapters.json"),
  [`${API}/chapters/1767111/`]: read("chapter.json"),
};

describe("swat-manga", () => {
  it("canHandle accepts meshmanga.com and www only", () => {
    const source = createSource(createTestHost());
    expect(source.canHandle(SERIES)).toBe(true);
    expect(source.canHandle("https://www.meshmanga.com/series/1")).toBe(true);
    expect(source.canHandle("https://appswat.com/series/1")).toBe(false);
  });

  it("home sections: latest (serie_id) then popular (id), manga cards", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const sections = await createSource(createTestHost({ responses, calls })).getHomeSections();
    expect(sections.map((s) => s.id)).toEqual(["latest", "popular"]);
    expect(calls.map((c) => c.url).sort()).toEqual(
      [`${API}/series/releases/?page=1`, `${API}/series/?order_by=-followers_count&page=1`].sort(),
    );
    expect(sections[0].cards).toHaveLength(releases.results.length);
    expect(sections[1].cards).toHaveLength(seriesList.results.length);
    expect(sections[0].cards[0].url).toBe(`${SERIES.replace("1528804", String(releases.results[0].serie_id))}`);
    expect(sections[1].cards[0].url).toBe(`${SITE}/series/${seriesList.results[0].id}`);
    expect(sections[1].cards[0].title).toBe(seriesList.results[0].title);
    expect(sections[1].cards[0].coverUrl).toBe(seriesList.results[0].poster.medium);
    for (const c of [...sections[0].cards, ...sections[1].cards]) {
      expect(c.contentType).toBe("manga");
      expect(c.url).toMatch(/^https:\/\/meshmanga\.com\/series\/\d+$/);
    }
  });

  it("search builds the API URL and hasMore follows next", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const body = { count: 1, next: null, previous: null, results: seriesList.results.slice(0, 1) };
    const source = createSource(createTestHost({ responses: { "/series/?search=": JSON.stringify(body) }, calls }));
    const r = await source.search("باكي x", 2);
    expect(calls[0].url).toBe(`${API}/series/?search=${encodeURIComponent("باكي x")}&page=2`);
    expect(r).toMatchObject({ page: 2, query: "باكي x", hasMore: false });
    expect(r.cards).toHaveLength(1);
    const more = await createSource(
      createTestHost({ responses: { "/series/?search=": JSON.stringify({ ...body, next: `${API}/series/?page=3` }) } }),
    ).search("x");
    expect(more.hasMore).toBe(true);
    expect(more.page).toBe(1);
    const empty = await createSource(createTestHost({ calls: [] })).search("  ", 1);
    expect(empty.cards).toEqual([]);
  });

  it("getNovel maps the series and lists chapters oldest first", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const novel = await createSource(createTestHost({ responses, calls })).getNovel(SERIES);
    expect(calls.map((c) => c.url)).toEqual([
      `${API}/series/1528804/`,
      `${API}/chapters/?serie=1528804&order_by=-order&page_size=200`,
    ]);
    expect(novel.title).toBe(series.title);
    expect(novel.contentType).toBe("manga");
    expect(novel.direction).toBe("rtl");
    expect(novel.language).toBe("ar");
    expect(novel.coverUrl).toBe(series.poster.medium);
    expect(novel.status).toBe(series.status.name);
    expect(novel.tags).toEqual(series.genres.map((g: any) => g.name));
    expect(novel.description).toBe(series.story.trim());
    const list = novel.volumes[0].chapters;
    expect(list).toHaveLength(chapters.results.length);
    const numbers = list.map((c) => c.number!);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    const newest = list[list.length - 1];
    expect(newest.id).toBe(chapters.results[0].id);
    expect(newest.url).toBe(`${SITE}/chapter/${chapters.results[0].id}`);
    expect(newest.title).toBe(chapters.results[0].chapter);
    expect(newest.lock).toBeUndefined();
  });

  it("free-text chapter fields become numbers", async () => {
    const results = [
      { id: 3, chapter: "04 FREE" },
      { id: 2, chapter: "190" },
      { id: 1, chapter: "14 FRE" },
      { id: 4, chapter: "7.5" },
    ];
    const host = createTestHost({
      responses: {
        "/series/9/": JSON.stringify({ id: 9, title: "T", poster: { medium: "p" }, genres: [] }),
        "/chapters/?serie=9": JSON.stringify({ count: 4, next: null, results }),
      },
    });
    const novel = await createSource(host).getNovel(`${SITE}/series/9`);
    const byId = new Map(novel.volumes[0].chapters.map((c) => [c.id, c]));
    expect(byId.get(3)!.number).toBe(4);
    expect(byId.get(2)!.number).toBe(190);
    expect(byId.get(1)!.number).toBe(14);
    expect(byId.get(4)!.number).toBe(7.5);
    expect(byId.get(3)!.title).toBe("04 FREE");
    expect(novel.volumes[0].chapters.map((c) => c.number)).toEqual([4, 7.5, 14, 190]);
  });

  it("chapter lists follow next", async () => {
    const half = Math.floor(chapters.results.length / 2);
    const next = `${API}/chapters/?serie=1528804&order_by=-order&page_size=200&page=2`;
    const page1 = { ...chapters, next, results: chapters.results.slice(0, half) };
    const page2 = { ...chapters, next: null, results: chapters.results.slice(half) };
    const calls: Array<{ url: string; method: string }> = [];
    const host = createTestHost({
      calls,
      responses: {
        [`${API}/series/1528804/`]: read("series.json"),
        [next]: JSON.stringify(page2),
        [`${API}/chapters/?serie=1528804&order_by=-order&page_size=200`]: JSON.stringify(page1),
      },
    });
    const novel = await createSource(host).getNovel(SERIES);
    const chapterCalls = calls.filter((c) => c.url.includes("/chapters/"));
    expect(chapterCalls.map((c) => c.url)).toEqual([
      `${API}/chapters/?serie=1528804&order_by=-order&page_size=200`,
      next,
    ]);
    expect(novel.volumes[0].chapters).toHaveLength(chapters.results.length);
  });

  it("getNovel rejects a URL that is not a series page", async () => {
    await expect(createSource(createTestHost()).getNovel(`${SITE}/chapter/5`)).rejects.toThrow(/^swat-manga: /);
  });

  it("a locked chapter keeps its lock and getChapterPages throws before any request", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const source = createSource(createTestHost({ calls }));
    const chapter = {
      id: 5,
      title: "5",
      url: `${SITE}/chapter/5`,
      lines: [],
      lock: { reason: "locked", openUrl: `${SITE}/chapter/5` },
    };
    await expect(source.getChapterPages!(chapter)).rejects.toThrow("swat-manga: chapter is locked");
    await expect(source.getChapterContent(chapter)).rejects.toThrow("swat-manga: chapter is locked");
    expect(calls).toEqual([]);
  });

  it("pages sorted by order", async () => {
    const shuffled = { ...chapterDoc, images: [...chapterDoc.images].reverse() };
    const calls: Array<{ url: string; method: string }> = [];
    const source = createSource(
      createTestHost({ calls, responses: { [`${API}/chapters/1767111/`]: JSON.stringify(shuffled) } }),
    );
    const chapter = { id: 1767111, title: "190", url: `${SITE}/chapter/1767111`, lines: [] };
    const { pages } = await source.getChapterPages!(chapter);
    expect(calls.map((c) => c.url)).toEqual([`${API}/chapters/1767111/`]);
    const expected = [...chapterDoc.images].sort((a: any, b: any) => a.order - b.order).map((i: any) => i.image);
    expect(pages.map((p) => p.url)).toEqual(expected);
    expect(pages.length).toBe(chapterDoc.images.length);
    const lines = await source.getChapterContent(chapter);
    expect(lines.map((l) => l.content)).toEqual(expected);
  });

  it("a chapter with no images is an error", async () => {
    const source = createSource(
      createTestHost({ responses: { "/chapters/7/": JSON.stringify({ id: 7, images: [] }) } }),
    );
    await expect(
      source.getChapterPages!({ id: 7, title: "7", url: `${SITE}/chapter/7`, lines: [] }),
    ).rejects.toThrow(/^swat-manga: /);
  });

  it("an HTTP error surfaces with the manifest id", async () => {
    const source = createSource(createTestHost({ responses: { "/series/releases/": "{}" }, status: { "/series/releases/": 404 } }));
    await expect(source.getHomeSections()).rejects.toThrow(/^swat-manga: /);
  });
});
