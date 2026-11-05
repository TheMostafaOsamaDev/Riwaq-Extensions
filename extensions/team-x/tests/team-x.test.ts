// Fixtures in tests/fixtures were captured live from https://olympustaff.com on
// 2026-11-05 with a browser UA and `Accept-Language: ar,en;q=0.8`:
//   home.html             GET /                       (latest: div.last-chapter div.box)
//   series-list.html      GET /series?page=1          (div.listupd div.bsx)
//   search.html           GET /search?keyword=solo    (div.tx-grid a.tx-card)
//   series.html           GET /series/my-girlfriend-returned-as-a-dragon
//                         (one chapter page, chapter 11 is locked: href="#", buy dialog)
//   series-multi-1..3     GET /series/invincible-at-the-start[?page=2|3]
//                         (118 chapters over three pages of 40)
//   chapter.html          GET /series/invincible-at-the-start/118 (12 inline images)
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

const SITE = "https://olympustaff.com";
const LOCKED_SERIES = `${SITE}/series/my-girlfriend-returned-as-a-dragon`;
const MULTI_SERIES = `${SITE}/series/invincible-at-the-start`;
const CHAPTER = `${MULTI_SERIES}/118`;

const home = read("home.html");
const seriesList = read("series-list.html");
const search = read("search.html");
const lockedSeries = read("series.html");
const multi = [read("series-multi-1.html"), read("series-multi-2.html"), read("series-multi-3.html")];
const chapterHtml = read("chapter.html");

const dom = (html: string) => new DOMParser().parseFromString(html, "text/html");

const responses = {
  [`${SITE}/?page=1`]: home,
  [`${SITE}/series?page=1`]: seriesList,
  "/search?keyword=": search,
  [`${MULTI_SERIES}?page=2`]: multi[1],
  [`${MULTI_SERIES}?page=3`]: multi[2],
  [MULTI_SERIES]: multi[0],
  [LOCKED_SERIES]: lockedSeries,
  [CHAPTER]: chapterHtml,
};

describe("team-x", () => {
  it("canHandle accepts olympustaff.com and www.olympustaff.com only", () => {
    const source = createSource(createTestHost());
    expect(source.canHandle(LOCKED_SERIES)).toBe(true);
    expect(source.canHandle("https://www.olympustaff.com/series/x")).toBe(true);
    expect(source.canHandle("https://olympustaff.net/series/x")).toBe(false);
    expect(source.canHandle("not a url")).toBe(false);
  });

  it("home sections: latest (one card per series) then popular", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const sections = await createSource(createTestHost({ responses, calls })).getHomeSections();
    expect(sections.map((s) => s.id)).toEqual(["latest", "popular"]);
    expect(calls.map((c) => c.url).sort()).toEqual([`${SITE}/?page=1`, `${SITE}/series?page=1`].sort());

    const boxes = [...dom(home).querySelectorAll("div.last-chapter div.box")];
    const distinct = [...new Set(boxes.map((b) => b.querySelector("div.info a")!.getAttribute("href")!))];
    expect(boxes.length).toBeGreaterThan(0);
    expect(sections[0].cards.map((c) => c.url)).toEqual(distinct);
    for (const c of sections[0].cards) {
      expect(c.title).not.toBe("");
      expect(c.coverUrl).toMatch(/^https:\/\/cdn\.olympustaff\.com\/images\/manga\/(?!thumbnail_)/);
      expect(c.contentType).toBe("manga");
    }

    const bsx = [...dom(seriesList).querySelectorAll("div.listupd div.bsx")];
    expect(bsx.length).toBeGreaterThan(0);
    expect(sections[1].cards).toHaveLength(bsx.length);
    expect(sections[1].cards[0]).toMatchObject({
      url: bsx[0].querySelector("a")!.getAttribute("href"),
      title: bsx[0].querySelector("a")!.getAttribute("title"),
      contentType: "manga",
    });
    expect(sections[1].cards[0].coverUrl).toBe(bsx[0].querySelector("img")!.getAttribute("src"));
  });

  it("search reads the card grid and asks one page only", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const source = createSource(createTestHost({ responses, calls }));
    const res = await source.search("solo", 1);
    expect(calls.map((c) => c.url)).toEqual([`${SITE}/search?keyword=solo`]);
    const cards = [...dom(search).querySelectorAll("div.tx-grid a.tx-card")];
    expect(cards.length).toBeGreaterThan(0);
    expect(res.cards).toHaveLength(cards.length);
    expect(res.cards[0]).toMatchObject({ url: `${SITE}/series/SMN`, title: "Solo Max-Level Newbie", contentType: "manga" });
    expect(res.cards[0].coverUrl).toMatch(/^https:\/\/cdn\.olympustaff\.com\/images\/manga\/[^/]+$/);
    expect(res.hasMore).toBe(false);
    expect(res.query).toBe("solo");
    expect((await source.search("solo", 2)).cards).toEqual([]);
    expect((await source.search("   ", 1)).cards).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("series details", async () => {
    const novel = await createSource(createTestHost({ responses })).getNovel(MULTI_SERIES);
    expect(novel).toMatchObject({
      title: "Invincible at the start",
      language: "ar",
      direction: "rtl",
      contentType: "manga",
      status: "متوقف",
    });
    expect(novel.author).toBe("");
    expect(novel.coverUrl).toBe("https://cdn.olympustaff.com/images/manga/116431609.jpg");
    expect(novel.tags).toContain("أكشن");
    expect(novel.tags.length).toBe(dom(multi[0]).querySelectorAll("div.review-author-info a").length);
    expect(novel.description).toMatch(/^دينغ/);
    expect(novel.description).not.toMatch(/</);
  });

  it("every chapter page is followed", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const novel = await createSource(createTestHost({ responses, calls })).getNovel(MULTI_SERIES);
    expect(calls.map((c) => c.url)).toEqual([MULTI_SERIES, `${MULTI_SERIES}?page=2`, `${MULTI_SERIES}?page=3`]);

    const cards = multi.flatMap((h) => [...dom(h).querySelectorAll("div.chapter-card")]);
    expect(cards.length).toBeGreaterThan(40);
    const chapters = novel.volumes[0].chapters;
    expect(novel.volumes).toHaveLength(1);
    expect(chapters).toHaveLength(cards.length);
    expect(new Set(chapters.map((c) => c.id)).size).toBe(chapters.length);
    // Oldest first, numbers from data-number.
    const numbers = chapters.map((c) => c.number as number);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(numbers.at(-1)).toBe(Number(cards[0].getAttribute("data-number")));
    expect(numbers[0]).toBe(Number(cards.at(-1)!.getAttribute("data-number")));
    expect(chapters.at(-1)).toMatchObject({
      url: CHAPTER,
      number: 118,
      lines: [],
    });
    expect(chapters.at(-1)!.title).toMatch(/^الفصل 118/);
    for (const c of chapters) expect(c.lock).toBeUndefined();
  });

  it("locked chapters are listed with a lock and refuse pages", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const source = createSource(createTestHost({ responses, calls }));
    const novel = await source.getNovel(LOCKED_SERIES);
    expect(calls.map((c) => c.url)).toEqual([LOCKED_SERIES]);

    const cards = [...dom(lockedSeries).querySelectorAll("div.chapter-card")];
    const lockedCards = cards.filter((c) => c.querySelector("span.status-badge.locked"));
    expect(lockedCards.length).toBeGreaterThan(0);
    const chapters = novel.volumes[0].chapters;
    expect(chapters).toHaveLength(cards.length);
    const locked = chapters.filter((c) => c.lock);
    expect(locked).toHaveLength(lockedCards.length);
    const siteId = Number(lockedCards[0].querySelector("a")!.getAttribute("data-bs-whatever"));
    expect(locked[0]).toMatchObject({
      id: siteId,
      number: Number(lockedCards[0].getAttribute("data-number")),
      url: `${LOCKED_SERIES}#chapter-${Number(lockedCards[0].getAttribute("data-number"))}`,
      lock: { reason: "points", openUrl: LOCKED_SERIES },
    });
    for (const c of locked) expect(c.lock!.openUrl).toBe(LOCKED_SERIES);
    expect(new Set(chapters.map((c) => c.url)).size).toBe(chapters.length);
    // The free ones keep real chapter URLs.
    const free = chapters.filter((c) => !c.lock);
    expect(free.length).toBeGreaterThan(0);
    for (const c of free) expect(c.url).toMatch(new RegExp(`^${LOCKED_SERIES}/\\d`));
    expect(new Set(chapters.map((c) => c.id)).size).toBe(chapters.length);

    await expect(source.getChapterPages!(locked[0])).rejects.toThrow("team-x: chapter is locked");
    await expect(source.getChapterContent(locked[0])).rejects.toThrow("team-x: chapter is locked");
    expect(calls).toHaveLength(1);
  });

  it("a locked chapter without a site id gets a stable id from the series URL and number", async () => {
    const html = lockedSeries.replace(/data-bs-whatever="\d+"/g, "");
    const a = await createSource(createTestHost({ responses: { [LOCKED_SERIES]: html } })).getNovel(LOCKED_SERIES);
    const b = await createSource(createTestHost({ responses: { [LOCKED_SERIES]: html } })).getNovel(LOCKED_SERIES);
    const lockedA = a.volumes[0].chapters.find((c) => c.lock)!;
    expect(lockedA.id).toBeGreaterThan(0);
    expect(lockedA.id).toBeLessThan(2 ** 31);
    expect(lockedA.id).toBe(b.volumes[0].chapters.find((c) => c.lock)!.id);
  });

  it("chapter pages are the inline images, in order, without fetching bytes", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const source = createSource(createTestHost({ responses, calls }));
    const res = await source.getChapterPages!({ id: 1, title: "x", url: CHAPTER, number: 118, lines: [] });
    const srcs = [...dom(chapterHtml).querySelectorAll("div.image_list img.manga-chapter-img")].map((i) => i.getAttribute("src")!);
    expect(srcs.length).toBeGreaterThan(1);
    expect(res.pages.map((p) => p.url)).toEqual(srcs);
    expect(calls.map((c) => c.url)).toEqual([CHAPTER]);
    const lines = await source.getChapterContent({ id: 1, title: "x", url: CHAPTER, lines: [] });
    expect(lines).toEqual(srcs.map((content) => ({ type: "image", content })));
  });

  it("pages fall back to canvas data-src", async () => {
    const html = `<div class="image_list">
      <div class="page-break"><canvas data-src="https://cdn.olympustaff.com/uploads/a/1.jpg"></canvas></div>
      <div class="page-break"><canvas data-src="/uploads/a/2.jpg"></canvas></div>
    </div>`;
    const url = `${SITE}/series/x/1`;
    const source = createSource(createTestHost({ responses: { [url]: html } }));
    const res = await source.getChapterPages!({ id: 1, title: "x", url, lines: [] });
    expect(res.pages.map((p) => p.url)).toEqual([
      "https://cdn.olympustaff.com/uploads/a/1.jpg",
      `${SITE}/uploads/a/2.jpg`,
    ]);
  });

  it("errors start with the manifest id", async () => {
    const url = `${SITE}/series/x/1`;
    const empty = createSource(createTestHost({ responses: { [url]: "<html><body></body></html>", [`${SITE}/series/x`]: "<html></html>" } }));
    await expect(empty.getChapterPages!({ id: 1, title: "x", url, lines: [] })).rejects.toThrow(/^team-x: /);
    await expect(empty.getNovel(`${SITE}/series/x`)).rejects.toThrow(/^team-x: /);
    const down = createSource(createTestHost({ responses: { [url]: "x" }, status: { "/series/x/1": 503 } }));
    await expect(down.getChapterPages!({ id: 1, title: "x", url, lines: [] })).rejects.toThrow(/^team-x: /);
  });
});
