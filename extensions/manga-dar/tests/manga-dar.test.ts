// Fixtures in tests/fixtures were captured live from https://mangadar.com on
// 2026-11-06 with a browser UA and `Accept-Language: ar,en;q=0.8`:
//   list.html    GET /manga/                 (popular page 1; /manga/page/1/ 301s here)
//   search.json  GET /wp-admin/admin-ajax.php?action=mangaverse_search&q=berserk
//   series.html  GET /manga/berserk/         (390 chapters in the mdg-manga-chapters-json script)
//   chapter.html GET /manga/berserk/390/     (22 pages; each img's data-mds is base64 of a signed URL)
// The cards sit inside Alpine `<template x-if>` blocks (grid and list views).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createTestHost } from "@riwaq/extension-api/testing";
import { chapterIdFromUrl } from "@riwaq/manga-themes";
import createSource from "../src/index";

// fileURLToPath rather than `new URL(rel, import.meta.url)`: see the note in
// extensions/cenele/tests/cenele.test.ts (happy-dom patches global URL).
const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");
const read = (name: string) => readFileSync(join(FIXTURES_DIR, name), "utf8");

const SITE = "https://mangadar.com";
const SERIES = `${SITE}/manga/berserk/`;
const CHAPTER = `${SERIES}390/`;

const list = read("list.html");
const series = read("series.html");
const chapterHtml = read("chapter.html");
const searchJson = read("search.json");

const responses = {
  [`${SITE}/manga/?sort=new`]: list,
  [`${SITE}/manga/`]: list,
  "admin-ajax.php": searchJson,
  [CHAPTER]: chapterHtml,
  [SERIES]: series,
};

type Row = [number, string, string, number, number];
const seriesRows = (): Row[] =>
  (JSON.parse(/<script[^>]*id="mdg-manga-chapters-json"[^>]*>(.*?)<\/script>/s.exec(series)![1]) as { rows: Row[] }).rows;

const mdsPaths = () =>
  [...chapterHtml.matchAll(/data-mds="([^"]+)"/g)].map((m) => new URL(Buffer.from(m[1], "base64").toString("utf8")));

describe("manga-dar", () => {
  it("canHandle accepts mangadar.com and www.mangadar.com only", () => {
    const source = createSource(createTestHost());
    expect(source.canHandle(SERIES)).toBe(true);
    expect(source.canHandle("https://www.mangadar.com/manga/x/")).toBe(true);
    expect(source.canHandle("https://example.com/manga/x/")).toBe(false);
  });

  it("home sections: latest then popular, one card per grid tile", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const sections = await createSource(createTestHost({ responses, calls })).getHomeSections();
    expect(sections.map((s) => s.id)).toEqual(["latest", "popular"]);
    expect(calls.map((c) => c.url).sort()).toEqual([`${SITE}/manga/`, `${SITE}/manga/?sort=new`].sort());

    const tiles = [...list.matchAll(/<a href="([^"]+)" class="group block">/g)].map((m) => m[1]);
    expect(tiles.length).toBeGreaterThan(0);
    for (const s of sections) {
      expect(s.cards.map((c) => c.url)).toEqual(tiles);
      for (const c of s.cards) {
        expect(c.title).not.toBe("");
        expect(c.coverUrl).toMatch(/^https:\/\/mangadar\.com\/wp-content\/uploads\//);
        expect(c.contentType).toBe("manga");
      }
    }
    expect(sections[1].cards[0].title).toBe(
      "Fifty Ways of Escaping My Engagement to a Psychopathic Mastermind",
    );
  });

  it("search parses the ajax JSON", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const source = createSource(createTestHost({ responses, calls }));
    const res = await source.search("berserk", 1);
    expect(calls.map((c) => c.url)).toEqual([
      `${SITE}/wp-admin/admin-ajax.php?action=mangaverse_search&q=berserk`,
    ]);
    const data = (JSON.parse(searchJson) as { data: Array<{ title: string; url: string; cover: string }> }).data;
    expect(data.length).toBeGreaterThan(1);
    expect(res.cards.map((c) => c.url)).toEqual(data.map((d) => d.url));
    expect(res.cards.map((c) => c.title)).toEqual(data.map((d) => d.title));
    expect(res.cards.map((c) => c.coverUrl)).toEqual(data.map((d) => d.cover));
    expect(res.cards.every((c) => c.contentType === "manga")).toBe(true);
    expect(res.hasMore).toBe(false);
    expect(res.query).toBe("berserk");
    // One page: page 2 and an empty query ask nothing.
    expect((await source.search("berserk", 2)).cards).toEqual([]);
    expect((await source.search("  ", 1)).cards).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("a search answer that is not JSON is a manga-dar error", async () => {
    const source = createSource(createTestHost({ responses: { "admin-ajax.php": "<html>nope</html>" } }));
    await expect(source.search("x", 1)).rejects.toThrow("manga-dar: ");
  });

  it("chapters come from the JSON script with decimal numbers", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const novel = await createSource(createTestHost({ responses, calls })).getNovel(SERIES);
    expect(calls.map((c) => c.url)).toEqual([SERIES]);
    const rows = seriesRows();
    expect(rows.length).toBeGreaterThan(100);
    const chapters = novel.volumes[0].chapters;
    expect(novel.volumes).toHaveLength(1);
    expect(chapters).toHaveLength(rows.length);
    // The script is newest first; chapters are returned oldest first.
    expect(chapters.map((c) => c.id)).toEqual([...rows].reverse().map((r) => r[0]));
    expect(chapters.map((c) => c.url)).toEqual([...rows].reverse().map((r) => r[2]));
    expect(chapters.map((c) => c.number)).toEqual([...rows].reverse().map((r) => Number(r[1])));
    expect(rows.some((r) => r[1].includes("."))).toBe(true);
    expect(chapters.find((c) => c.url === `${SERIES}387.1/`)?.number).toBe(387.1);
    expect(new Set(chapters.map((c) => c.id)).size).toBe(chapters.length);
    expect(chapters.at(-1)).toMatchObject({ url: CHAPTER, number: 390 });
    expect(chapters.some((c) => c.lock)).toBe(false);
  });

  it("chapter ids fall back to the url hash and no row with a url is dropped", async () => {
    const u = (n: number) => `${SITE}/manga/x/${n}/`;
    const rows = [
      [2 ** 31, "3", u(3), 0, 3],
      [1.5, "2", u(2), 0, 2],
      [null, "", u(9), 0, 9],
      [42, "1", u(1), 0, 1],
    ];
    const html = `<h1>X</h1><script type="application/json" id="mdg-manga-chapters-json">${JSON.stringify({ rows })}</script>`;
    const mk = (locale: "en" | "ar") =>
      createSource(createTestHost({ locale, responses: { [`${SITE}/manga/x/`]: html } }));
    const en = (await mk("en").getNovel(`${SITE}/manga/x/`)).volumes[0].chapters;
    expect(en).toHaveLength(4);
    const byUrl = (url: string) => en.find((c) => c.url === url)!;
    expect(byUrl(u(3)).id).toBe(chapterIdFromUrl(u(3)));
    expect(byUrl(u(2)).id).toBe(chapterIdFromUrl(u(2)));
    expect(byUrl(u(9)).id).toBe(chapterIdFromUrl(u(9)));
    expect(byUrl(u(1)).id).toBe(42);
    // Titles are localised and never a URL.
    expect(byUrl(u(3)).title).toBe("Chapter 3");
    expect(byUrl(u(9)).title).toBe("Chapter 9");
    expect(en.every((c) => !c.title.includes("http"))).toBe(true);
    const ar = (await mk("ar").getNovel(`${SITE}/manga/x/`)).volumes[0].chapters;
    expect(ar.find((c) => c.url === u(3))!.title).toBe("الفصل 3");
  });

  it("series details", async () => {
    const novel = await createSource(createTestHost({ responses })).getNovel(SERIES);
    expect(novel.title).toBe("Berserk");
    expect(novel.author).toBe("Miura, Kentarou");
    expect(novel.language).toBe("ar");
    expect(novel.direction).toBe("rtl");
    expect(novel.contentType).toBe("manga");
    expect(novel.coverUrl).toBe(`${SITE}/wp-content/uploads/2026/04/cover-1.webp`);
    expect(novel.status).toBe("مستمر");
    expect(novel.tags).toEqual(expect.arrayContaining(["أكشن", "رعب"]));
    expect(novel.tags).toHaveLength([...new Set(series.match(/href="https:\/\/mangadar\.com\/genre\/[^"]+"/g))].length);
    expect(novel.description).toMatch(/^تغوص هذه السردية/);
    expect(novel.description).not.toMatch(/<|&\w+;|&#\d+;/);
  });

  it("a series page without the chapters script is a manga-dar error", async () => {
    const source = createSource(createTestHost({ responses: { "/manga/x/": "<html><body><h1>x</h1></body></html>" } }));
    await expect(source.getNovel(`${SITE}/manga/x/`)).rejects.toThrow("manga-dar: ");
    const broken = `<h1>x</h1><script type="application/json" id="mdg-manga-chapters-json">{oops</script>`;
    await expect(
      createSource(createTestHost({ responses: { "/manga/x/": broken } })).getNovel(`${SITE}/manga/x/`),
    ).rejects.toThrow("manga-dar: ");
  });

  it("page URLs decode from data-mds and expire", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const source = createSource(createTestHost({ responses, calls }));
    const { pages, expiresAt } = await source.getChapterPages!({ id: 167179, title: "390", url: CHAPTER, lines: [] });
    expect(calls.map((c) => c.url)).toEqual([CHAPTER]);
    const decoded = mdsPaths();
    expect(decoded.length).toBeGreaterThan(1);
    expect(pages).toHaveLength(decoded.length);
    // `exp` is unix seconds; expiresAt is the earliest, in milliseconds.
    const exps = decoded.map((u) => Number(u.searchParams.get("exp")));
    expect(expiresAt).toBe(Math.min(...exps) * 1000);
    pages.forEach((p, i) => {
      expect(p.url).toBe(`${SITE}${decoded[i].pathname}${decoded[i].search}`);
      expect(p.url).toContain("sig=");
      expect(p.cacheKey).toBe(`${SITE}/mdrs/${decoded[i].searchParams.get("c")}/${decoded[i].searchParams.get("i")}`);
      expect(p.cacheKey).not.toMatch(/sig|pnonce/);
    });
    expect(pages[0].cacheKey).toBe(`${SITE}/mdrs/167179/0`);
    const lines = await source.getChapterContent({ id: 167179, title: "390", url: CHAPTER, lines: [] });
    expect(lines).toEqual(pages.map((p) => ({ type: "image", content: p.url })));
  });

  it("a data-mds that is a bare path works too", async () => {
    const path = "/?mdrs=1&c=5&i=2&exp=2000&pnonce=n&sig=s";
    const html = `<div class="reader-page"><img data-mds="${Buffer.from(path).toString("base64")}"></div>`;
    const source = createSource(createTestHost({ responses: { "/manga/x/1/": html } }));
    const res = await source.getChapterPages!({ id: 1, title: "1", url: `${SITE}/manga/x/1/`, lines: [] });
    expect(res.pages).toEqual([{ url: `${SITE}${path}`, cacheKey: `${SITE}/mdrs/5/2` }]);
    expect(res.expiresAt).toBe(2_000_000);
  });

  it("a chapter without readable pages is a manga-dar error; a locked one asks nothing", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const url = `${SITE}/manga/x/3/`;
    const chapter = { id: 1, title: "3", url, lines: [] };
    const none = createSource(createTestHost({ responses: { "/manga/x/3/": "<html></html>" }, calls }));
    await expect(none.getChapterPages!(chapter)).rejects.toThrow("manga-dar: ");
    const bad = `<div class="reader-page"><img data-mds="***not base64***"></div>`;
    await expect(
      createSource(createTestHost({ responses: { "/manga/x/3/": bad } })).getChapterPages!(chapter),
    ).rejects.toThrow("manga-dar: ");
    const noExp = `<div class="reader-page"><img data-mds="${Buffer.from("/?mdrs=1&c=1&i=0").toString("base64")}"></div>`;
    await expect(
      createSource(createTestHost({ responses: { "/manga/x/3/": noExp } })).getChapterPages!(chapter),
    ).rejects.toThrow("manga-dar: ");
    calls.length = 0;
    const locked = { ...chapter, lock: { reason: "paid", openUrl: url } };
    await expect(none.getChapterPages!(locked)).rejects.toThrow("manga-dar: chapter is locked");
    expect(calls).toEqual([]);
  });

  it("a Cloudflare challenge is reported as such", async () => {
    const source = createSource(
      createTestHost({
        responses: { [SITE]: "<html>Just a moment</html>" },
        status: { "mangadar.com": 403 },
        headers: { "mangadar.com": { "cf-mitigated": "challenge" } },
      }),
    );
    await expect(source.search("one", 1)).rejects.toThrow("manga-dar: blocked by a Cloudflare check");
  });
});
