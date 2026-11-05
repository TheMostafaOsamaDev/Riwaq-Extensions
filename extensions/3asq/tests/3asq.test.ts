// Fixtures in tests/fixtures were captured live from https://3asq.online on
// 2026-11-05 with a browser UA and `Accept-Language: ar,en;q=0.8`:
//   home.html        GET  /manga/?m_orderby=latest
//   series.html      GET  /manga/one-piece/
//   chapters-t1.html POST /manga/one-piece/ajax/chapters/?t=1 (X-Requested-With)
//   chapters-t2.html POST /manga/one-piece/ajax/chapters/?t=2
//   chapter.html     GET  /manga/one-piece/1197/
//   search.html      GET  /?s=one&post_type=wp-manga&paged=1
// and on 2026-11-06:
//   series-adult.html GET /manga/tengoku-daimakyou-2/ (an adult series: an "18+"
//                     `.manga-title-badges.adult` beside .post-title, body.adult-content)
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseHtml } from "@riwaq/extension-api";
import { createTestHost } from "@riwaq/extension-api/testing";
import { parseChapterNumber } from "@riwaq/manga-themes";
import createSource from "../src/index";

// fileURLToPath rather than `new URL(rel, import.meta.url)`: see the note in
// extensions/cenele/tests/cenele.test.ts (happy-dom patches global URL).
const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");
const read = (name: string) => readFileSync(join(FIXTURES_DIR, name), "utf8");

const homeHtml = read("home.html");
const seriesHtml = read("series.html");
const chaptersT1 = read("chapters-t1.html");
const chaptersT2 = read("chapters-t2.html");
const chapterHtml = read("chapter.html");
const searchHtml = read("search.html");
const adultSeriesHtml = read("series-adult.html");

const SERIES = "https://3asq.online/manga/one-piece/";
const AJAX1 = `${SERIES}ajax/chapters/?t=1`;
const AJAX2 = `${SERIES}ajax/chapters/?t=2`;

/** Order matters: the host answers the first key a URL contains. */
const responses = {
  [AJAX1]: chaptersT1,
  [AJAX2]: chaptersT2,
  "/1197/": chapterHtml,
  "m_orderby=latest": homeHtml,
  "m_orderby=views": homeHtml,
  "post_type=wp-manga": searchHtml,
  [SERIES]: seriesHtml,
};

function chapterLinks(html: string): string[] {
  return [...parseHtml(html).querySelectorAll("li.wp-manga-chapter > a")].map(
    (a) => a.getAttribute("href") ?? "",
  );
}

describe("3asq", () => {
  it("home sections are latest then popular", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const sections = await createSource(createTestHost({ responses, calls })).getHomeSections();
    expect(sections.map((s) => s.id)).toEqual(["latest", "popular"]);
    expect(calls.map((c) => c.url)).toEqual([
      "https://3asq.online/manga/?m_orderby=latest",
      "https://3asq.online/manga/?m_orderby=views",
    ]);
    const expected = parseHtml(homeHtml).querySelectorAll(".page-item-detail").length;
    expect(expected).toBeGreaterThan(0);
    for (const s of sections) {
      expect(s.cards.length).toBe(expected);
      for (const c of s.cards) {
        expect(c.url).toMatch(/^https:\/\/3asq\.online\/manga\/[^/]+\/$/);
        expect(c.title).not.toBe("");
        expect(c.coverUrl).toMatch(/^https:\/\/3asq\.online\/wp-content\/uploads\//);
        expect(c.contentType).toBe("manga");
      }
    }
  });

  it("a card with the theme's adult badge is flagged nsfw, and only that card", async () => {
    const sections = await createSource(createTestHost({ responses })).getHomeSections();
    const rows = [...parseHtml(homeHtml).querySelectorAll(".page-item-detail")];
    const adult = new Set(
      rows
        .filter((r) => r.querySelector(".manga-title-badges.adult") !== null)
        .map((r) => [...r.querySelectorAll(".post-title a")].at(-1)!.getAttribute("href")),
    );
    expect(adult.size).toBeGreaterThan(0);
    expect(adult.size).toBeLessThan(rows.length);
    for (const c of sections[0].cards) {
      if (adult.has(c.url)) expect(c.nsfw).toBe(true);
      else expect(c).not.toHaveProperty("nsfw");
    }
  });

  it("an adult series is flagged nsfw; One Piece is not", async () => {
    const adultUrl = "https://3asq.online/manga/tengoku-daimakyou-2/";
    const oneLi = `<li class="wp-manga-chapter"><a href="${adultUrl}86/">86</a></li>`;
    const adultHost = createTestHost({
      responses: { [`${adultUrl}ajax/chapters/`]: oneLi, [adultUrl]: adultSeriesHtml },
    });
    const adult = await createSource(adultHost).getNovel(adultUrl);
    expect(adult.title).toBe("Tengoku Daimakyou");
    expect(adult.nsfw).toBe(true);
    const onePiece = await createSource(createTestHost({ responses })).getNovel(SERIES);
    expect(onePiece).not.toHaveProperty("nsfw");
  });

  it("the series badge or the theme's adult-content body class marks a series nsfw", async () => {
    const page = (body: string, badges: string) =>
      `<html><body class="${body}"><div class="post-title">${badges}<h1>T</h1></div></body></html>`;
    const novel = async (html: string) =>
      createSource(
        createTestHost({
          responses: { [AJAX1]: `<li class="wp-manga-chapter"><a href="${SERIES}1/">1</a></li>`, [SERIES]: html },
        }),
      ).getNovel(SERIES);
    const adultBadge = '<span class="manga-title-badges custom adult badge-round"><span class="text">18+</span></span>';
    const hotBadge = '<span class="manga-title-badges hot badge-round"><span class="text">Hot</span></span>';
    expect((await novel(page("single-wp-manga", adultBadge))).nsfw).toBe(true);
    expect((await novel(page("single-wp-manga adult-content", hotBadge))).nsfw).toBe(true);
    expect(await novel(page("single-wp-manga", hotBadge))).not.toHaveProperty("nsfw");
  });

  it("getNovel builds lazy volumes from the chapter pager", async () => {
    const source = createSource(createTestHost({ responses }));
    expect(source.hasLazyVolumes).toBe(true);
    const novel = await source.getNovel(SERIES);
    const pages = Math.max(
      ...[...parseHtml(chaptersT1).querySelectorAll("[data-page]")].map((a) =>
        Number(a.getAttribute("data-page")),
      ),
    );
    expect(pages).toBeGreaterThan(2);
    expect(novel.volumes).toHaveLength(pages);
    expect(novel.title).toBe("One Piece");
    expect(novel.direction).toBe("rtl");
    expect(novel.language).toBe("ar");
    expect(novel.contentType).toBe("manga");
    expect(novel.coverUrl).toMatch(/v1-1\.jpg$/);
    expect(novel.tags.length).toBeGreaterThan(0);

    const newest = novel.volumes[pages - 1];
    expect(newest.chapters.map((c) => c.url)).toEqual(chapterLinks(chaptersT1).reverse());
    expect(newest.key).toBe("1");
    for (const v of novel.volumes.slice(0, -1)) expect(v.chapters).toEqual([]);
    expect(novel.volumes[0].key).toBe(String(pages));
    expect(novel.volumes[0].chapterCount).toBeUndefined();
    expect(novel.volumes[1].chapterCount).toBe(50);
    expect(novel.volumes[1].key).toBe(String(pages - 1));
    expect(novel.volumes.map((v) => v.id)).toEqual(novel.volumes.map((_, i) => i + 1));
  });

  it("getVolumeChapters loads one page", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const source = createSource(createTestHost({ responses, calls }));
    const chapters = await source.getVolumeChapters!(SERIES, {
      id: 11,
      title: "Part 11",
      key: "2",
      chapters: [],
    });
    expect(chapters.map((c) => c.url)).toEqual(chapterLinks(chaptersT2).reverse());
    expect(calls).toEqual([{ url: AJAX2, method: "POST", body: undefined }]);
  });

  it("a decimal chapter slug becomes a decimal number", async () => {
    const source = createSource(createTestHost({ responses }));
    const chapters = await source.getVolumeChapters!(SERIES, {
      id: 12,
      title: "Part 12",
      key: "1",
      chapters: [],
    });
    const decimal = chapters.find((c) => c.url.endsWith("/1155-5/"));
    expect(decimal?.number).toBe(1155.5);
    expect(chapters.every((c) => c.number === parseChapterNumber(c.url.split("/").filter(Boolean).pop()!))).toBe(true);
    expect(new Set(chapters.map((c) => c.id)).size).toBe(chapters.length);
  });

  it("an Arabic chapter slug parses to its own number", async () => {
    // The href is percent-encoded once it is absolute; its escapes must not
    // be read as digits.
    const li = (slug: string) => `<li class="wp-manga-chapter"><a href="${SERIES}${slug}/">${slug}</a></li>`;
    const host = createTestHost({ responses: { [AJAX1]: li("١٢") + li("الفصل-12") } });
    const chapters = await createSource(host).getVolumeChapters!(SERIES, {
      id: 1,
      title: "p",
      key: "1",
      chapters: [],
    });
    expect(chapters.map((c) => c.number)).toEqual([12, 12]);
  });

  it("a premium chapter is parsed with a lock", async () => {
    const li = (cls: string, n: number) =>
      `<li class="wp-manga-chapter ${cls}"><a href="${SERIES}${n}/">${n}</a></li>`;
    const host = createTestHost({ responses: { [AJAX1]: li("", 2) + li("premium", 1) } });
    const chapters = await createSource(host).getVolumeChapters!(SERIES, {
      id: 1,
      title: "p",
      key: "1",
      chapters: [],
    });
    expect(chapters.map((c) => c.number)).toEqual([1, 2]);
    expect(chapters[0].lock).toEqual({ reason: "locked", openUrl: `${SERIES}1/` });
    expect(chapters[1].lock).toBeUndefined();
  });

  it("getChapterPages lists the reading images in order", async () => {
    const source = createSource(createTestHost({ responses }));
    const expected = [...parseHtml(chapterHtml).querySelectorAll(".reading-content img")].map((i) =>
      (i.getAttribute("data-src") ?? i.getAttribute("data-lazy-src") ?? i.getAttribute("src") ?? "").trim(),
    );
    expect(expected.length).toBeGreaterThan(5);
    const res = await source.getChapterPages!({
      id: 1,
      title: "1197",
      url: `${SERIES}1197/`,
      lines: [],
    });
    expect(res.pages.map((p) => p.url)).toEqual(expected);
    expect(res.pages.every((p) => p.url.startsWith("https://") && p.headers === undefined)).toBe(true);
    const lines = await source.getChapterContent({ id: 1, title: "1197", url: `${SERIES}1197/`, lines: [] });
    expect(lines.map((l) => l.content)).toEqual(expected);
  });

  it("a locked chapter is never fetched", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const source = createSource(createTestHost({ responses, calls }));
    await expect(
      source.getChapterPages!({
        id: 1,
        title: "x",
        url: `${SERIES}1197/`,
        lock: { reason: "paid", openUrl: `${SERIES}1197/` },
        lines: [],
      }),
    ).rejects.toThrow("3asq: chapter is locked");
    expect(calls).toEqual([]);
  });

  it("search returns manga cards", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const res = await createSource(createTestHost({ responses, calls })).search("one", 1);
    expect(calls[0].url).toBe("https://3asq.online/?s=one&post_type=wp-manga&paged=1");
    expect(res.page).toBe(1);
    expect(res.cards.length).toBe(parseHtml(searchHtml).querySelectorAll(".c-tabs-item__content").length);
    expect(res.cards.length).toBeGreaterThan(0);
    expect(res.hasMore).toBe(parseHtml(searchHtml).querySelector(".nav-previous a") !== null);
    for (const c of res.cards) {
      expect(c.url).toMatch(/\/manga\/[^/]+\/$/);
      expect(c.title).not.toBe("");
      expect(c.coverUrl).toMatch(/^https:\/\//);
      expect(c.contentType).toBe("manga");
    }
  });

  it("a Cloudflare challenge is reported, not parsed", async () => {
    const host = createTestHost({
      responses: { "3asq.online": "<html>Just a moment...</html>" },
      status: { "3asq.online": 403 },
      headers: { "3asq.online": { "cf-mitigated": "challenge" } },
    });
    await expect(createSource(host).getHomeSections()).rejects.toThrow("3asq: blocked by a Cloudflare check");
  });
});
