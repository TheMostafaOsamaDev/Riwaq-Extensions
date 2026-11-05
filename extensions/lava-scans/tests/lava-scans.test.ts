// Fixtures in tests/fixtures were captured live from https://lavascans.com on
// 2026-11-05 with a browser UA and `Accept-Language: ar,en;q=0.8`:
//   home.html    GET /manga/?order=update
//   list.html    GET /manga/?order=popular
//   series.html  GET /manga/global-martial-arts/
//   chapter.html GET /global-martial-arts-chapter-1/
//   search.html  GET /?s=one&paged=1 (the same page as &page=1)
// The site has moved from the stock MangaThemesia markup to its own skin
// (`.manga-card-v`, `.legend-card`, `.ch-item`); the template reads both, and
// the stock markup is covered by small inline snippets below.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseHtml } from "@riwaq/extension-api";
import { createTestHost } from "@riwaq/extension-api/testing";
import createSource from "../src/index";

// fileURLToPath rather than `new URL(rel, import.meta.url)`: see the note in
// extensions/cenele/tests/cenele.test.ts (happy-dom patches global URL).
const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");
const read = (name: string) => readFileSync(join(FIXTURES_DIR, name), "utf8");

const homeHtml = read("home.html");
const listHtml = read("list.html");
const seriesHtml = read("series.html");
const chapterHtml = read("chapter.html");
const searchHtml = read("search.html");

const SERIES = "https://lavascans.com/manga/global-martial-arts/";
const CHAPTER1 = "https://lavascans.com/global-martial-arts-chapter-1/";

/** Order matters: the host answers the first key a URL contains. */
const responses = {
  "order=update": homeHtml,
  "order=popular": listHtml,
  "?s=": searchHtml,
  "-chapter-1/": chapterHtml,
  [SERIES]: seriesHtml,
};

const chapterItems = (html: string) => [...parseHtml(html).querySelectorAll(".ch-item")];

describe("lava-scans", () => {
  it("home sections are latest then popular", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const sections = await createSource(createTestHost({ responses, calls })).getHomeSections();
    expect(sections.map((s) => s.id)).toEqual(["latest", "popular"]);
    expect(calls.map((c) => c.url)).toEqual([
      "https://lavascans.com/manga/?order=update&page=1",
      "https://lavascans.com/manga/?order=popular&page=1",
    ]);
    const expectedLatest = parseHtml(homeHtml).querySelectorAll(".manga-card-v").length;
    const expectedPopular = parseHtml(listHtml).querySelectorAll(".manga-card-v").length;
    expect(expectedLatest).toBeGreaterThan(0);
    expect(sections[0].cards.length).toBe(expectedLatest);
    expect(sections[1].cards.length).toBe(expectedPopular);
    for (const c of sections.flatMap((s) => s.cards)) {
      expect(c.url).toMatch(/^https:\/\/lavascans\.com\/manga\/[^/]+\/$/);
      expect(c.title).not.toBe("");
      expect(c.coverUrl).toMatch(/^https:\/\/lavascans\.com\/wp-content\/uploads\//);
      expect(c.contentType).toBe("manga");
    }
  });

  it("search pages through ?paged", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const source = createSource(createTestHost({ responses, calls }));
    const res = await source.search("one", 2);
    expect(calls[0].url).toBe("https://lavascans.com/?s=one&paged=2");
    expect(res.page).toBe(2);
    expect(res.cards.length).toBe(parseHtml(searchHtml).querySelectorAll(".legend-card").length);
    expect(res.cards.length).toBeGreaterThan(0);
    expect(res.hasMore).toBe(parseHtml(searchHtml).querySelector("a.next.page-numbers") !== null);
    for (const c of res.cards) {
      expect(c.url).toMatch(/\/manga\/[^/]+\/$/);
      expect(c.title).not.toBe("");
      expect(c.contentType).toBe("manga");
    }
    const empty = await source.search("  ", 1);
    expect(empty.cards).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("getNovel reads the series page", async () => {
    const novel = await createSource(createTestHost({ responses })).getNovel(SERIES);
    const doc = parseHtml(seriesHtml);
    expect(novel.title).toBe("Global Martial Arts");
    expect(novel.direction).toBe("rtl");
    expect(novel.language).toBe("ar");
    expect(novel.contentType).toBe("manga");
    expect(novel.coverUrl).toMatch(/1733333353393-771x1024\.webp$/);
    expect(novel.tags).toEqual([...doc.querySelectorAll(".lh-genre-tag")].map((a) => a.textContent!.trim()));
    expect(novel.tags.length).toBeGreaterThan(0);
    expect(novel.description).toContain("فانغ بينغ");
    expect(novel.status).toBe(doc.querySelector(".status-badge-lux")!.textContent!.trim());
    expect(novel.volumes).toHaveLength(1);
  });

  it("chapters come from the series page, oldest first, with numbers", async () => {
    const novel = await createSource(createTestHost({ responses })).getNovel(SERIES);
    const chapters = novel.volumes[0].chapters;
    const items = chapterItems(seriesHtml);
    expect(items.length).toBeGreaterThan(100);
    expect(chapters).toHaveLength(items.length);
    // The page lists newest first; the source returns oldest first.
    expect(chapters.map((c) => c.number)).toEqual(
      items.map((li) => Number(li.getAttribute("data-ch"))).reverse(),
    );
    expect(chapters[0].url).toBe(CHAPTER1);
    expect(chapters.map((c) => c.id)).toEqual(items.map((li) => Number(li.getAttribute("data-id"))).reverse());
    expect(new Set(chapters.map((c) => c.id)).size).toBe(chapters.length);
    expect(chapters[0].title).toContain("1");
  });

  it("a coin chapter is returned locked and never fetched", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const source = createSource(createTestHost({ responses, calls }));
    const chapters = (await source.getNovel(SERIES)).volumes[0].chapters;
    const lockedCount = chapterItems(seriesHtml).filter((li) => li.getAttribute("data-coin") === "yes").length;
    expect(lockedCount).toBeGreaterThan(0);
    const locked = chapters.filter((c) => c.lock);
    expect(locked).toHaveLength(lockedCount);
    expect(locked[0].lock).toEqual({ reason: "locked", openUrl: locked[0].url });
    calls.length = 0;
    await expect(source.getChapterPages!(locked[0])).rejects.toThrow("lava-scans: chapter is locked");
    expect(calls).toEqual([]);
  });

  it("chapters come from #chapterlist with data-num numbers", async () => {
    // Stock MangaThemesia markup, newest first.
    const li = (n: string, cls = "") =>
      `<li data-num="${n}" class="${cls}"><div class="chbox"><div class="eph-num"><a href="https://lavascans.com/x-chapter-${n}/"><span class="chapternum">Chapter ${n}</span></a></div></div></li>`;
    const html = `<html><body><h1 class="entry-title">T</h1><div id="chapterlist"><ul>${li("2.5")}${li("2")}${li("1", "locked")}</ul></div></body></html>`;
    const source = createSource(createTestHost({ responses: { [SERIES]: html } }));
    const chapters = (await source.getNovel(SERIES)).volumes[0].chapters;
    expect(chapters.map((c) => c.number)).toEqual(
      [...parseHtml(html).querySelectorAll("li[data-num]")].map((e) => Number(e.getAttribute("data-num"))).reverse(),
    );
    expect(chapters.map((c) => c.number)).toEqual([1, 2, 2.5]);
    expect(chapters[0].lock).toBeDefined();
    expect(chapters[1].lock).toBeUndefined();
    expect(chapters[2].title).toBe("Chapter 2.5");
  });

  it("stock MangaThemesia cards are read from .bsx", async () => {
    const html = `<div class="bsx"><a href="https://lavascans.com/manga/a/" title="A Title"><div class="limit"><img src="https://lavascans.com/c.jpg"></div><div class="bigor"><div class="tt"> A Title </div></div></a></div>`;
    const res = await createSource(createTestHost({ responses: { "?s=": html } })).search("a", 1);
    expect(res.cards).toEqual([
      { url: "https://lavascans.com/manga/a/", title: "A Title", coverUrl: "https://lavascans.com/c.jpg", contentType: "manga" },
    ]);
  });

  it("getChapterPages reads ts_reader", async () => {
    const source = createSource(createTestHost({ responses }));
    const script = [...parseHtml(chapterHtml).querySelectorAll("script")]
      .map((s) => s.textContent ?? "")
      .find((t) => t.includes("ts_reader.run("))!;
    const json = JSON.parse(/ts_reader\.run\((\{.*\})\);/.exec(script)![1]);
    const expected: string[] = json.sources[0].images;
    expect(expected.length).toBeGreaterThan(0);
    const chapter = { id: 1, title: "1", url: CHAPTER1, lines: [] };
    const res = await source.getChapterPages!(chapter);
    expect(res.pages.map((p) => p.url)).toEqual(expected);
    expect(res.pages.every((p) => p.headers === undefined)).toBe(true);
    const lines = await source.getChapterContent(chapter);
    expect(lines.map((l) => l.content)).toEqual(expected);
  });

  it("a page without ts_reader is an error", async () => {
    const source = createSource(createTestHost({ responses: { "-chapter-1/": "<html></html>" } }));
    await expect(source.getChapterPages!({ id: 1, title: "1", url: CHAPTER1, lines: [] })).rejects.toThrow(
      "lava-scans:",
    );
  });

  it("a Cloudflare challenge is reported, not parsed", async () => {
    const host = createTestHost({
      responses: { "lavascans.com": "<html>Just a moment...</html>" },
      status: { "lavascans.com": 403 },
      headers: { "lavascans.com": { "cf-mitigated": "challenge" } },
    });
    await expect(createSource(host).getHomeSections()).rejects.toThrow(
      "lava-scans: blocked by a Cloudflare check",
    );
  });
});
