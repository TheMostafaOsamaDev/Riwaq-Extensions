import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import createSource from "../src/index";
import { parseSearchResults } from "../src/theme";
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
