import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import createSource, {
  extractChapterLines,
  extractNovelConfig,
  hasHiddenStyle,
  isDecoyElement,
  looksLikePiracyDecoy,
  parseHomeSections,
  parseNovelPage,
  searchUrl,
  parseSearchPage,
} from "../src/index";
import { parseHtml } from "@riwaq/extension-api";
import { createTestHost } from "@riwaq/extension-api/testing";

// Deliberately not `readFileSync(new URL("./fixtures/novel.html", import.meta.url), ...)`:
// this suite runs under `environment: "happy-dom"` (see vitest.config.ts), and
// happy-dom's patched global `URL` silently resolves a *relative* two-argument
// `new URL(href, base)` against its fake `window.location` instead of the given
// file: base — reproduced here even though this file is itself a vitest entry
// module, not just an imported one (see scripts/build.ts's REPO_ROOT comment for
// the same failure mode in a different module). `fileURLToPath` on this file's
// own `import.meta.url` (no relative resolution involved) plus plain path-segment
// arithmetic sidesteps it entirely.
const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");
const novelHtml = readFileSync(join(FIXTURES_DIR, "novel.html"), "utf8");
const searchHtml = readFileSync(join(FIXTURES_DIR, "search.html"), "utf8");
const chapterHtml = readFileSync(join(FIXTURES_DIR, "chapter.html"), "utf8");
const homeHtml = readFileSync(join(FIXTURES_DIR, "home.html"), "utf8");

describe("extractNovelConfig", () => {
  it("reads postId and chaptersNonce from nhvNovelV2", () => {
    expect(extractNovelConfig(novelHtml)).toEqual({
      postId: "32235",
      chaptersNonce: "6d7f45aa72",
    });
  });

  it("prefers chaptersNonce over the section nonce", () => {
    // nhvNovelV2.nonce is 0367ecdfde and belongs to nhv_novel_v2_section,
    // NOT to the chapters AJAX. Picking it would 403 every chapter fetch.
    expect(extractNovelConfig(novelHtml)?.chaptersNonce).not.toBe("0367ecdfde");
  });

  it("returns null when the config global is absent", () => {
    expect(extractNovelConfig("<html><body>no config</body></html>")).toBeNull();
  });

  it("returns null when chaptersNonce is missing", () => {
    const html = `<script>var nhvNovelV2 = {"postId":"1","nonce":"abc"};</script>`;
    expect(extractNovelConfig(html)).toBeNull();
  });
});

const parse = () =>
  parseNovelPage(
    new DOMParser().parseFromString(novelHtml, "text/html"),
    "https://cenele.com/cont/pursuit/",
  );

describe("parseNovelPage", () => {
  it("reads title, original title and cover", () => {
    const n = parse();
    expect(n.title).toBe("السعي وراء الحقيقة");
    expect(n.originalTitle).toBe("Pursuit of the Truth");
    expect(n.coverUrl).toBe(
      "https://cenele.com/wp-content/uploads/2021/12/cover-768x1024.webp",
    );
  });

  it("keeps genres and tags as separate lists", () => {
    const n = parse();
    expect(n.tags).toEqual([
      "أكشن", "بالغ", "زيانشيا", "غموض", "فنون قتالية", "للكبار", "مأساة", "مظلمة", "نفسي",
      "إنتقال العالم", "الانتقال الزمني", "الانتقام", "الزراعة", "الشخصية لا ترحم", "الكيمياء", "الوقت القديم", "تطور شخصية", "خلفية عائلة غامضة", "داو", "غدر الأحباء", "من ضعيف إلى قوي",
    ]);
  });

  it("reads the site's own status text, which a host UI renders verbatim", () => {
    // SourceNovel.status is a display field rendered verbatim as a badge
    // (see the doc comment on SourceNovel in @riwaq/extension-api), so this
    // must stay the site's Arabic string — normalizing it to "ongoing"
    // would print English into an Arabic UI.
    expect(parse().status).toBe("مستمرة");
  });

  it("builds label/value meta rows and links them", () => {
    const n = parse();
    expect(n.meta).toContainEqual({ label: "النوع", value: "صينية" });
    expect(n.meta).toContainEqual({
      label: "المؤلف",
      value: "Er Gen",
      url: "https://cenele.com/cont-author/er-gen/",
    });
  });

  it("lifts the author out of the meta rows", () => {
    expect(parse().author).toBe("Er Gen");
  });

  it("reads the synopsis", () => {
    expect(parse().description).toContain("سجن أبدي");
  });

  it("excludes heading boilerplate from the synopsis", () => {
    // The synopsis container holds an <h2> (title repeated) and trailing
    // <h3> (promotional copy). These must not appear in the stored description.
    const n = parse();
    expect(n.description).not.toContain("قصة رواية السعي وراء الحقيقة");
    expect(n.description).not.toContain("الكتاب الثاني في سلسلة إير جين");
    // The actual paragraph content should still be present
    expect(n.description).toContain("سجن أبدي");
  });

  it("carries the chapter credentials through", () => {
    const n = parse();
    expect(n.mangaId).toBe("32235");
    expect(n.chaptersNonce).toBe("6d7f45aa72");
  });

  it("throws a page-identifying error when the config is missing", () => {
    const doc = new DOMParser().parseFromString(
      "<html><body>nope</body></html>", "text/html");
    expect(() => parseNovelPage(doc, "https://cenele.com/cont/x/")).toThrow(
      /https:\/\/cenele\.com\/cont\/x\//,
    );
  });
});

describe("searchUrl", () => {
  it("omits the /page/ segment on page 1", () => {
    expect(searchUrl("سيد", 1)).toBe(
      "https://cenele.com/?s=%D8%B3%D9%8A%D8%AF&post_type=wp-manga",
    );
  });

  it("uses the /page/N/ form beyond page 1", () => {
    expect(searchUrl("سيد", 3)).toBe(
      "https://cenele.com/page/3/?s=%D8%B3%D9%8A%D8%AF&post_type=wp-manga",
    );
  });

  it("clamps non-positive pages to 1", () => {
    expect(searchUrl("x", 0)).toBe(
      "https://cenele.com/?s=x&post_type=wp-manga",
    );
  });
});

describe("parseSearchPage", () => {
  const parsed = () =>
    parseSearchPage(
      new DOMParser().parseFromString(searchHtml, "text/html"),
      "سيد",
      1,
    );

  it("returns one card per result row", () => {
    expect(parsed().cards).toHaveLength(2);
  });

  it("reads url, title, cover, original title and genres", () => {
    expect(parsed().cards[0]).toEqual({
      url: "https://cenele.com/cont/lord-of-wishes/",
      title: "سيد التمني",
      coverUrl:
        "https://cenele.com/wp-content/uploads/2026/06/wishes-193x278.jpg",
      subtitle: "رواية Lord of Wishes",
      badges: ["أكشن", "فانتازيا"],
    });
  });

  it("omits optional fields a row doesn't carry", () => {
    const second = parsed().cards[1];
    expect(second.subtitle).toBeUndefined();
    expect(second.badges).toBeUndefined();
  });

  it("reports hasMore from the older-posts link", () => {
    expect(parsed().hasMore).toBe(true);
  });

  it("reports hasMore false when there is no older-posts link", () => {
    const doc = new DOMParser().parseFromString(
      `<div class="row c-tabs-item__content">
         <div class="post-title"><h3 class="h4"><a href="https://cenele.com/cont/a/">A</a></h3></div>
       </div>`,
      "text/html",
    );
    expect(parseSearchPage(doc, "q", 1).hasMore).toBe(false);
  });

  it("echoes query and page", () => {
    const r = parseSearchPage(
      new DOMParser().parseFromString(searchHtml, "text/html"), "سيد", 2);
    expect(r.query).toBe("سيد");
    expect(r.page).toBe(2);
  });
});

// ── homepage sections ────────────────────────────────────────────────────
//
// tests/fixtures/home.html is a live capture of https://cenele.com/. Two of
// the sections it renders — the "nhv-newseries" slider and the
// "nhv-gems-lb" leaderboard — list real novels that getHomeSections has to
// surface, alongside the "nhv-newreleases" row it already handled.

describe("parseHomeSections", () => {
  it("parses the new-series slider as its own section", () => {
    const sections = parseHomeSections(parseHtml(homeHtml));
    const newseries = sections.find((s) => s.id === "newseries");
    expect(newseries).toBeDefined();
    expect(newseries!.cards.length).toBeGreaterThan(0);
    for (const card of newseries!.cards) {
      expect(card.url).toMatch(/^https:\/\/cenele\.com\/cont\//);
      expect(card.title).not.toBe("");
    }
  });

  it("parses the gems leaderboard as its own section", () => {
    const sections = parseHomeSections(parseHtml(homeHtml));
    const gems = sections.find((s) => s.id === "gems");
    expect(gems).toBeDefined();
    // The live board lists six ranked novels — that's the real count in
    // the captured fixture (matches the live site's board size).
    expect(gems!.cards).toHaveLength(6);
    expect(gems!.cards[0].url).toMatch(/^https:\/\/cenele\.com\/cont\//);
  });

  it("drops the gem count and rank from the gems card titles", () => {
    // The identity anchor's textContent glues a "boosted novel" label
    // directly onto the title with no separator — proof the parser reads
    // just the <strong> rather than falling through to the raw text.
    const gems = parseHomeSections(parseHtml(homeHtml)).find((s) => s.id === "gems")!;
    for (const card of gems.cards) {
      expect(card.title).not.toMatch(/\d/);
      expect(card.title).not.toContain("معززة");
    }
  });

  it("falls back to the synthesized heading when the gems section ships no .nhv-title", () => {
    // The live gems markup's own heading is a bare <h2>, not .nhv-title,
    // so this is the actually-exercised path, not a defensive no-op.
    const gems = parseHomeSections(parseHtml(homeHtml)).find((s) => s.id === "gems")!;
    expect(gems.title).toBe("لوحة الجواهر");
  });

  it("never emits a section with zero cards", () => {
    // An empty section renders as a bare heading over blank space in the
    // Store, which reads as a bug rather than as "nothing here today".
    for (const s of parseHomeSections(parseHtml(homeHtml))) {
      expect(s.cards.length).toBeGreaterThan(0);
    }
  });
});

// ── chapter-body extraction ─────────────────────────────────────────────────
//
// The highest-consequence, most theme-fragile code in this extension: over-
// strip and a user's imported book is silently truncated, under-strip and
// piracy boilerplate is baked into their EPUB. tests/fixtures/chapter.html
// exercises every decoy form isDecoyElement/looksLikePiracyDecoy claim to
// handle (see the file-header comment and each function's own doc comment
// in ../src/index.ts), alongside real-looking chapter paragraphs and a real
// image, so a regression in either direction shows up here.

describe("extractChapterLines", () => {
  it("keeps every real paragraph and image, in order, and strips every decoy form", () => {
    const doc = new DOMParser().parseFromString(chapterHtml, "text/html");
    const lines = extractChapterLines(doc);

    expect(lines).toEqual([
      {
        type: "text",
        content: "كان يا ما كان، في قديم الزمان، عاش بطل الرواية في قرية صغيرة.",
      },
      // The aria-hidden <span> nested inside this <p> is removed by the
      // first pass, but the real text on either side of it survives —
      // proving decoys nested inside a real paragraph (not just whole
      // decoy paragraphs) are handled, per the file's header comment.
      {
        type: "text",
        content: "هذا نص حقيقي يتبعه المزيد من النص الحقيقي.",
      },
      // aria-hidden="true" (whole <p>), data-nosnippet="true", the
      // role="presentation" wrapper (and the real-looking <p> nested
      // inside it — removed along with its ancestor), the hidden-style-
      // only <p>, and the translate="no"+hidden-style combo above are
      // all absent from this array entirely: proof they were stripped,
      // not merely reordered.
      //
      // translate="no" ALONE (no hidden style) is deliberately NOT a
      // decoy signal — isDecoyElement requires hasHiddenStyle too — so
      // this paragraph must survive.
      { type: "text", content: "اسم علم مثل Cenele لا يُترجم." },
      // The piracy-boilerplate paragraph (no special attributes at all)
      // is caught by the looksLikePiracyDecoy keyword safety net, not by
      // isDecoyElement — proof that net runs independently.
      //
      // The next real paragraph is repeated twice in the fixture; only
      // one copy survives (dedup).
      {
        type: "text",
        content: "القصة مستمرة والبطل يواصل رحلته نحو الحقيقة.",
      },
      // The real image is repeated once (dedup keeps one copy); the
      // wp-post-image avatar and the /ads/ banner are both decorative
      // and excluded entirely.
      {
        type: "image",
        content: "https://cenele.com/wp-content/uploads/2024/01/scene.jpg",
      },
    ]);
  });

  it("falls back to .entry-content when .reading-content is absent", () => {
    const doc = new DOMParser().parseFromString(
      `<div class="entry-content"><p>نص الفصل هنا.</p></div>`,
      "text/html",
    );
    expect(extractChapterLines(doc)).toEqual([{ type: "text", content: "نص الفصل هنا." }]);
  });
});

describe("isDecoyElement", () => {
  const el = (html: string): Element =>
    new DOMParser().parseFromString(html, "text/html").body.firstElementChild!;

  it('flags aria-hidden="true"', () => {
    expect(isDecoyElement(el(`<p aria-hidden="true">x</p>`))).toBe(true);
  });

  it('flags data-nosnippet="true"', () => {
    expect(isDecoyElement(el(`<p data-nosnippet="true">x</p>`))).toBe(true);
  });

  it('flags role="presentation"', () => {
    expect(isDecoyElement(el(`<p role="presentation">x</p>`))).toBe(true);
  });

  it('flags translate="no" combined with a hidden style', () => {
    expect(
      isDecoyElement(el(`<p translate="no" style="position:absolute;opacity:0;">x</p>`)),
    ).toBe(true);
  });

  it('does NOT flag translate="no" on its own — it must be combined with a hidden style', () => {
    expect(isDecoyElement(el(`<p translate="no">x</p>`))).toBe(false);
  });

  it("flags a hidden style on its own, with no other attribute", () => {
    expect(isDecoyElement(el(`<p style="position:absolute;opacity:0;">x</p>`))).toBe(true);
  });

  it("does not flag an ordinary paragraph with none of these signals", () => {
    expect(isDecoyElement(el(`<p class="normal">x</p>`))).toBe(false);
  });
});

describe("hasHiddenStyle", () => {
  const el = (style: string): Element =>
    new DOMParser().parseFromString(`<p style="${style}">x</p>`, "text/html").body
      .firstElementChild!;

  it("requires position:absolute — opacity:0 alone is not enough", () => {
    expect(hasHiddenStyle(el("opacity:0;"))).toBe(false);
  });

  it.each([
    ["opacity:0", "opacity:0"],
    ["width:0", "width:0"],
    ["width:1px", "width:1px"],
    ["height:0", "height:0"],
    ["height:1px", "height:1px"],
    ["transform:scale(0.0)", "transform:scale(0.0)"],
    ["filter:blur(5px)", "filter:blur"],
    ["pointer-events:none", "pointer-events:none"],
  ])("combined with position:absolute, %s is enough on its own", (style) => {
    expect(hasHiddenStyle(el(`position:absolute;${style};`))).toBe(true);
  });

  it("position:absolute with none of the hiding effects is not hidden", () => {
    expect(hasHiddenStyle(el("position:absolute;top:0;left:0;"))).toBe(false);
  });

  it("returns false for an element with no style attribute at all", () => {
    const bare = new DOMParser().parseFromString("<p>x</p>", "text/html").body.firstElementChild!;
    expect(hasHiddenStyle(bare)).toBe(false);
  });
});

describe("looksLikePiracyDecoy", () => {
  it("matches the مسروقة + فضاء الروايات combination", () => {
    expect(looksLikePiracyDecoy("هذه الرواية مسروقة من موقع فضاء الروايات")).toBe(true);
  });

  it("matches the مسروقة + cenele.com combination", () => {
    expect(looksLikePiracyDecoy("هذه الرواية مسروقة، الأصل على cenele.com")).toBe(true);
  });

  it("matches the فضاء الروايات + تطبيقنا combination", () => {
    expect(looksLikePiracyDecoy("حمل تطبيقنا من فضاء الروايات الآن")).toBe(true);
  });

  it("still matches when zero-width characters are inserted between letters", () => {
    // Decoys insert zero-width joiners/spaces between letters to defeat
    // naive substring matching; looksLikePiracyDecoy strips them first.
    const withZwj = "مسروقة".split("").join("‍");
    expect(looksLikePiracyDecoy(`${withZwj} من فضاء الروايات`)).toBe(true);
  });

  it("does not flag ordinary chapter prose", () => {
    expect(looksLikePiracyDecoy("القصة مستمرة والبطل يواصل رحلته نحو الحقيقة.")).toBe(false);
  });
});

// ── end-to-end: drives the extension through the public contract only ──────
//
// Everything above proves the parser functions are correct in isolation.
// It does not prove the port actually works as an *extension* — that the
// default export builds a Source from a host, that `search()` wires the
// right URL through `host.fetch`, and that the result reaching the caller
// is exactly what a real host would see. This block is the regression test
// for the port itself, not just for code that happened to move.
describe("createSource (end-to-end via createTestHost)", () => {
  it("search() requests the right URL through host.fetch and returns parsed cards", async () => {
    const expectedUrl = "https://cenele.com/?s=%D8%B3%D9%8A%D8%AF&post_type=wp-manga";
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const host = createTestHost({
      responses: { [expectedUrl]: searchHtml },
      calls,
    });
    const source = createSource(host);

    const result = await source.search("سيد");

    // The URL the source actually requested — proof the AR query was
    // encoded and routed to the page-1 search endpoint, not merely that
    // some fixture happened to satisfy a lenient lookup.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(expectedUrl);
    expect(calls[0].method).toBe("GET");

    // The cards the caller actually gets back, end to end through the
    // Source interface — same fixture, same expected shape as
    // parseSearchPage's own unit test above.
    expect(result.query).toBe("سيد");
    expect(result.page).toBe(1);
    expect(result.hasMore).toBe(true);
    expect(result.cards).toHaveLength(2);
    expect(result.cards[0]).toEqual({
      url: "https://cenele.com/cont/lord-of-wishes/",
      title: "سيد التمني",
      coverUrl: "https://cenele.com/wp-content/uploads/2026/06/wishes-193x278.jpg",
      subtitle: "رواية Lord of Wishes",
      badges: ["أكشن", "فانتازيا"],
    });
  });

  it("canHandle() accepts cenele.com URLs and rejects other hosts", () => {
    const source = createSource(createTestHost());
    expect(source.canHandle("https://cenele.com/cont/pursuit/")).toBe(true);
    expect(source.canHandle("https://example.com/")).toBe(false);
  });
});
