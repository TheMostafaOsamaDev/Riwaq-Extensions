// Fixtures in tests/fixtures were captured live from https://mangatime.org on
// 2026-11-05 (plain GET, browser UA; every call is a tRPC batch of one):
//   search.json    search.searchSeries {page:1,limit:24,sortBy:"recent",sortOrder:"desc"}
//   series.json    content.getSeriesBySlug {slug:"the-forgotten-field"}
//   chapters.json  content.getChapters {seriesId:"6ac595d124b56c8183e0969a",limit:-1} (36 chapters, none premium)
//   pages.json     content.getChapterPages {seriesSlug:"the-forgotten-field",chapterNumber:1} (153 pages)
// No premium chapter and no decimal number exists on the live site today, so
// those cases patch a copy of the chapters fixture / use an inline chapter.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createTestHost } from "@riwaq/extension-api/testing";
import type { SourceChapter } from "@riwaq/extension-api";
import createSource from "../src/index";

// fileURLToPath rather than `new URL(rel, import.meta.url)`: see the note in
// extensions/cenele/tests/cenele.test.ts (happy-dom patches global URL).
const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");
const read = (name: string) => readFileSync(join(FIXTURES_DIR, name), "utf8");
const data = (name: string) => JSON.parse(read(name))[0].result.data.json;

const search = data("search.json");
const series = data("series.json");
const chapters = data("chapters.json");
const pagesData = data("pages.json");

const SITE = "https://mangatime.org";
const SERIES_URL = `${SITE}/manga/the-forgotten-field`;

const responses = {
  "search.searchSeries": read("search.json"),
  "content.getSeriesBySlug": read("series.json"),
  "content.getChapters": read("chapters.json"),
  "content.getChapterPages": read("pages.json"),
};

const trpc = (proc: string, args: unknown) =>
  `${SITE}/api/trpc/${proc}?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: { json: args } }))}`;

describe("manga-time", () => {
  it("the trpc input is encoded as the site expects", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    await createSource(createTestHost({ responses, calls })).search("بلو", 2);
    expect(calls.map((c) => c.url)).toEqual([
      `${SITE}/api/trpc/search.searchSeries?batch=1&input=` +
        "%7B%220%22%3A%7B%22json%22%3A%7B%22page%22%3A2%2C%22limit%22%3A24%2C%22sortBy%22%3A%22popularity%22" +
        "%2C%22sortOrder%22%3A%22desc%22%2C%22query%22%3A%22%D8%A8%D9%84%D9%88%22%7D%7D%7D",
    ]);
    expect(calls[0].method).toBe("GET");
  });

  it("home sections are latest then popular, as manga cards", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const sections = await createSource(createTestHost({ responses, calls })).getHomeSections();
    expect(sections.map((s) => s.id)).toEqual(["latest", "popular"]);
    expect(calls.map((c) => c.url).sort()).toEqual(
      [
        trpc("search.searchSeries", { page: 1, limit: 24, sortBy: "recent", sortOrder: "desc" }),
        trpc("search.searchSeries", { page: 1, limit: 24, sortBy: "popularity", sortOrder: "desc" }),
      ].sort(),
    );
    const first = search.results[0];
    expect(sections[0].cards).toHaveLength(search.results.length);
    expect(sections[0].cards[0]).toEqual({
      url: `${SITE}/${first.type}/${first.slug}`,
      title: first.title,
      coverUrl: `${SITE}${first.coverUrl}`,
      contentType: "manga",
    });
  });

  it("search reports hasMore from the response and rejects an empty query", async () => {
    const source = createSource(createTestHost({ responses }));
    const res = await source.search("x", 1);
    expect(res.hasMore).toBe(search.hasMore);
    expect(res.page).toBe(1);
    expect(res.cards).toHaveLength(search.results.length);
    const empty = await source.search("  ", 1);
    expect(empty).toEqual({ cards: [], hasMore: false, query: "", page: 1 });
  });

  it("getNovel returns the series with its chapters oldest first", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const novel = await createSource(createTestHost({ responses, calls })).getNovel(SERIES_URL);
    expect(calls.map((c) => c.url).sort()).toEqual(
      [
        trpc("content.getSeriesBySlug", { slug: "the-forgotten-field" }),
        trpc("content.getChapters", { seriesId: series.id, limit: -1 }),
      ].sort(),
    );
    expect(novel.title).toBe(series.title);
    expect(novel.language).toBe("ar");
    expect(novel.direction).toBe("rtl");
    expect(novel.contentType).toBe("manga");
    expect(novel.coverUrl).toBe(`${SITE}${series.coverUrl}`);
    expect(novel.tags).toEqual(series.genres.map((g: { name: string }) => g.name));
    expect(novel.status).toBe(series.status);
    const list = novel.volumes[0].chapters;
    expect(list).toHaveLength(chapters.chapters.length);
    const numbers = list.map((c) => c.number as number);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(new Set(list.map((c) => c.id)).size).toBe(list.length);
    for (const c of list) {
      expect(c.url).toBe(`${SERIES_URL}/chapter/${c.number}`);
      expect(c.lock).toBeUndefined();
    }
  });

  it("pages carry their dimensions", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const chapter: SourceChapter = {
      id: 1,
      title: "1",
      url: `${SERIES_URL}/chapter/1`,
      number: 1,
      lines: [],
    };
    const source = createSource(createTestHost({ responses, calls }));
    const res = await source.getChapterPages!(chapter);
    expect(calls.map((c) => c.url)).toEqual([
      trpc("content.getChapterPages", { seriesSlug: "the-forgotten-field", chapterNumber: 1 }),
    ]);
    expect(res.pages).toHaveLength(pagesData.pages.length);
    expect(res.pages.length).toBeGreaterThan(1);
    res.pages.forEach((p, i) => {
      expect(p.url).toBe(pagesData.pages[i]);
      expect(p.width).toBe(pagesData.pageDimensions[i].w);
      expect(p.height).toBe(pagesData.pageDimensions[i].h);
    });
    const lines = await source.getChapterContent(chapter);
    expect(lines).toEqual(pagesData.pages.map((u: string) => ({ type: "image", content: u })));
  });

  it("premium chapters are locked", async () => {
    const patched = JSON.parse(read("chapters.json"));
    const target = patched[0].result.data.json.chapters[3];
    target.isPremium = true;
    target.isUnlocked = false;
    const unlockedPremium = patched[0].result.data.json.chapters[4];
    unlockedPremium.isPremium = true;
    unlockedPremium.isUnlocked = true;
    const calls: Array<{ url: string; method: string }> = [];
    const source = createSource(
      createTestHost({ responses: { ...responses, "content.getChapters": JSON.stringify(patched) }, calls }),
    );
    const list = (await source.getNovel(SERIES_URL)).volumes[0].chapters;
    const locked = list.filter((c) => c.lock);
    expect(locked).toHaveLength(1);
    expect(locked[0].number).toBe(target.number);
    expect(locked[0].lock).toEqual({ reason: "premium", openUrl: locked[0].url });
    expect(list.find((c) => c.number === unlockedPremium.number)?.lock).toBeUndefined();
    calls.length = 0;
    await expect(source.getChapterPages!(locked[0])).rejects.toThrow("manga-time: chapter is locked");
    await expect(source.getChapterContent(locked[0])).rejects.toThrow("manga-time: chapter is locked");
    expect(calls).toEqual([]);
  });

  it("a decimal chapter refuses with the message above", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const source = createSource(createTestHost({ responses, calls }));
    const chapter: SourceChapter = {
      id: 2,
      title: "10.5",
      url: `${SERIES_URL}/chapter/10.5`,
      number: 10.5,
      lines: [],
    };
    await expect(source.getChapterPages!(chapter)).rejects.toThrow(
      "manga-time: decimal chapter numbers aren't supported by the site's reader",
    );
    expect(calls).toEqual([]);
  });

  it("canHandle matches the site's hosts only", () => {
    const source = createSource(createTestHost());
    expect(source.canHandle(SERIES_URL)).toBe(true);
    expect(source.canHandle("https://www.mangatime.org/manhwa/x")).toBe(true);
    expect(source.canHandle("https://example.com/manga/x")).toBe(false);
    expect(source.canHandle("not a url")).toBe(false);
  });

  it("errors start with the manifest id", async () => {
    const bad = createSource(createTestHost({ responses: { "/api/trpc/": "<html>oops</html>" } }));
    await expect(bad.search("x", 1)).rejects.toThrow(/^manga-time: /);
    const trpcError = JSON.stringify([{ error: { json: { message: "nope", code: -32600 } } }]);
    const err = createSource(createTestHost({ responses: { "/api/trpc/": trpcError } }));
    await expect(err.search("x", 1)).rejects.toThrow("manga-time: nope");
    await expect(createSource(createTestHost()).getNovel("https://mangatime.org/")).rejects.toThrow(
      /^manga-time: /,
    );
  });
});
