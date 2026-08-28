import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import createSource from "../src/index";
import {
  collectHiddenClasses,
  parseChapterContent,
  parseHomeSections,
  parseSearchResults,
  parseVolumes,
} from "../src/theme";
import { createTestHost } from "@riwaq/extension-api/testing";

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
const searchHtml = readFileSync(join(FIXTURES_DIR, "search.html"), "utf8");
const homeHtml = readFileSync(join(FIXTURES_DIR, "home.html"), "utf8");
const chapterHtml = readFileSync(join(FIXTURES_DIR, "chapter.html"), "utf8");

const BASE = "https://kolnovel.com";

const parse = (html: string, page = 1) =>
  parseSearchResults(new DOMParser().parseFromString(html, "text/html"), BASE, "سيد", page);

describe("parseSearchResults", () => {
  it("reads url, title, cover, excerpt and hash-stripped genres", () => {
    expect(parse(searchHtml).cards[0]).toEqual({
      url: "https://kolnovel.com/series/silent-shadows/",
      title: "سيد الظلال الصامتة",
      coverUrl: "https://kolnovel.com/wp-content/uploads/2026/07/shadows.jpg",
      subtitle: "حين يشعر العالم بأنك لا تنتمي إليه…",
      badges: ["اكشن مغامرات", "ايسيكاي"],
    });
  });

  it("reports hasMore false — KolNovel renders one page of results", () => {
    // The theme emits an empty `.pagination` block and no paged links. Any
    // true here would send a host UI to a URL that returns HTTP 500 — see
    // this extension's README.
    const html = `<div class="listupd"></div><div class="pagination"> </div>`;
    expect(parse(html).hasMore).toBe(false);
  });

  it("reports hasMore true when the theme emits a real pager", () => {
    // This is exactly why index.ts's search() overrides hasMore to false at
    // the Source level: this parser trusts the DOM, and on broad queries the
    // theme does emit a pager — but every KolNovel pagination URL returns
    // HTTP 500.
    const html =
      `<div class="listupd"></div>` +
      `<div class="pagination"><span class="page-numbers current">1</span>` +
      `<a class="page-numbers" href="#">2</a>` +
      `<a class="next page-numbers" href="#">›</a></div>`;
    expect(parse(html).hasMore).toBe(true);
  });

  it("returns no cards for an empty result set", () => {
    expect(parse('<div class="listupd"></div>').cards).toEqual([]);
  });

  it("echoes query and page", () => {
    const r = parse(searchHtml, 1);
    expect(r.query).toBe("سيد");
    expect(r.page).toBe(1);
  });
});

describe("parseHomeSections", () => {
  it("resolves a relative viewMoreUrl href to an absolute URL", () => {
    // The fixture's "view more" anchor deliberately carries a RELATIVE href
    // (`/series/?status=&order=update`), not an absolute one — that's the
    // whole point of this test. parseSectionElement resolves viewMoreUrl via
    // absoluteUrl(href, baseUrl) rather than reading the anchor's DOM `.href`
    // property, because a DOMParser-produced Document's base URL is
    // "about:blank": a relative href can't resolve against that, so `.href`
    // falls back to returning the raw, unresolved attribute string instead
    // of an absolute URL (see the README's "Home section parsing" note for
    // why). If this fixture used an absolute href instead, both the fixed
    // code and the original buggy `.href` read would produce the same
    // result, and this test would pass either way — proving nothing.
    const doc = new DOMParser().parseFromString(homeHtml, "text/html");
    const sections = parseHomeSections(doc, BASE, createTestHost());
    expect(sections).toHaveLength(1);
    expect(sections[0].viewMoreUrl).toBe("https://kolnovel.com/series/?status=&order=update");
  });
});

describe("parseVolumes", () => {
  it("labels a no-title chapter with its OWN id, not the next id (regression pin)", () => {
    // Regression test for an off-by-one: `id: runningChapterId++` (a
    // postfix increment) evaluates and assigns *before* the `title:`
    // property below it does, so passing `runningChapterId` there reads
    // the already-incremented counter — a chapter whose own `id` is 1
    // would be labelled "2 - No Title" instead of "1 - No Title".
    //
    // The theme lists chapters newest-first on the page and parseVolumes
    // reverses them to oldest-first, so the anchor written LAST here
    // (the one with no title text) ends up FIRST in the returned
    // chapters array, with id 1 — exactly the case the bug hits.
    const html = `
      <div class="ts-chl-collapsible">Volume 1</div>
      <div class="ts-chl-collapsible-content">
        <ul>
          <li><a href="https://kolnovel.com/chapter-2/">Real Chapter Title</a></li>
          <li><a href="https://kolnovel.com/chapter-1/"></a></li>
        </ul>
      </div>
    `;
    const doc = new DOMParser().parseFromString(html, "text/html");
    const volumes = parseVolumes(doc, "https://kolnovel.com/series/x/", createTestHost());

    expect(volumes).toHaveLength(1);
    const chapters = volumes[0].chapters;
    expect(chapters).toHaveLength(2);
    expect(chapters[0]).toEqual({
      id: 1,
      title: "1 - No Title",
      url: "https://kolnovel.com/chapter-1/",
      lines: [],
    });
    expect(chapters[1]).toEqual({
      id: 2,
      title: "Real Chapter Title",
      url: "https://kolnovel.com/chapter-2/",
      lines: [],
    });
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
// The block above proves the parser functions are correct in isolation. It
// does not prove the port actually works as an *extension* — that the
// default export builds a Source from a host, that `search()` wires the
// right URL through `host.fetch`, and that the result reaching the caller
// really has `hasMore: false` regardless of what's asked for. This is the
// regression test for the port and the merge itself, not just for code that
// happened to move.
describe("createSource (end-to-end via createTestHost)", () => {
  const expectedUrl = "https://kolnovel.com/?s=%D8%B3%D9%8A%D8%AF";

  it("search() requests the right URL through host.fetch and returns parsed cards", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const host = createTestHost({
      responses: { [expectedUrl]: searchHtml },
      calls,
    });
    const source = createSource(host);

    const result = await source.search("سيد");

    // The URL the source actually requested — proof the AR query was
    // encoded and routed to the one search endpoint, and that no
    // `post_type` or `paged` parameter was added.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(expectedUrl);
    expect(calls[0].method).toBe("GET");

    // The cards the caller actually gets back, end to end through the
    // Source interface — same fixture, same expected shape as
    // parseSearchResults's own unit test above.
    expect(result.query).toBe("سيد");
    expect(result.page).toBe(1);
    expect(result.hasMore).toBe(false);
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]).toEqual({
      url: "https://kolnovel.com/series/silent-shadows/",
      title: "سيد الظلال الصامتة",
      coverUrl: "https://kolnovel.com/wp-content/uploads/2026/07/shadows.jpg",
      subtitle: "حين يشعر العالم بأنك لا تنتمي إليه…",
      badges: ["اكشن مغامرات", "ايسيكاي"],
    });
  });

  it("search() ignores the page argument and always reports hasMore: false", async () => {
    // KolNovel 500s on every pagination URL (`?s=&paged=N` and `/page/N/?s=`
    // alike). Asking for page 3 must still hit the page-1 URL and must not
    // flip hasMore to true.
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const host = createTestHost({
      responses: { [expectedUrl]: searchHtml },
      calls,
    });
    const source = createSource(host);

    const result = await source.search("سيد", 3);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(expectedUrl);
    expect(result.hasMore).toBe(false);
  });

  it("canHandle() accepts every KolNovel host and rejects other domains", () => {
    const source = createSource(createTestHost());
    // The regression guard for this merge: exactly one extension must own
    // every host either of the two pre-merge extensions ever matched.
    expect(source.canHandle("https://kolnovel.com/series/silent-shadows/")).toBe(true);
    expect(source.canHandle("https://www.kolnovel.com/series/silent-shadows/")).toBe(true);
    expect(source.canHandle("https://free.kolnovel.com/series/silent-shadows/")).toBe(true);
    expect(source.canHandle("https://kolnovel.online/series/silent-shadows/")).toBe(true);
    expect(source.canHandle("https://example.com/")).toBe(false);
  });
});
