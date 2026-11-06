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
//   chapters-t11.html POST /manga/one-piece/ajax/chapters/?t=11
//   chapters-t12.html POST /manga/one-piece/ajax/chapters/?t=12 (the last page; 22 chapters)
//   (page 1 was re-read the same day and still listed the same chapters, so all
//   four chapter pages describe one moment.)
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
const chaptersBeforeLast = read("chapters-t11.html");
const chaptersLast = read("chapters-t12.html");

const SERIES = "https://3asq.online/manga/one-piece/";
const ajax = (page: number) => `${SERIES}ajax/chapters/?t=${page}`;
const AJAX1 = ajax(1);
const AJAX2 = ajax(2);

/** The highest page the pager names: the page count, read off page 1. */
const pagerMax = (html: string) =>
  Math.max(...[...parseHtml(html).querySelectorAll("[data-page]")].map((a) => Number(a.getAttribute("data-page"))));
const LAST_PAGE = pagerMax(chaptersT1);
/** Every page but the last holds fifty. */
const TOTAL = 50 * (LAST_PAGE - 1) + parseHtml(chaptersLast).querySelectorAll("li.wp-manga-chapter").length;
const VOLUMES = Math.ceil(TOTAL / 50);

/** Order matters: the host answers the first key a URL contains (an exact
 *  match first, so `?t=1` does not answer `?t=12`). */
const responses = {
  [AJAX1]: chaptersT1,
  [AJAX2]: chaptersT2,
  [ajax(LAST_PAGE - 1)]: chaptersBeforeLast,
  [ajax(LAST_PAGE)]: chaptersLast,
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

/** A chapter page's pager markup, as captured. */
const pagerOf = (html: string) => parseHtml(html).querySelector(".pagination")!.outerHTML;

/** The theme's pager on page `page` of `pages`: first, neighbours, last. */
const syntheticPager = (page: number, pages: number) => {
  if (pages < 2) return "";
  const shown = [...new Set([1, page - 1, page, page + 1, pages])].filter((p) => p >= 1 && p <= pages);
  const spans = shown.map((p) =>
    p === page
      ? `<span class="page current page-${p}">${p}</span>`
      : `<span class="page page-${p}"><a href="/?t=${p}" data-page="${p}">${p}</a></span>`,
  );
  return `<div class="pagination">${spans.join("")}</div>`;
};

/** An ajax chapter page in the theme's markup, newest first. */
const ajaxPage = (urls: string[], pager: string) =>
  `<ul class="main version-chap no-volumn">${urls
    .map((u) => `<li class="wp-manga-chapter"><a href="${u}">${u.split("/").filter(Boolean).pop()}</a></li>`)
    .join("")}</ul>${pager}`;

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

  it("getNovel numbers volumes from the oldest chapter, reading the first and last chapter pages", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const source = createSource(createTestHost({ responses, calls }));
    expect(source.hasLazyVolumes).toBe(true);
    const novel = await source.getNovel(SERIES);
    expect(novel.title).toBe("One Piece");
    expect(novel.direction).toBe("rtl");
    expect(novel.language).toBe("ar");
    expect(novel.contentType).toBe("manga");
    expect(novel.coverUrl).toMatch(/v1-1\.jpg$/);
    expect(novel.tags.length).toBeGreaterThan(0);

    // The series page, page 1 (newest, with the pager) and page P (oldest).
    expect(calls.map((c) => c.url).sort()).toEqual([SERIES, AJAX1, ajax(LAST_PAGE)].sort());
    expect(calls.at(-1)).toMatchObject({ url: ajax(LAST_PAGE), method: "POST" });

    expect(novel.volumes).toHaveLength(VOLUMES);
    expect(novel.volumes.map((v) => v.id)).toEqual(novel.volumes.map((_, i) => i + 1));
    expect(novel.volumes.map((v) => v.key)).toEqual(novel.volumes.map((_, i) => String(i + 1)));
    expect(novel.volumes.map((v) => v.title)).toEqual(novel.volumes.map((_, i) => `Part ${i + 1}`));
    // Exact counts: fifty in every volume but the newest, which holds the rest.
    const newestCount = TOTAL - 50 * (VOLUMES - 1);
    expect(novel.volumes.map((v) => v.chapterCount)).toEqual([
      ...Array<number>(VOLUMES - 1).fill(50),
      newestCount,
    ]);
    // Only the newest volume is filled, from page 1.
    for (const v of novel.volumes.slice(0, -1)) expect(v.chapters).toEqual([]);
    const newest = novel.volumes.at(-1)!;
    expect(newest.chapters.map((c) => c.url)).toEqual(chapterLinks(chaptersT1).slice(0, newestCount).reverse());
  });

  it("the oldest volume is the oldest fifty chapters, from the last two chapter pages", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const source = createSource(createTestHost({ responses, calls }));
    const novel = await source.getNovel(SERIES);
    calls.length = 0;
    const chapters = await source.getVolumeChapters!(SERIES, novel.volumes[0]);
    const oldest = [...chapterLinks(chaptersLast).reverse(), ...chapterLinks(chaptersBeforeLast).reverse()];
    expect(chapters.map((c) => c.url)).toEqual(oldest.slice(0, 50));
    expect(calls.map((c) => c.url)).toEqual([ajax(LAST_PAGE), ajax(LAST_PAGE - 1)]);
  });

  it("a middle volume slices the two pages it straddles", async () => {
    // Volume V-1 is chapters 50(V-2)+1 … 50(V-1) from the oldest: counted from
    // the newest that is TOTAL-50(V-1)+1 … TOTAL-50(V-2), on pages 1 and 2.
    const calls: Array<{ url: string; method: string }> = [];
    const source = createSource(createTestHost({ responses, calls }));
    const novel = await source.getNovel(SERIES);
    calls.length = 0;
    const chapters = await source.getVolumeChapters!(SERIES, novel.volumes[VOLUMES - 2]);
    const newestFirst = [...chapterLinks(chaptersT1), ...chapterLinks(chaptersT2)];
    const from = TOTAL - 50 * (VOLUMES - 1);
    expect(chapters.map((c) => c.url)).toEqual(newestFirst.slice(from, from + 50).reverse());
    // The last page is re-read for its current length, then the two pages.
    expect(calls.map((c) => c.url)).toEqual([ajax(LAST_PAGE), AJAX1, AJAX2]);
  });

  it("a fresh source finds the page count on page 1 before reading the last page", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const source = createSource(createTestHost({ responses, calls }));
    const chapters = await source.getVolumeChapters!(SERIES, { id: 1, title: "Part 1", key: "1", chapters: [] });
    expect(chapters).toHaveLength(50);
    expect(calls.map((c) => c.url)).toEqual([AJAX1, ajax(LAST_PAGE), ajax(LAST_PAGE - 1)]);
  });

  it("one new release leaves the older volumes, their keys and their chapters, unchanged", async () => {
    const before = createSource(createTestHost({ responses }));
    const novelBefore = await before.getNovel(SERIES);
    const volume1Before = await before.getVolumeChapters!(SERIES, novelBefore.volumes[0]);

    // A release prepends a chapter to page 1, and every page hands its oldest
    // chapter on to the next one (the captured <li>s move as they are).
    const released = `${SERIES}9999/`;
    const li = (url: string) => `<li class="wp-manga-chapter"><a href="${url}">${url}</a></li>`;
    const items = (html: string) => [...parseHtml(html).querySelectorAll("li.wp-manga-chapter")].map((e) => e.outerHTML);
    const page = (lis: string[], html: string) => `<ul class="main">${lis.join("")}</ul>${pagerOf(html)}`;
    const after = {
      [AJAX1]: page([li(released), ...items(chaptersT1).slice(0, 49)], chaptersT1),
      [ajax(LAST_PAGE - 1)]: page(
        [li(`${SERIES}oldest-of-page-${LAST_PAGE - 2}/`), ...items(chaptersBeforeLast).slice(0, 49)],
        chaptersBeforeLast,
      ),
      [ajax(LAST_PAGE)]: page([items(chaptersBeforeLast).at(-1)!, ...items(chaptersLast)], chaptersLast),
      [SERIES]: seriesHtml,
    };
    const source = createSource(createTestHost({ responses: after }));
    const novel = await source.getNovel(SERIES);
    expect(novel.volumes.map((v) => v.key)).toEqual(novelBefore.volumes.map((v) => v.key));
    expect(novel.volumes.map((v) => v.chapterCount)).toEqual(
      novelBefore.volumes.map((v, i, all) => (i === all.length - 1 ? v.chapterCount! + 1 : v.chapterCount)),
    );
    expect(novel.volumes.at(-1)!.chapters.at(-1)!.url).toBe(released);
    const volume1 = await source.getVolumeChapters!(SERIES, novel.volumes[0]);
    expect(volume1).toEqual(volume1Before);
  });

  it("a release that opens a new page adds a volume and moves no chapter", async () => {
    // Exactly 100 chapters (two full pages), then one more (a third page).
    const urls = (n: number) => Array.from({ length: n }, (_, i) => `${SERIES}${n - i}/`);
    const site = (n: number) => {
      const all = urls(n);
      const pages = Math.ceil(n / 50);
      const out: Record<string, string> = {};
      for (let p = 1; p <= pages; p++) out[ajax(p)] = ajaxPage(all.slice(50 * (p - 1), 50 * p), syntheticPager(p, pages));
      out[SERIES] = seriesHtml;
      return out;
    };
    const host100 = site(100);
    const host101 = site(101);
    // One source, so its remembered page count (2) is stale once the site has 3.
    let current = host100;
    const source = createSource({
      ...createTestHost(),
      fetch: async (url, opts) => createTestHost({ responses: current }).fetch(url, opts),
    });
    const novel100 = await source.getNovel(SERIES);
    expect(novel100.volumes.map((v) => v.chapterCount)).toEqual([50, 50]);
    const v1 = await source.getVolumeChapters!(SERIES, novel100.volumes[0]);
    expect(v1.map((c) => c.number)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));

    current = host101;
    // Expanding from the stale listing still answers chapters 1-50 and 51-100.
    expect(await source.getVolumeChapters!(SERIES, novel100.volumes[0])).toEqual(v1);
    const v2 = await source.getVolumeChapters!(SERIES, novel100.volumes[1]);
    expect(v2.map((c) => c.number)).toEqual(Array.from({ length: 50 }, (_, i) => i + 51));
    const novel101 = await source.getNovel(SERIES);
    expect(novel101.volumes.map((v) => [v.key, v.chapterCount])).toEqual([
      ["1", 50],
      ["2", 50],
      ["3", 1],
    ]);
    expect(novel101.volumes[2].chapters.map((c) => c.number)).toEqual([101]);
  });

  it("a short chapter page is reported, not sliced", async () => {
    const short = ajaxPage(chapterLinks(chaptersT2).slice(0, 49), pagerOf(chaptersT2));
    const source = createSource(createTestHost({ responses: { ...responses, [AJAX2]: short } }));
    const novel = await source.getNovel(SERIES);
    await expect(source.getVolumeChapters!(SERIES, novel.volumes[VOLUMES - 2])).rejects.toThrow(
      /^3asq: .*49 chapters/,
    );
  });

  it("a decimal chapter slug becomes a decimal number", async () => {
    const source = createSource(createTestHost({ responses }));
    const novel = await source.getNovel(SERIES);
    const chapters = [
      ...(await source.getVolumeChapters!(SERIES, novel.volumes[VOLUMES - 2])),
      ...novel.volumes.at(-1)!.chapters,
    ];
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
