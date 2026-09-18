import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import createSource from "../src/index";
import {
  collectHiddenClasses,
  parseChapterContent,
  parseHomeSections,
  parseNovelPage,
  parseSearchResults,
  parseVolumes,
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

  it("keys a section's id off the section's shape and its own 'see more' query, not its position", () => {
    // SourceSection.id is contracted to be a stable identifier useful for
    // caching. `home-${idx}` — which this used to emit, incremented only
    // for sections that SURVIVED the zero-cards filter — reindexed every
    // section below any rail that happened to render nothing that run.
    const doc = new DOMParser().parseFromString(homeHtml, "text/html");
    expect(parseHomeSections(doc, BASE, createTestHost()).map((s) => s.id)).toEqual([
      "bixbox-update",
    ]);
  });

  it("names the two singleton section shapes after the shape itself", () => {
    const card = (slug: string) =>
      `<a href="https://kolnovel.com/series/${slug}/"><img src="/c.jpg"></a>`;
    const doc = new DOMParser().parseFromString(
      `<div class="trendarea"><div class="topareatitle">رائج</div>` +
        `<div class="trendlist"><div class="thumbtr">${card("a")}</div>` +
        `<div class="trenti"><a>A</a></div></div></div>` +
        `<div class="homehot"><div class="topareatitle">ساخن</div>` +
        `<div class="hotoday"><div class="inhotoday">` +
        `<a href="https://kolnovel.com/series/b/"></a></div>` +
        `<div class="todtitle">B</div></div></div>`,
      "text/html",
    );
    expect(parseHomeSections(doc, BASE, createTestHost()).map((s) => s.id)).toEqual([
      "trending",
      "hot",
    ]);
  });

  it("keeps a .bixbox id unchanged when an earlier section renders no cards", () => {
    const bixbox = (heading: string, order: string, slug: string) =>
      `<div class="bixbox"><div class="releases"><h3>${heading}</h3>` +
      `<a class="vl" href="/series/?status=&order=${order}">See more</a></div>` +
      `<div class="listupd"><article class="bs"><div class="bsx">` +
      `<a href="https://kolnovel.com/series/${slug}/"><div class="tt">` +
      `<h4 class="ntitle">${slug}</h4></div></a></div></article></div></div>`;
    // A .bixbox that parses to zero cards — it is dropped either way; what
    // matters is that the rails after it keep their ids.
    const emptyBixbox =
      `<div class="bixbox"><div class="releases"><h3>Empty</h3></div>` +
      `<div class="listupd"></div></div>`;

    const ids = (html: string) =>
      parseHomeSections(
        new DOMParser().parseFromString(html, "text/html"),
        BASE,
        createTestHost(),
      ).map((s) => s.id);

    expect(ids(bixbox("A", "popular", "a") + bixbox("B", "update", "b"))).toEqual([
      "bixbox-popular",
      "bixbox-update",
    ]);
    expect(ids(emptyBixbox + bixbox("A", "popular", "a") + bixbox("B", "update", "b"))).toEqual([
      "bixbox-popular",
      "bixbox-update",
    ]);
  });

  it("falls back to the heading slug for a .bixbox whose 'see more' link carries no usable query", () => {
    const html =
      `<div class="bixbox"><div class="releases"><h3>Latest Updates</h3></div>` +
      `<div class="listupd"><article class="bs"><div class="bsx">` +
      `<a href="https://kolnovel.com/series/a/"><div class="tt">` +
      `<h4 class="ntitle">A</h4></div></a></div></article></div></div>`;
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(parseHomeSections(doc, BASE, createTestHost()).map((s) => s.id)).toEqual([
      "bixbox-latest-updates",
    ]);
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

// ── novel-page parsing ──────────────────────────────────────────────────────
//
// SYNTHETIC markup, not a live capture: this extension ships no novel-page
// fixture and the rule for this branch is that fixtures are captured from
// the live site, never invented — so rather than fabricate a 200 KB "live"
// page, these use the smallest markup that exercises each selector
// parseNovelPage actually reads, in the shapes ../src/theme.ts documents.
// Until now parseNovelPage had no test at all.
describe("parseNovelPage", () => {
  const NOVEL_URL = "https://kolnovel.com/series/silent-shadows/";
  const novelHtml = `
    <div class="sertobig">
      <h1 class="entry-title">سيد الظلال الصامتة</h1>
      <span class="alter">Silent Shadows</span>
      <div class="sertostat"><span>مستمرة</span></div>
      <div class="sertothumb"><img src="/wp-content/uploads/2026/07/shadows.jpg"></div>
      <div class="serl"><span class="sername">الكاتب</span><span class="serval"><a href="/author/kim/">كيم</a></span></div>
      <div class="serl"><span class="sername">النوع</span><span class="serval">: رواية كورية</span></div>
      <div class="sertogenre"><a>اكشن مغامرات</a><a>ايسيكاي</a></div>
      <div class="sersys entry-content"><p>وصف الرواية.</p><script>adsbygoogle()</script></div>
    </div>
    <div class="ts-chl-collapsible">المجلد 1</div>
    <div class="ts-chl-collapsible-content">
      <ul>
        <li><a href="/ch-2/"><span class="epl-title">الفصل 2</span></a></li>
        <li><a href="/ch-1/"><span class="epl-title">الفصل 1</span></a></li>
      </ul>
    </div>`;

  const parseNovel = (html: string) =>
    parseNovelPage(
      new DOMParser().parseFromString(html, "text/html"),
      BASE,
      NOVEL_URL,
      createTestHost(),
    );

  it("reads title, original title, status, cover, tags, description and meta rows", () => {
    const novel = parseNovel(novelHtml);
    expect(novel.title).toBe("سيد الظلال الصامتة");
    expect(novel.originalTitle).toBe("Silent Shadows");
    expect(novel.status).toBe("مستمرة");
    expect(novel.coverUrl).toBe("https://kolnovel.com/wp-content/uploads/2026/07/shadows.jpg");
    expect(novel.tags).toEqual(["اكشن مغامرات", "ايسيكاي"]);
    expect(novel.language).toBe("ar");
    expect(novel.direction).toBe("rtl");
    // The injected <script> is stripped out of the description.
    expect(novel.description).toBe("وصف الرواية.");
    expect(novel.meta).toEqual([
      { label: "الكاتب", value: "كيم", url: "https://kolnovel.com/author/kim/" },
      // The leading colon the theme renders is stripped; a row with no
      // anchor carries no url.
      { label: "النوع", value: "رواية كورية", url: undefined },
    ]);
  });

  it("lifts the author out of the meta rows", () => {
    expect(parseNovel(novelHtml).author).toBe("كيم");
  });

  it("returns chapters oldest-first, with ids running from 1", () => {
    const volumes = parseNovel(novelHtml).volumes;
    expect(volumes).toHaveLength(1);
    expect(volumes[0].chapters).toEqual([
      { id: 1, title: "الفصل 1", url: "https://kolnovel.com/ch-1/", lines: [] },
      { id: 2, title: "الفصل 2", url: "https://kolnovel.com/ch-2/", lines: [] },
    ]);
  });

  it("refuses a page with no title instead of returning a hollow SourceNovel", async () => {
    // The defect this guards: title fell back to "", tags to [] and volumes
    // to [], so an anti-bot interstitial or error page served with HTTP 200
    // produced a structurally valid, completely empty novel that imported as
    // a book with no chapters and nothing anywhere saying why.
    expect(() => parseNovel(`<html><body><h1>Attention Required</h1></body></html>`)).toThrow(
      NOVEL_URL,
    );
  });

  it("refuses a page whose title container is present but empty", () => {
    expect(() =>
      parseNovel(`<div class="sertobig"><h1 class="entry-title">  </h1></div>`),
    ).toThrow(/couldn't find a novel title/);
  });

  it("does NOT refuse a real novel page that simply has no chapters listed yet", () => {
    // Deliberately survivable: a novel the site has published but not yet
    // added chapters to is a page the site really serves, and refusing it
    // would deny the user a novel the site itself renders.
    const novel = parseNovel(`<div class="sertobig"><h1 class="entry-title">رواية جديدة</h1></div>`);
    expect(novel.title).toBe("رواية جديدة");
    expect(novel.volumes).toEqual([]);
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
