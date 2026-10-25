import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import createSource from "../src/index";
import {
  collectHiddenClasses,
  numberChapters,
  parseChapterContent,
  parseHomeSections,
  parseNovelPage,
  parseSearchResults,
  parseVolumeChapterRows,
} from "../src/theme";
import { createTestHost } from "@riwaq/extension-api/testing";
import type { SourceHost } from "@riwaq/extension-api";

// Deliberately not `readFileSync(new URL("./fixtures/search.html", import.meta.url), ...)`:
// this suite runs under `environment: "happy-dom"` (see vitest.config.ts), and
// happy-dom's patched global `URL` silently resolves a *relative* two-argument
// `new URL(href, base)` against its fake `window.location` instead of the given
// file: base — reproduced here even though this file is itself a vitest entry
// module, not just an imported one (see scripts/build.ts's REPO_ROOT comment for
// the same failure mode in a different module). `fileURLToPath` on this file's
// own `import.meta.url` (no relative resolution involved) plus plain path-segment
// arithmetic sidesteps it entirely.
const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");
/** This extension's own manifest id. Errors are prefixed with it (never
 *  with a display name) because CONTRIBUTING.md's bug-report section asks
 *  users for the id — reading it from the manifest here means renaming the
 *  id without updating the error strings fails this suite. */
const MANIFEST_ID = (
  JSON.parse(readFileSync(join(FIXTURES_DIR, "..", "..", "manifest.json"), "utf8")) as {
    id: string;
  }
).id;

const fixture = (name: string) => readFileSync(join(FIXTURES_DIR, name), "utf8");

// Live captures of the "starless" theme, 2026-10-25, committed unedited:
//   home.html                 GET /
//   search.html               GET /?s=سيد            (21 matches: 20 here + a pager)
//   search-page2.html         GET /page/2/?s=سيد     (the 21st, no pager)
//   novel.html                GET /series/emperors-domination/   (15 volumes, 6,703 chapters)
//   novel-single-volume.html  GET /series/خالد-العوالم-التسعة/   (1 volume, 101 chapters)
//   volume-page{1,2,3}.json   kol_series_volume_chapters for that one volume, pages 1-3
//   volume-info.json          kol_series_volume_chapters, emperors-domination's "INFO" volume
//   volume-bad-nonce.json     the same action with a wrong nonce → HTTP 403, body `-1`
//   chapter-starless.html     a chapter page with unclosed <p> tags in its body
const searchHtml = fixture("search.html");
const searchPage2Html = fixture("search-page2.html");
const homeHtml = fixture("home.html");
const novelHtml = fixture("novel.html");
const singleVolumeNovelHtml = fixture("novel-single-volume.html");
const volumePages = [1, 2, 3].map((n) => fixture(`volume-page${n}.json`));
const volumeInfoJson = fixture("volume-info.json");
const badNonceBody = fixture("volume-bad-nonce.json");
const starlessChapterHtml = fixture("chapter-starless.html");
const chapterHtml = fixture("chapter.html");

const BASE = "https://kolnovel.com";
const NOVEL_URL = "https://kolnovel.com/series/emperors-domination/";
const SINGLE_VOLUME_URL =
  "https://kolnovel.com/series/%d8%ae%d8%a7%d9%84%d8%af-%d8%a7%d9%84%d8%b9%d9%88%d8%a7%d9%84%d9%85-%d8%a7%d9%84%d8%aa%d8%b3%d8%b9%d8%a9/";
/** The chapter-list action's url up to the per-volume part; tests key
 *  createTestHost responses on substrings of the rest. */
const VOLUME_ACTION = "https://kolnovel.com/wp-admin/admin-ajax.php?action=kol_series_volume_chapters";

const doc = (html: string) => new DOMParser().parseFromString(html, "text/html");
/** `data.html` of a captured chapter-list response, as its own document. */
const volumeDoc = (json: string) => doc((JSON.parse(json) as { data: { html: string } }).data.html);

describe("parseSearchResults", () => {
  const parse = (html: string, page = 1) => parseSearchResults(doc(html), BASE, "سيد", page);

  it("reads every result card: url, title, cover, excerpt and genres", () => {
    const { cards } = parse(searchHtml);
    expect(cards).toHaveLength(20);
    expect(cards[0]).toMatchObject({
      url: "https://kolnovel.com/series/%d8%b3%d9%8a%d8%af-%d8%a7%d9%84%d8%b8%d9%84%d8%a7%d9%84-%d8%a7%d9%84%d8%b5%d8%a7%d9%85%d8%aa%d8%a9/",
      title: "سيد الظلال الصامتة",
      coverUrl:
        "https://kolnovel.com/wp-content/uploads/2026/07/7901f39a81210a9d7abb67d80cbccc69-192x300.png",
      badges: ["اكشن مغامرات", "ايسيكاي", "غموض"],
    });
    expect(cards[0].subtitle).toMatch(/^حين يشعر العالم بأنك لا تنتمي إليه/);
    expect(cards.every((c) => /^https:\/\/kolnovel\.com\/series\/[^/]+\/$/.test(c.url) && c.title)).toBe(true);
  });

  it("reports hasMore from the pager: true on page 1 of 2, false on the last page", () => {
    expect(parse(searchHtml, 1).hasMore).toBe(true);
    const last = parse(searchPage2Html, 2);
    expect(last.cards).toHaveLength(1);
    expect(last.cards[0].title).toBe("جوهرة&التغير&السماوية");
    expect(last.hasMore).toBe(false);
  });

  it("returns no cards for an empty result set", () => {
    expect(parse("<html><body><main class='kol-search'></main></body></html>").cards).toEqual([]);
  });

  it("echoes query and page", () => {
    const r = parse(searchPage2Html, 2);
    expect(r.query).toBe("سيد");
    expect(r.page).toBe(2);
  });
});

describe("parseHomeSections", () => {
  const sections = () => parseHomeSections(doc(homeHtml), BASE, createTestHost());

  it("reads every novel rail, in page order, keyed by the rail's own class", () => {
    expect(sections().map((s) => [s.id, s.title, s.cards.length])).toEqual([
      ["hero-grid", "الروايات الصاعدة", 5],
      ["rising-kings", "الرائج هذا الأسبوع", 6],
      ["updates", "التحديثات", 10],
      ["most-read", "ترتيب الروايات", 7],
      ["newly-added", "روايات أضيفت حديثاً", 6],
      ["completed", "روايات مكتملة", 6],
    ]);
  });

  it("only ever emits series cards, each with a title and a cover, never twice in one rail", () => {
    for (const s of sections()) {
      for (const c of s.cards) {
        expect(c.url).toMatch(/^https:\/\/kolnovel\.com\/series\/[^/]+\/$/);
        expect(c.title.length).toBeGreaterThan(0);
        expect(c.coverUrl).toMatch(/^https:\/\//);
      }
      expect(new Set(s.cards.map((c) => c.url)).size).toBe(s.cards.length);
    }
  });

  it("reads the hero novel, whose title hook is an <h1> carrying the url in a data attribute", () => {
    const hero = sections()[0].cards[0];
    expect(hero.title).toBe("ملك سمات الفنون القتالية");
    expect(hero.url).toBe(
      "https://kolnovel.com/series/%d9%85%d9%84%d9%83-%d8%b3%d9%85%d8%a7%d8%aa-%d8%a7%d9%84%d9%81%d9%86%d9%88%d9%86-%d8%a7%d9%84%d9%82%d8%aa%d8%a7%d9%84%d9%8a%d8%a9/",
    );
  });

  it("gives update rows their latest chapter as a subtitle and links the rail's 'view all'", () => {
    const updates = sections().find((s) => s.id === "updates")!;
    expect(updates.cards.every((c) => (c.subtitle ?? "").length > 0)).toBe(true);
    expect(updates.viewMoreUrl).toBe("https://kolnovel.com/series/?order=update");
  });

  it("keeps a rail's id when an earlier rail is missing", () => {
    const d = doc(homeHtml);
    d.querySelector("section.kol-home-hero-grid")!.remove();
    expect(parseHomeSections(d, BASE, createTestHost()).map((s) => s.id)).toEqual([
      "rising-kings",
      "updates",
      "most-read",
      "newly-added",
      "completed",
    ]);
  });
});

describe("parseNovelPage", () => {
  const novel = () => parseNovelPage(doc(novelHtml), BASE, NOVEL_URL, createTestHost());

  it("reads title, original title, status, cover, tags and meta rows", () => {
    const n = novel();
    expect(n.title).toBe("هيمنة الإمبراطور");
    expect(n.originalTitle).toBe("Emperor’s Domination");
    expect(n.status).toBe("مستمرة");
    expect(n.coverUrl).toBe("https://kolnovel.com/wp-content/uploads/2020/10/680bc144fea8822f.jpg");
    expect(n.tags).toEqual(["أكشن", "حريم", "ظواهر خارقة للطبيعة", "غموض", "فنون القتال", "مغامرة"]);
    expect(n.meta).toContainEqual({ label: "صدر في", value: "2014", url: undefined });
    expect(n.meta).toContainEqual({ label: "المترجمون", value: "Ghost.E، Scrub" });
    expect(n.language).toBe("ar");
    expect(n.direction).toBe("rtl");
  });

  it("leaves the author blank — the theme prints none — for the host to localize", () => {
    expect(novel().author).toBe("");
  });

  it("reads the synopsis without the donation widget the theme appends to it", () => {
    const d = novel().description ?? "";
    expect(d).toMatch(/^لايوجد منقذ في هذا العالم/);
    expect(d).not.toMatch(/شعلة|الداعمين/);
  });

  it("returns every volume oldest first, empty and lazy, keyed by the site's own volume name", () => {
    const { volumes } = novel();
    expect(volumes).toHaveLength(15);
    expect(volumes.map((v) => v.id)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(volumes[0]).toEqual({ id: 1, title: "INFO", chapters: [], chapterCount: 2, key: "INFO" });
    // The site's no-volume bucket: an empty key is real, not missing.
    expect(volumes[14]).toEqual({ id: 15, title: "الفصول", chapters: [], chapterCount: 2756, key: "" });
    // Counts are printed with the Arabic thousands separator ("2٬756") and
    // must add up to the page's own total.
    expect(volumes.reduce((n, v) => n + (v.chapterCount ?? 0), 0)).toBe(6703);
  });

  it("refuses a page with no title instead of returning a hollow SourceNovel", () => {
    expect(() =>
      parseNovelPage(doc("<html><body><p>error</p></body></html>"), BASE, NOVEL_URL, createTestHost()),
    ).toThrow(/^kolnovel: couldn't find a novel title on https:\/\/kolnovel\.com\/series\/emperors-domination\//);
  });

  it("does NOT refuse a real novel page that has no chapter index yet", () => {
    const n = parseNovelPage(
      doc(`<article class="kol-series-editorial"><h1 class="kol-series-editorial__title">رواية</h1></article>`),
      BASE,
      NOVEL_URL,
      createTestHost(),
    );
    expect(n.title).toBe("رواية");
    expect(n.volumes).toEqual([]);
  });
});

describe("parseVolumeChapterRows / numberChapters", () => {
  it("reads one page of rows newest first, titled 'الفصل N - name'", () => {
    const rows = parseVolumeChapterRows(volumeDoc(volumePages[0]), BASE);
    expect(rows).toHaveLength(50);
    expect(rows[0]).toEqual({
      url: "https://kolnovel.com/shaag24%d8%ae%d8%a7%d9%84%d8%af-%d8%a7%d9%84%d8%b9%d9%88%d8%a7%d9%84%d9%85-%d8%a7%d9%84%d8%aa%d8%b3%d8%b9%d8%a9z435ggye-300959/",
      title: "الفصل 101 - دولة الشعب",
    });
  });

  it("drops a chapter number that is not a number rather than printing 'الفصل 1INFO1'", () => {
    const rows = parseVolumeChapterRows(volumeDoc(volumeInfoJson), BASE);
    expect(rows.map((r) => r.title)).toEqual(["بنيات التدريب", "مستويات التدريب"]);
  });

  it("skips a row still under a release countdown", () => {
    // SYNTHETIC: no scheduled chapter was listed when the fixtures were
    // captured. The marker is the one series-chapters.js drives its timers off.
    const rows = parseVolumeChapterRows(
      doc(
        `<li data-chapter-id="2"><a href="/ch-2/"><span data-kol-chapter-number="2"></span>` +
          `<span class="chapter-countdown" data-kol-countdown-end="1"></span></a></li>` +
          `<li data-chapter-id="1"><a href="/ch-1/"><span data-kol-chapter-number="1"></span></a></li>`,
      ),
      BASE,
    );
    expect(rows).toEqual([{ url: "https://kolnovel.com/ch-1/", title: "الفصل 1" }]);
  });

  it("names a title-less chapter by the id it actually gets, not its position", () => {
    const chapters = numberChapters(
      [
        { url: "https://kolnovel.com/a/", title: "" },
        { url: "https://kolnovel.com/b/", title: "Real" },
      ],
      41,
      createTestHost(),
    );
    expect(chapters).toEqual([
      { id: 41, title: "41 - No Title", url: "https://kolnovel.com/a/", lines: [] },
      { id: 42, title: "Real", url: "https://kolnovel.com/b/", lines: [] },
    ]);
  });
});


// ── chapter-body extraction (static HTML) ───────────────────────────────────
//
// The highest-consequence, most theme-fragile code in this extension: over-
// strip and a user's imported book is silently truncated, under-strip and
// piracy/ad boilerplate is baked into their EPUB. tests/fixtures/chapter.html
// exercises every decoy form parseChapterContent's helpers claim to handle
// (see the file's "chapter-body extraction" header comment and each
// function's own doc comment in ../src/theme.ts): a rotating hidden CSS
// class, a hidden inline style, and an embedded ad phrase inside otherwise
// real text — alongside real-looking chapter paragraphs and a real image.

describe("parseChapterContent", () => {
  it("keeps every real paragraph and image, in order, strips the ad phrase out of a real paragraph, and drops every decoy paragraph/image entirely", () => {
    const doc = new DOMParser().parseFromString(chapterHtml, "text/html");
    const lines = parseChapterContent(doc, "https://kolnovel.com");

    expect(lines).toEqual([
      { type: "text", content: "مرحبا بكم في الفصل الأول من القصة." },
      // The paragraph with the hidden rotating CSS class and the
      // paragraph with the hidden inline style are both absent entirely
      // — proof they were dropped, not merely reordered.
      //
      // This paragraph's ad-boilerplate phrase is stripped out (via
      // stripIgnored's wildcard pattern) while the real text on either
      // side of it survives — the paragraph itself is real and must not
      // be dropped just because it contains the phrase.
      { type: "text", content: "بداية الفقرة الحقيقية. نهاية الفقرة الحقيقية." },
      // Repeated verbatim in the fixture; only one copy survives (dedup).
      { type: "text", content: "الفصل مستمر وسيتحدث البطل عن رحلته." },
      // The real image is repeated once (dedup keeps one copy); the
      // wp-post-image avatar and the /ads/ banner are both decorative
      // and excluded entirely.
      { type: "image", content: "https://kolnovel.com/wp-content/uploads/2024/02/scene.jpg" },
    ]);
  });

  it("falls back to .entry-content when neither #kol_content nor .epcontent is present", () => {
    const doc = new DOMParser().parseFromString(
      `<div class="entry-content"><p>نص الفصل هنا.</p></div>`,
      "text/html",
    );
    expect(parseChapterContent(doc, "https://kolnovel.com")).toEqual([
      { type: "text", content: "نص الفصل هنا." },
    ]);
  });

  // SYNTHETIC. chapter-live.html shows no loss from either dedup strategy
  // (163 kept paragraphs, 163 distinct), so the live capture cannot tell
  // them apart — this snippet is what pins the difference. The failure it
  // guards against is not hypothetical: extensions/cenele hit it on a real
  // capture, where a whole-chapter Set collapsed three unrelated one-word
  // paragraphs into one and deleted two real lines from an imported book
  // (extensions/cenele/README.md records it).
  it("dedups only against the immediately-preceding line of the same type, never the whole chapter", () => {
    const doc = new DOMParser().parseFromString(
      `<div class="epcontent">
        <p>لكن…</p>
        <p>لكن…</p>
        <p>سطر حقيقي في منتصف الفصل.</p>
        <p>لكن…</p>
        <img src="https://kolnovel.com/wp-content/uploads/2024/02/a.jpg">
        <img src="https://kolnovel.com/wp-content/uploads/2024/02/a.jpg">
        <img src="https://kolnovel.com/wp-content/uploads/2024/02/b.jpg">
        <img src="https://kolnovel.com/wp-content/uploads/2024/02/a.jpg">
      </div>`,
      "text/html",
    );

    expect(parseChapterContent(doc, "https://kolnovel.com")).toEqual([
      // Back-to-back repeat: one copy survives.
      { type: "text", content: "لكن…" },
      { type: "text", content: "سطر حقيقي في منتصف الفصل." },
      // The SAME text again, now separated by a real line — this one must
      // survive. A whole-chapter Set drops it, silently.
      { type: "text", content: "لكن…" },
      { type: "image", content: "https://kolnovel.com/wp-content/uploads/2024/02/a.jpg" },
      { type: "image", content: "https://kolnovel.com/wp-content/uploads/2024/02/b.jpg" },
      { type: "image", content: "https://kolnovel.com/wp-content/uploads/2024/02/a.jpg" },
    ]);
  });
});

describe("parseChapterContent — unclosed <p> tags", () => {
  // chapter-starless.html opens its body with `<p ...>` + newline +
  // `<p ...>text</p>`, many times over. Under a parser that nests the
  // unclosed paragraph instead of closing it (happy-dom does), reading each
  // <p>'s full textContent repeated the entire rest of the chapter inside
  // every unclosed one: 132 lines and 337,043 characters for a 10 KB chapter.
  it("reads each paragraph's own text once", () => {
    const lines = parseChapterContent(doc(starlessChapterHtml), BASE);
    const text = lines.filter((l) => l.type === "text").map((l) => l.content);
    expect(text[0]).toMatch(/^كانت \{دُونغـهَاي\} تتلهب حرارة كفرن عتيق/);
    expect(text[1]).toMatch(/^الشمس، ككرة نارية هائلة/);
    expect(new Set(text).size).toBe(text.length);
    expect(text.reduce((n, t) => n + t.length, 0)).toBeLessThan(15_000);
  });
});

describe("collectHiddenClasses", () => {
  it("extracts a class name from a rule matching the hidden-paragraph CSS signature", () => {
    const doc = new DOMParser().parseFromString(
      `<style>.abcdef0123456789abcdef01 { position:absolute; left:-99999px; width:0.1px; height:0.1px; opacity:0; }</style>`,
      "text/html",
    );
    expect(collectHiddenClasses(doc)).toEqual(new Set(["abcdef0123456789abcdef01"]));
  });

  it("ignores a rule that is missing one of the three required properties", () => {
    // Has -99999px and opacity:0, but not 0.1px — an ordinary
    // off-screen-but-visible-size utility class, not the decoy signature.
    const doc = new DOMParser().parseFromString(
      `<style>.abcdef0123456789abcdef01 { position:absolute; left:-99999px; opacity:0; }</style>`,
      "text/html",
    );
    expect(collectHiddenClasses(doc)).toEqual(new Set());
  });

  it("ignores a class name shorter than the 20-hex-character threshold", () => {
    const doc = new DOMParser().parseFromString(
      `<style>.abc123 { position:absolute; left:-99999px; width:0.1px; opacity:0; }</style>`,
      "text/html",
    );
    expect(collectHiddenClasses(doc)).toEqual(new Set());
  });

  it("returns an empty set when the document has no <style> elements at all", () => {
    const doc = new DOMParser().parseFromString(`<p>no styles here</p>`, "text/html");
    expect(collectHiddenClasses(doc)).toEqual(new Set());
  });

  it("merges hidden classes declared across multiple <style> blocks", () => {
    const doc = new DOMParser().parseFromString(
      `<style>.aaaaaaaaaaaaaaaaaaaaaaaa { position:absolute; left:-99999px; width:0.1px; opacity:0; }</style>
       <style>.bbbbbbbbbbbbbbbbbbbbbbbb { position:absolute; left:-99999px; width:0.1px; opacity:0; }</style>`,
      "text/html",
    );
    expect(collectHiddenClasses(doc)).toEqual(
      new Set(["aaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbb"]),
    );
  });
});

// ── end-to-end: drives the extension through the public contract only ──────
//
// The blocks above prove the parser functions are correct in isolation. These
// prove the extension wires them to the right requests through `host.fetch`:
// the search URLs, and the novel page → chapter-list action round trips that
// lazy volumes depend on.
describe("createSource (end-to-end via createTestHost)", () => {
  type Call = { url: string; method: string; body?: string };
  const page1Url = "https://kolnovel.com/?s=%D8%B3%D9%8A%D8%AF";
  const page2Url = "https://kolnovel.com/page/2/?s=%D8%B3%D9%8A%D8%AF";

  it("search() requests /?s= for page 1 and /page/N/?s= after it", async () => {
    const calls: Call[] = [];
    const source = createSource(
      createTestHost({ responses: { [page1Url]: searchHtml, [page2Url]: searchPage2Html }, calls }),
    );

    const first = await source.search("سيد");
    const second = await source.search("سيد", 2);

    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", page1Url],
      ["GET", page2Url],
    ]);
    expect([first.page, first.cards.length, first.hasMore]).toEqual([1, 20, true]);
    expect([second.page, second.cards.length, second.hasMore]).toEqual([2, 1, false]);
  });

  it("search() returns a hollow result without fetching anything when the query is empty", async () => {
    // Nothing to search for is a real, correct empty result — not a reason
    // to fetch the site's own "no search term" page. Every extension in
    // this repo answers an empty query the same way.
    const calls: Call[] = [];
    const source = createSource(createTestHost({ calls }));
    expect(await source.search("   ")).toEqual({
      cards: [],
      hasMore: false,
      query: "",
      page: 1,
    });
    expect(calls).toHaveLength(0);
  });

  const singleVolumeResponses = {
    [SINGLE_VOLUME_URL]: singleVolumeNovelHtml,
    "&page=1": volumePages[0],
    "&page=2": volumePages[1],
    "&page=3": volumePages[2],
  };

  it("declares lazy volumes and fills one from every page of the chapter-list action, oldest first", async () => {
    const calls: Call[] = [];
    const source = createSource(createTestHost({ responses: singleVolumeResponses, calls }));
    expect(source.hasLazyVolumes).toBe(true);

    const novel = await source.getNovel(SINGLE_VOLUME_URL);
    expect(novel.volumes).toEqual([{ id: 1, title: "Volume 1", chapters: [], chapterCount: 101, key: "Volume 1" }]);
    const chapters = await source.getVolumeChapters!(SINGLE_VOLUME_URL, novel.volumes[0]);

    expect(chapters).toHaveLength(101);
    expect(chapters.map((c) => c.id)).toEqual(Array.from({ length: 101 }, (_, i) => i + 1));
    expect(new Set(chapters.map((c) => c.url)).size).toBe(101);
    expect(chapters[0]).toMatchObject({
      id: 1,
      title: "الفصل 1 - لقد رأيتُ الخالديين",
      url: "https://kolnovel.com/shaag24%d8%ae%d8%a7%d9%84%d8%af-%d8%a7%d9%84%d8%b9%d9%88%d8%a7%d9%84%d9%85-%d8%a7%d9%84%d8%aa%d8%b3%d8%b9%d8%a9z435ggye-276407/",
    });
    expect(chapters[100].title).toBe("الفصل 101 - دولة الشعب");

    // The novel page once (getNovel), then pages 1-3 of the volume with the
    // nonce and series id the page printed. No second novel-page fetch: the
    // index getNovel parsed is reused.
    expect(calls.map((c) => c.url)).toEqual([
      SINGLE_VOLUME_URL,
      ...[1, 2, 3].map(
        (p) => `${VOLUME_ACTION}&nonce=7bc0f0fe46&series_id=276400&volume=Volume+1&page=${p}`,
      ),
    ]);
  });

  it("rebuilds its index from the novel page when called cold, as the app does from a saved snapshot", async () => {
    const calls: Call[] = [];
    const source = createSource(createTestHost({ responses: singleVolumeResponses, calls }));
    const volume = { id: 1, title: "Volume 1", chapters: [], chapterCount: 101, key: "Volume 1" };

    const chapters = await source.getVolumeChapters!(SINGLE_VOLUME_URL, volume);

    expect(chapters).toHaveLength(101);
    expect(calls.filter((c) => c.url === SINGLE_VOLUME_URL)).toHaveLength(1);
  });

  it("numbers a volume after every older volume's count, and finds it by key, not by id", async () => {
    const source = createSource(
      createTestHost({
        responses: {
          [NOVEL_URL]: novelHtml,
          "&volume=INFO&page=1": volumeInfoJson,
          // SYNTHETIC pairing: the INFO volume's captured rows served as the
          // second-oldest volume's, to check the id offset without a
          // fixture for every volume.
          [`&volume=${encodeURIComponent("فصل خاص: صور الشخصيات").replace(/%20/g, "+")}&page=1`]: volumeInfoJson,
        },
      }),
    );
    const { volumes } = await source.getNovel(NOVEL_URL);

    const info = await source.getVolumeChapters!(NOVEL_URL, { ...volumes[0], id: 99 });
    expect(info.map((c) => [c.id, c.title])).toEqual([
      [1, "مستويات التدريب"],
      [2, "بنيات التدريب"],
    ]);
    const second = await source.getVolumeChapters!(NOVEL_URL, volumes[1]);
    expect(second.map((c) => c.id)).toEqual([3, 4]);
  });

  it("reloads the novel page for a fresh nonce once when the endpoint refuses the cached one", async () => {
    const calls: Call[] = [];
    const base = createTestHost({ responses: singleVolumeResponses, calls });
    let refused = false;
    const host: SourceHost = {
      ...base,
      async fetch(url, opts) {
        // The first chapter-list request gets what the live site sends for a
        // wrong nonce: HTTP 403 with the bare body `-1`.
        if (url.startsWith(VOLUME_ACTION) && !refused) {
          refused = true;
          calls.push({ url, method: "GET" });
          return { status: 403, text: badNonceBody, headers: {} };
        }
        return base.fetch(url, opts);
      },
    };
    const source = createSource(host);
    const novel = await source.getNovel(SINGLE_VOLUME_URL);

    const chapters = await source.getVolumeChapters!(SINGLE_VOLUME_URL, novel.volumes[0]);

    expect(chapters).toHaveLength(101);
    expect(calls.filter((c) => c.url === SINGLE_VOLUME_URL)).toHaveLength(2);
  });

  it("throws, naming the volume, when the endpoint answers with something unexpected", async () => {
    const source = createSource(
      createTestHost({ responses: { [SINGLE_VOLUME_URL]: singleVolumeNovelHtml, "&page=1": "<html>oops</html>" } }),
    );
    const novel = await source.getNovel(SINGLE_VOLUME_URL);
    await expect(source.getVolumeChapters!(SINGLE_VOLUME_URL, novel.volumes[0])).rejects.toThrow(
      /^kolnovel: the chapter-list endpoint returned an unexpected response for series 276400, volume "Volume 1", page 1/,
    );
  });

  it("prefixes a thrown error with the manifest id, not a display name", () => {
    expect(() =>
      parseNovelPage(doc("<html><body></body></html>"), BASE, "https://kolnovel.com/series/x/", createTestHost()),
    ).toThrow(new RegExp(`^${MANIFEST_ID}: `));
  });

  it("canHandle() accepts every KolNovel host and rejects other domains", () => {
    const source = createSource(createTestHost());
    // Exactly one extension must own every host either of the two pre-merge
    // extensions ever matched, so saved library URLs keep resolving.
    expect(source.canHandle("https://kolnovel.com/series/silent-shadows/")).toBe(true);
    expect(source.canHandle("https://www.kolnovel.com/series/silent-shadows/")).toBe(true);
    expect(source.canHandle("https://free.kolnovel.com/series/silent-shadows/")).toBe(true);
    expect(source.canHandle("https://kolnovel.online/series/silent-shadows/")).toBe(true);
    expect(source.canHandle("https://example.com/")).toBe(false);
  });
});

// ── the PDF chapter path ────────────────────────────────────────────────────
//
// Until now this whole branch had no test at all: the block above covers
// `search` and `canHandle`, and `parseChapterContent` is exercised as a pure
// function, but nothing drove `getChapterContent` — so the HTML-vs-PDF
// decision, the token request, all of its failure arms, the `%PDF` guard and
// `resolveImage` were shipped untested (and are in the published bundle:
// `grep -c ts_ln_dl_url dist/kolnovel/index.js` → 1).
//
// Fixture provenance, since it matters for what these tests actually prove.
// Captured from the live site on 2026-09-18 and committed unedited:
//   - chapter-live.html          a real chapter page (201 KB, unstripped)
//   - pdf-token.json             POST post_id=293246      → error 0 + absolute url
//   - pdf-token-refused.json     POST post_id= (empty)    → error 403
//   - pdf-token-relative-url.json POST post_id=999999999  → error 0 + RELATIVE url
//   - pdf-loader.html            GET the un-tokenized /pdf/ path → an HTML loader
// Synthesised here, and flagged as such where used: the empty-body chapter
// page (the live site serves no PDF-only chapter I could reach), a
// `{"error":0}` response with the url key absent, a non-JSON body, and the
// `%PDF` bytes themselves — real PDF bytes are not needed because
// `host.pdf.extractChapter` is a host capability and is faked here.

const tokenJson = readFileSync(join(FIXTURES_DIR, "pdf-token.json"), "utf8");
const tokenRefusedJson = readFileSync(join(FIXTURES_DIR, "pdf-token-refused.json"), "utf8");
const tokenRelativeJson = readFileSync(join(FIXTURES_DIR, "pdf-token-relative-url.json"), "utf8");
const loaderHtml = readFileSync(join(FIXTURES_DIR, "pdf-loader.html"), "utf8");
const liveChapterHtml = readFileSync(join(FIXTURES_DIR, "chapter-live.html"), "utf8");

const CHAPTER_URL = "https://kolnovel.com/shaag24the-authors-povz435ggye-293246/";
const TOKEN_URL = "https://kolnovel.com/shaag24the-authors-povz435ggye-293246/pdf/?tspdftoken=0302667741";
const AJAX_URL = "https://kolnovel.com/wp-admin/admin-ajax.php";

/** A chapter page whose body element exists but is empty — the shape that
 *  sends `getChapterContent` to the PDF flow. SYNTHETIC.
 *
 *  The paragraph outside `.epcontent` is load-bearing, not decoration: it
 *  proves the zero-line result came from reading the chapter BODY and finding
 *  it empty, not from a page that happened to contain no text anywhere. Drop
 *  the `.epcontent` wrapper and `parseChapterContent` falls through to
 *  `doc.body`, picks that paragraph up, and the PDF branch under test would
 *  become unreachable while every assertion below still passed. */
const EMPTY_BODY_CHAPTER =
  `<div class="postbody"><p>nav text that is not the chapter body</p>` +
  `<div id="kol_content" class="epcontent entry-content"></div></div>`;

const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n% fake body, never parsed here\n");

type Call = { url: string; method: string; body?: string };

/** `createTestHost`'s `pdf.extractChapter` throws by design ("pass a fake host
 *  explicitly if your test needs it"). This is that fake: the real capability
 *  is pdf.js inside the reader, and what this extension owes the contract is
 *  only that it feeds it the right bytes and handles what comes back. */
function hostWithPdf(
  options: {
    responses?: Record<string, string>;
    byteResponses?: Record<string, Uint8Array>;
    calls?: Call[];
  },
  extractChapter: SourceHost["pdf"]["extractChapter"],
): SourceHost {
  return { ...createTestHost(options), pdf: { extractChapter } };
}

const chapterStub = (url = CHAPTER_URL) => ({ id: 7, title: "c", url, lines: [] });

/** Fails the test if called — proves a code path was NOT taken. */
const neverExtract: SourceHost["pdf"]["extractChapter"] = async () => {
  throw new Error("pdf.extractChapter must not be called on the HTML path");
};

describe("getChapterContent — HTML first", () => {
  it("returns the live page's parsed body and never touches the token endpoint", async () => {
    const calls: Call[] = [];
    const host = hostWithPdf({ responses: { [CHAPTER_URL]: liveChapterHtml }, calls }, neverExtract);

    const lines = await createSource(host).getChapterContent(chapterStub());

    // Structural only — the fixture is a real page and its prose is not this
    // test's business: there is a body, it is substantial, every line is a
    // known type, and no line is blank.
    expect(lines.length).toBeGreaterThan(20);
    // The exact type set this capture yields. `new Set(...).size > 0`, which
    // this used to assert, cannot fail once the line above has passed.
    expect(new Set(lines.map((l) => l.type))).toEqual(new Set(["text"]));
    expect(lines.every((l) => l.content.trim().length > 0)).toBe(true);

    // The point of the test: exactly one request, a GET of the chapter page,
    // and nothing sent to admin-ajax.php. A regression that always ran the
    // token flow would still return lines — only the call log catches it.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: CHAPTER_URL, method: "GET" });
    expect(calls.some((c) => c.url.includes("admin-ajax.php"))).toBe(false);
  });
});

describe("getChapterContent — PDF fallback", () => {
  it("sends the permalink's post id and downloads the exact url the endpoint returned", async () => {
    const calls: Call[] = [];
    const host = hostWithPdf(
      {
        responses: { [CHAPTER_URL]: EMPTY_BODY_CHAPTER, [AJAX_URL]: tokenJson },
        byteResponses: { [TOKEN_URL]: PDF_BYTES },
        calls,
      },
      async () => [{ type: "text", content: "line from the pdf" }],
    );

    const lines = await createSource(host).getChapterContent(chapterStub());
    expect(lines).toEqual([{ type: "text", content: "line from the pdf" }]);

    expect(calls).toHaveLength(3);
    // The token request: method, endpoint and the exact form body. The post id
    // is asserted against a literal, not against extractPostId's own output —
    // asserting it against the function that produced it would pass for any id
    // the regex happened to return, including a wrong one.
    expect(calls[1]).toEqual({
      url: AJAX_URL,
      method: "POST",
      body: "action=ts_ln_dl_url&post_id=293246",
    });
    // The download: the RECORDED url, not the fixture key. createTestHost
    // matches fixtures by substring, so a source that fetched a truncated or
    // differently-built url would still be served these bytes and still pass
    // every other assertion here.
    expect(calls[2]).toMatchObject({ url: TOKEN_URL, method: "GET" });
  });

  it("resolves a root-relative token url against the site origin before downloading", async () => {
    // Captured live: for a post id the site does not recognise it answers
    // error 0 with "/pdf/?tspdftoken=…" — success, but a relative url with the
    // novel segment missing. Passing that through would hand host.fetchBytes a
    // relative url; resolving it yields a real absolute one.
    const calls: Call[] = [];
    const resolved = "https://kolnovel.com/pdf/?tspdftoken=0ed7ff4d7a";
    const host = hostWithPdf(
      {
        responses: { [CHAPTER_URL]: EMPTY_BODY_CHAPTER, [AJAX_URL]: tokenRelativeJson },
        byteResponses: { [resolved]: PDF_BYTES },
        calls,
      },
      async () => [{ type: "text", content: "x" }],
    );

    await createSource(host).getChapterContent(chapterStub());

    expect(calls[2].url).toBe(resolved);
    expect(calls[2].url.startsWith("https://kolnovel.com/")).toBe(true);
  });

  it("throws naming the chapter url when the PDF extracts to zero lines", async () => {
    // The hollow-chapter defect. Returning [] here imports a chapter the
    // reader draws as a blank page, indistinguishable from a real empty one
    // and silent at every layer above this call.
    const host = hostWithPdf(
      {
        responses: { [CHAPTER_URL]: EMPTY_BODY_CHAPTER, [AJAX_URL]: tokenJson },
        byteResponses: { [TOKEN_URL]: PDF_BYTES },
      },
      async () => [],
    );

    await expect(createSource(host).getChapterContent(chapterStub())).rejects.toThrow(
      new RegExp(`extracted no content for ${CHAPTER_URL.replace(/[/?]/g, "\\$&")}`),
    );
  });

  it("round-trips a minted image ref through resolveImage, and answers null for an unknown ref", async () => {
    const image = { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png", extension: "png" };
    const host = hostWithPdf(
      {
        responses: { [CHAPTER_URL]: EMPTY_BODY_CHAPTER, [AJAX_URL]: tokenJson },
        byteResponses: { [TOKEN_URL]: PDF_BYTES },
      },
      async (_bytes, options) => [
        { type: "image", content: options.mintImageRef(image) },
        { type: "image", content: options.mintImageRef(image) },
      ],
    );
    const source = createSource(host);

    const lines = await source.getChapterContent(chapterStub());

    // Refs carry the post id and a per-chapter counter, and are distinct.
    expect(lines.map((l) => l.content)).toEqual([
      "kolnovel:img:293246:1",
      "kolnovel:img:293246:2",
    ]);
    expect(await source.resolveImage!("kolnovel:img:293246:1")).toBe(image);
    expect(await source.resolveImage!("kolnovel:img:293246:9")).toBeNull();
  });

  it("drops the previous chapter's image refs when the next PDF chapter is extracted", async () => {
    // imageStore used to be cleared only in getNovel. A reader working
    // through a snapshot never calls getNovel, so the map grew for the whole
    // session, holding every image of every PDF chapter opened. The observable
    // consequence of the fix: a ref from the previous call no longer resolves.
    const image = { bytes: new Uint8Array([1]), mimeType: "image/png", extension: "png" };
    const otherChapter = "https://kolnovel.com/another-chapter-293247/";
    const otherToken = "https://kolnovel.com/another-chapter-293247/pdf/?tspdftoken=abc";
    const host = hostWithPdf(
      {
        responses: {
          [CHAPTER_URL]: EMPTY_BODY_CHAPTER,
          [otherChapter]: EMPTY_BODY_CHAPTER,
          [AJAX_URL]: tokenJson,
        },
        byteResponses: { [TOKEN_URL]: PDF_BYTES, [otherToken]: PDF_BYTES },
      },
      async (_bytes, options) => [{ type: "image", content: options.mintImageRef(image) }],
    );
    const source = createSource(host);

    await source.getChapterContent(chapterStub());
    expect(await source.resolveImage!("kolnovel:img:293246:1")).toBe(image);

    // Same post id in the ref because tokenJson is the canned reply for both;
    // what matters is that the FIRST call's entry is gone and the second
    // call's is present.
    await source.getChapterContent(chapterStub(otherChapter));
    expect(await source.resolveImage!("kolnovel:img:293247:1")).toBe(image);
    expect(await source.resolveImage!("kolnovel:img:293246:1")).toBeNull();
  });

  it("throws when the permalink carries no post id, without calling the endpoint", async () => {
    const calls: Call[] = [];
    const noId = "https://kolnovel.com/some-chapter/";
    const host = hostWithPdf(
      { responses: { [noId]: EMPTY_BODY_CHAPTER }, calls },
      neverExtract,
    );

    await expect(createSource(host).getChapterContent(chapterStub(noId))).rejects.toThrow(
      /couldn't find a post id in chapter URL: https:\/\/kolnovel\.com\/some-chapter\//,
    );
    expect(calls.some((c) => c.url.includes("admin-ajax.php"))).toBe(false);
  });
});

describe("the token flow's failures are reported separately", () => {
  const run = async (ajaxBody: string, bytes?: Uint8Array) => {
    const host = hostWithPdf(
      {
        responses: { [CHAPTER_URL]: EMPTY_BODY_CHAPTER, [AJAX_URL]: ajaxBody },
        byteResponses: bytes ? { [TOKEN_URL]: bytes } : {},
      },
      neverExtract,
    );
    return createSource(host)
      .getChapterContent(chapterStub())
      .then(
        () => "resolved — expected a throw",
        (e: Error) => e.message,
      );
  };

  // Each arm is pinned by what it says AND by what it does not say. Asserting
  // only "it threw" would pass against the single collapsed "members-only or
  // removed" message this replaced, which is the exact regression to prevent:
  // three causes, three fixes, three messages.
  it("names a non-zero error code and does not guess at a cause", async () => {
    const message = await run(tokenRefusedJson); // captured: {"error":403,"url":""}
    expect(message).toContain("refused post 293246");
    expect(message).toContain("error code 403");
    expect(message).toContain(CHAPTER_URL);
    expect(message).not.toContain("returned no download url");
    expect(message).not.toContain("non-JSON");
  });

  it("distinguishes a success response that carries no url", async () => {
    const message = await run('{"error":0}'); // SYNTHETIC — see the block header
    expect(message).toContain("reported success for post 293246");
    expect(message).toContain("returned no download url");
    expect(message).not.toContain("error code");
    expect(message).not.toContain("non-JSON");
  });

  it("distinguishes a non-JSON body and reports the status", async () => {
    const message = await run("<html>a WordPress error page</html>"); // SYNTHETIC
    expect(message).toContain("non-JSON");
    expect(message).toContain("HTTP 200");
    expect(message).toContain(CHAPTER_URL);
    expect(message).not.toContain("error code");
    expect(message).not.toContain("returned no download url");
  });

  it("distinguishes valid JSON that is not an object", async () => {
    const message = await run("null"); // SYNTHETIC — JSON.parse("null") is not a throw
    expect(message).toContain("not an object");
    expect(message).not.toContain("error code");
  });

  it("rejects the HTML loader page the un-tokenized path serves, reporting what arrived", async () => {
    // pdf-loader.html is the real body the site returns for /pdf/ with no
    // token — the case assertPdf exists for.
    const message = await run(tokenJson, new TextEncoder().encode(loaderHtml));
    expect(message).toContain("was not a PDF");
    expect(message).toContain(CHAPTER_URL);
    expect(message).toContain('starting "<html>'); // the observed bytes, not a guess
    expect(message).toContain("1153 bytes");
  });

  it("rejects an empty body without reporting it as an HTML page", async () => {
    const message = await run(tokenJson, new Uint8Array());
    expect(message).toContain("was not a PDF");
    expect(message).toContain('0 bytes starting ""');
  });
});
