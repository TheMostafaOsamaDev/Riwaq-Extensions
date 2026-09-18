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
      postId: "114932",
      chaptersNonce: "1ef880db28",
    });
  });

  it("prefers chaptersNonce over the section nonce", () => {
    // nhvNovelV2.nonce is 8b20962872 and belongs to nhv_novel_v2_section,
    // NOT to the chapters AJAX. Picking it would 403 every chapter fetch.
    expect(extractNovelConfig(novelHtml)?.chaptersNonce).not.toBe("8b20962872");
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
    "https://cenele.com/cont/create-heaven-riwya/",
  );

describe("parseNovelPage", () => {
  it("reads title, original title and cover", () => {
    const n = parse();
    expect(n.title).toBe("انشاء القوانين السماوية");
    expect(n.originalTitle).toBe("Create heavenly laws");
    expect(n.coverUrl).toBe(
      "https://cenele.com/wp-content/uploads/2026/08/139e19c5-bfa6-468f-8694-ee4b00437657-768x1024.webp",
    );
  });

  it("keeps genres and tags as separate lists", () => {
    const n = parse();
    expect(n.tags).toEqual([
      "أكشن", "خيال", "خيال علمي", "شوانهوان", "غموض", "فانتازيا", "فنون قتالية", "قوى خارقة", "مغامرة",
      "صينية", "مغامرات",
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
      value: "It's not Sunday",
      url: "https://cenele.com/cont-author/its-not-sunday/",
    });
  });

  it("lifts the author out of the meta rows", () => {
    expect(parse().author).toBe("It's not Sunday");
  });

  it("reads the synopsis", () => {
    expect(parse().description).toContain("تقنيات سامية؟");
  });

  it("excludes heading boilerplate from the synopsis", () => {
    // The synopsis container holds an <h2> (title repeated, once before and
    // once after the paragraphs — an Arabic heading and an English one).
    // These must not appear in the stored description.
    const n = parse();
    expect(n.description).not.toContain("رواية إنشاء القوانين السماوية");
    expect(n.description).not.toContain("رواية Create heavenly laws");
    // The actual paragraph content should still be present
    expect(n.description).toContain("تقنيات سامية؟");
  });

  it("carries the chapter credentials through", () => {
    const n = parse();
    expect(n.mangaId).toBe("114932");
    expect(n.chaptersNonce).toBe("1ef880db28");
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
    expect(parsed().cards).toHaveLength(12);
  });

  it("reads url, title, cover, original title and genres", () => {
    expect(parsed().cards[0]).toEqual({
      url: "https://cenele.com/cont/lord-of-wishes/",
      title: "سيد التمني",
      coverUrl:
        "https://cenele.com/wp-content/uploads/2026/06/IMG_%D9%A2%D9%A0%D9%A2%D9%A6%D9%A0%D9%A3%D9%A1%D9%A7_%D9%A0%D9%A9%D9%A1%D9%A2%D9%A3%D9%A4-193x278.jpg",
      subtitle: "رواية Lord of Wishes",
      badges: ["أكشن", "دراما", "رعب", "غموض", "فانتازيا"],
    });
  });

  it("omits optional fields a row doesn't carry", () => {
    // Row 2 ("عودة السيد الشامل الأسطوري") carries genre badges but no
    // "Alternative" (original-title) block — the live fixture's real
    // example of an optional field being absent.
    const third = parsed().cards[2];
    expect(third.title).toBe("عودة السيد الشامل الأسطوري");
    expect(third.subtitle).toBeUndefined();
    expect(third.badges).toBeDefined();
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
// piracy boilerplate is baked into their EPUB.
//
// tests/fixtures/chapter.html is a live capture (chapter 1 of
// create-heaven-riwya, 2026-09-18) — real prose, real decoys, not hand-
// written. Two things about it are worth knowing before touching this
// block:
//
// 1. As of this capture, EVERY decoy the live theme emits is a `<section
//    data-nosnippet="true">`/`<span aria-hidden="true">` that sits as a
//    SIBLING of the real `<p>` elements, never nested inside one and never
//    a `<p>` itself (sampled across 11 chapters over 2 novels — see the
//    README's "Chapter-body decoy stripping" section). extractChapterLines
//    only ever reads `p, img`, so removing or not removing these siblings
//    makes zero difference to its output on any chapter sampled during
//    this refresh — the fixture proves the site still ships decoy markup
//    and that none of its (still tatweel-obfuscated) boilerplate leaks
//    into a real line, but it can't prove the nested-inside-a-<p> or
//    whole-<p> removal paths, because nothing live currently exercises
//    them. The synthetic test below keeps those paths covered.
// 2. This capture is what surfaced a real bug during this refresh: three
//    separate, unrelated one-word paragraphs in this chapter are all
//    exactly "لكن…" ("But…"). The old whole-chapter `Set`-based dedup
//    collapsed all three into one, silently dropping two real lines of
//    prose. extractChapterLines now only dedups against the IMMEDIATELY
//    PRECEDING line (see its own comment) — the fix this capture justified.

describe("extractChapterLines", () => {
  it("keeps every real chapter paragraph, in order, with no decoy boilerplate leaking through", () => {
    const doc = new DOMParser().parseFromString(chapterHtml, "text/html");

    // Non-vacuous check: the fixture must still carry decoy markup THAT
    // isDecoyElement ACTUALLY MATCHES INSIDE THE CONTENT REGION
    // extractChapterLines reads — not just "this attribute appears
    // somewhere on the page". aria-hidden="true" alone is a bad proxy for
    // that: it's a common accessibility attribute the theme also uses on
    // ordinary page chrome (share-button SVG icons, etc.) well outside
    // .reading-content — a whole-file count of it would stay green even
    // if every real chapter-body decoy vanished, which is the exact
    // hollowness this check exists to rule out. data-nosnippet="true" is
    // fine to check file-wide (it's decoy-exclusive in this fixture — see
    // the report), but aria-hidden needs to be scoped to the actual
    // content region and to elements isDecoyElement would flag.
    const contentRoot =
      doc.querySelector(".reading-content .text-left") ||
      doc.querySelector(".reading-content") ||
      doc.querySelector(".entry-content") ||
      doc.body;
    const ariaHiddenDecoyCount = contentRoot.querySelectorAll('[aria-hidden="true"]').length;
    const dataNosnippetCount = (chapterHtml.match(/data-nosnippet="true"/g) || []).length;
    expect(ariaHiddenDecoyCount).toBeGreaterThan(0);
    expect(dataNosnippetCount).toBeGreaterThan(0);

    const lines = extractChapterLines(doc);

    // 217 <p> elements in .reading-content .text-left, all real; a
    // regression that starts over- or under-extracting moves this count.
    expect(lines).toHaveLength(217);
    expect(lines.every((l) => l.type === "text")).toBe(true);

    // Real prose survives, in order, at both ends and in the middle.
    expect(lines[0]).toEqual({
      type: "text",
      content: "الفصل الأول: التجنيد الإجباري",
    });
    expect(lines[Math.floor(lines.length / 2)]).toEqual({
      type: "text",
      content: "كانت حاكمة الحكمة واحدة من الحاكمات الثلاث العظيمات لتحالف البشر العالمي.",
    });
    expect(lines[lines.length - 1]).toEqual({
      type: "text",
      content: "الترجمة: القارئ الأبدي",
    });

    // The short one-word paragraph "لكن…" ("But…") genuinely repeats three
    // times at unrelated points in this chapter — proof the fix in point 2
    // of the file-header comment above keeps non-adjacent repeats, not
    // just that it exists.
    expect(lines.filter((l) => l.content === "لكن…")).toHaveLength(3);

    // None of the stripped decoy boilerplate — nor its tatweel-obfuscated
    // form — leaks into the output.
    for (const line of lines) {
      expect(looksLikePiracyDecoy(line.content)).toBe(false);
      expect(line.content).not.toContain("يسرق");
    }
  });

  // Synthetic (not a live capture): the live site sampled during this
  // refresh never nests a decoy inside a real <p>, never ships a whole-<p>
  // decoy, and never leaves an unhidden keyword-only decoy paragraph (see
  // the file-header comment) — so this snippet is what keeps
  // extractChapterLines's actual removal-and-dedup integration covered:
  // a decoy nested inside a real paragraph, a whole aria-hidden <p>, a
  // role="presentation" wrapper removed along with the real-looking <p>
  // nested inside it, a hidden-style-only <p>, translate="no" ALONE
  // surviving (it's not a decoy signal on its own), the keyword safety net
  // catching a plain piracy paragraph isDecoyElement wouldn't flag, and
  // adjacent-vs-non-adjacent text/image dedup.
  it("integration: nested/whole-paragraph decoy removal, the keyword safety net, and adjacent-only dedup all still cooperate", () => {
    const doc = new DOMParser().parseFromString(
      `<div class="reading-content"><div class="text-left">
        <p>هذا نص حقيقي <span aria-hidden="true">نص مخفي داخل الفقرة</span> يتبعه المزيد من النص الحقيقي.</p>
        <p aria-hidden="true">هذا النص كله مخفي ولا يجب أن يظهر إطلاقاً.</p>
        <p data-nosnippet="true">فقرة مخفية أخرى عبر data-nosnippet.</p>
        <div role="presentation"><p>فقرة كاملة داخل عنصر role="presentation" يجب حذفها بالكامل.</p></div>
        <p style="position:absolute;opacity:0;">فقرة مخفية عبر الأنماط المباشرة فقط.</p>
        <p translate="no">اسم علم مثل Cenele لا يُترجم.</p>
        <p>رواياتنا مسروقة من موقع فضاء الروايات، حمل تطبيقنا الآن.</p>
        <p>القصة مستمرة والبطل يواصل رحلته نحو الحقيقة.</p>
        <p>القصة مستمرة والبطل يواصل رحلته نحو الحقيقة.</p>
        <p>سطر منتصف الفصل.</p>
        <p>القصة مستمرة والبطل يواصل رحلته نحو الحقيقة.</p>
        <img src="https://cenele.com/wp-content/uploads/2024/01/scene.jpg" alt="scene">
        <img src="https://cenele.com/wp-content/uploads/2024/01/scene.jpg" alt="scene duplicate">
        <img class="wp-post-image" src="https://cenele.com/wp-content/uploads/2024/01/avatar.jpg" alt="decorative">
        <img src="https://cenele.com/ads/banner.jpg" alt="ad">
        <img src="https://cenele.com/wp-content/uploads/2024/01/other.jpg" alt="a different real image">
        <img src="https://cenele.com/wp-content/uploads/2024/01/scene.jpg" alt="scene again, non-adjacent">
      </div></div>`,
      "text/html",
    );

    expect(extractChapterLines(doc)).toEqual([
      // The nested aria-hidden <span> is removed by the first pass; the
      // real text on either side of it survives in one paragraph.
      { type: "text", content: "هذا نص حقيقي يتبعه المزيد من النص الحقيقي." },
      // The whole aria-hidden <p>, the data-nosnippet <p>, the
      // role="presentation" wrapper (and the real-looking <p> nested
      // inside it — removed along with its ancestor), and the
      // hidden-style-only <p> are all absent entirely: proof they were
      // stripped, not merely reordered.
      //
      // translate="no" ALONE (no hidden style) is deliberately NOT a
      // decoy signal — isDecoyElement requires hasHiddenStyle too — so
      // this paragraph must survive.
      { type: "text", content: "اسم علم مثل Cenele لا يُترجم." },
      // The piracy-boilerplate paragraph has no special attributes at
      // all — caught by looksLikePiracyDecoy, not isDecoyElement.
      //
      // The next paragraph repeats twice back to back — adjacent dedup
      // keeps one copy — then a middle line, then the SAME text a third
      // time, non-adjacent this time, which must survive (see the fix
      // described in the file-header comment: dedup is adjacency-only).
      { type: "text", content: "القصة مستمرة والبطل يواصل رحلته نحو الحقيقة." },
      { type: "text", content: "سطر منتصف الفصل." },
      { type: "text", content: "القصة مستمرة والبطل يواصل رحلته نحو الحقيقة." },
      // The real image repeats back to back — adjacent dedup keeps one
      // copy; the wp-post-image avatar and the /ads/ banner are both
      // decorative and excluded entirely (and don't count as the
      // "previous image" for adjacency, since they're filtered before
      // ever being considered). A different real image then plays the
      // same role the middle text line played above, so the final
      // repeat of the first image is genuinely non-adjacent in the KEPT
      // output and must survive.
      {
        type: "image",
        content: "https://cenele.com/wp-content/uploads/2024/01/scene.jpg",
      },
      {
        type: "image",
        content: "https://cenele.com/wp-content/uploads/2024/01/other.jpg",
      },
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

  // Documents a KNOWN LIMITATION (see the long comment at the dedup site in
  // ../src/index.ts) — this pins the CURRENT behavior for review/regression
  // purposes, it is not asserting this is the desired outcome. A duplicated
  // multi-element run (<p>A</p><img>X</img><p>B</p> immediately repeated)
  // is not deduped as a whole: lastText/lastImage are tracked per element
  // type, so from the text-only sub-sequence's point of view A and B are
  // never adjacent to their own repeat (B sits between them), and both
  // survive as visible duplicates — the accepted trade-off. But from the
  // image-only sub-sequence's point of view, the two <img>X occurrences
  // ARE adjacent (no other image occurs between them), so the second one
  // is silently dropped — a real, if narrow, silent-loss case this
  // trade-off still accepts. If this test's expectations ever need to
  // change because the dedup strategy was redesigned, that's a deliberate
  // change to make with full knowledge of this case, not a fixture drift.
  it("known limitation: a duplicated multi-element run isn't deduped as a whole (text duplicates survive, the repeated image is silently dropped)", () => {
    const doc = new DOMParser().parseFromString(
      `<div class="reading-content"><div class="text-left">
        <p>A</p>
        <img src="https://cenele.com/wp-content/uploads/2024/01/x.jpg" alt="x">
        <p>B</p>
        <p>A</p>
        <img src="https://cenele.com/wp-content/uploads/2024/01/x.jpg" alt="x">
        <p>B</p>
      </div></div>`,
      "text/html",
    );
    expect(extractChapterLines(doc)).toEqual([
      { type: "text", content: "A" },
      { type: "image", content: "https://cenele.com/wp-content/uploads/2024/01/x.jpg" },
      { type: "text", content: "B" },
      // The repeated run's <p>A</p> and <p>B</p> both survive (duplicated,
      // visible) ...
      { type: "text", content: "A" },
      // ... but the run's repeated <img> does NOT survive: it was silently
      // deduped away here, even though a real <p>B</p> sits between the
      // two occurrences in the actual document.
      { type: "text", content: "B" },
    ]);
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
    expect(result.cards).toHaveLength(12);
    expect(result.cards[0]).toEqual({
      url: "https://cenele.com/cont/lord-of-wishes/",
      title: "سيد التمني",
      coverUrl:
        "https://cenele.com/wp-content/uploads/2026/06/IMG_%D9%A2%D9%A0%D9%A2%D9%A6%D9%A0%D9%A3%D9%A1%D9%A7_%D9%A0%D9%A9%D9%A1%D9%A2%D9%A3%D9%A4-193x278.jpg",
      subtitle: "رواية Lord of Wishes",
      badges: ["أكشن", "دراما", "رعب", "غموض", "فانتازيا"],
    });
  });

  it("canHandle() accepts cenele.com URLs and rejects other hosts", () => {
    const source = createSource(createTestHost());
    expect(source.canHandle("https://cenele.com/cont/pursuit/")).toBe(true);
    expect(source.canHandle("https://example.com/")).toBe(false);
  });
});
