import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import createSource, {
  extractNovelConfig,
  parseNovelPage,
  searchUrl,
  parseSearchPage,
} from "../src/index";
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
