import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import createSource, { cardFor, PAGE_SIZE, type CatalogueRow } from "../src/index";
import { createTestHost } from "@riwaq/extension-api/testing";

// Deliberately not `readFileSync(new URL("./fixtures/novels.json", import.meta.url), ...)`:
// this suite runs under `environment: "happy-dom"` (see vitest.config.ts), and
// happy-dom's patched global `URL` silently resolves a *relative* two-argument
// `new URL(href, base)` against its fake `window.location` instead of the given
// file: base. `fileURLToPath` on this file's own `import.meta.url` (no relative
// resolution involved) plus plain path-segment arithmetic sidesteps it entirely
// — see extensions/cenele/tests/cenele.test.ts for the same pattern.
const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");
const novelsFixture = readFileSync(join(FIXTURES_DIR, "novels.json"), "utf8");

// The committed fixture is a live capture of https://seanovel.org/api/novels
// (2026-09-18). Every expectation below is derived from parsing it at test
// time, not from any number observed on that day — the site adds novels and
// chapters continuously, so a hardcoded count would drift and fail for a
// reason nobody could act on. See task-2-report.md for what this fixture
// actually contained on the day it was captured.
const novelRows = JSON.parse(novelsFixture) as CatalogueRow[];

const host = (locale: "en" | "ar" = "ar") =>
  createTestHost({ responses: { "/api/novels": novelsFixture }, locale });

describe("seanovel: createSource", () => {
  it("constructs a Source from a host", () => {
    expect(() => createSource(createTestHost())).not.toThrow();
  });

  it("getNovel is not implemented yet", async () => {
    const source = createSource(createTestHost());
    await expect(source.getNovel("https://example.com/novel/1")).rejects.toThrow(
      "not implemented",
    );
  });

  it("getChapterContent is not implemented yet", async () => {
    const source = createSource(createTestHost());
    await expect(
      source.getChapterContent({ id: 1, title: "t", url: "https://example.com/c/1", lines: [] }),
    ).rejects.toThrow("not implemented");
  });
});

describe("canHandle", () => {
  it("accepts seanovel novel and chapter URLs", () => {
    const source = createSource(createTestHost());
    expect(source.canHandle("https://seanovel.org/novels/shadow-slave")).toBe(true);
    expect(source.canHandle("https://seanovel.org/novels/shadow-slave/chapters/1")).toBe(true);
    expect(source.canHandle("https://www.seanovel.org/novels/x")).toBe(true);
  });

  it("rejects other sites", () => {
    const source = createSource(createTestHost());
    expect(source.canHandle("https://cenele.com/cont/x/")).toBe(false);
    expect(source.canHandle("not a url")).toBe(false);
  });

  it("rejects hostnames that merely contain seanovel.org as a substring", () => {
    // A substring/suffix check (e.g. hostname.includes("seanovel.org"))
    // would wrongly accept both of these. Only exact hostname membership
    // in HOSTS should pass — the dangerous case is an attacker-controlled
    // domain that happens to contain "seanovel.org" as a label or prefix.
    const source = createSource(createTestHost());
    expect(source.canHandle("https://notseanovel.org/novels/x")).toBe(false);
    expect(source.canHandle("https://seanovel.org.evil.com/novels/x")).toBe(false);
  });
});

describe("cardFor", () => {
  // Pure function — exercised with hand-built rows, not the fixture, so
  // each fallback/cap path is pinned regardless of what the live catalogue
  // happens to contain today.
  it("prefers title_ar, falling back to title_original then slug", () => {
    expect(cardFor({ slug: "s", title_ar: "عربي", title_original: "Orig" }).title).toBe("عربي");
    expect(cardFor({ slug: "s", title_ar: "", title_original: "Orig" }).title).toBe("Orig");
    expect(cardFor({ slug: "s", title_ar: "" }).title).toBe("s");
  });

  it("builds the novel and cover URLs from the slug", () => {
    const card = cardFor({ slug: "shadow-slave", title_ar: "x" });
    expect(card.url).toBe("https://seanovel.org/novels/shadow-slave");
    expect(card.coverUrl).toBe("https://seanovel.org/api/novel/shadow-slave/cover?type=webp");
  });

  it("caps badges at 3 genres even when the row lists more", () => {
    const card = cardFor({ slug: "s", title_ar: "x", genres: ["a", "b", "c", "d", "e"] });
    expect(card.badges).toEqual(["a", "b", "c"]);
  });

  it("omits subtitle when there is no original title", () => {
    expect(cardFor({ slug: "s", title_ar: "x" }).subtitle).toBeUndefined();
  });
});

describe("getHomeSections", () => {
  it("builds exactly latest/popular/completed, each non-empty and capped at PAGE_SIZE", async () => {
    const sections = await createSource(host()).getHomeSections();
    expect(sections.map((s) => s.id)).toEqual(["latest", "popular", "completed"]);
    for (const s of sections) {
      expect(s.cards.length).toBeGreaterThan(0);
      expect(s.cards.length).toBeLessThanOrEqual(PAGE_SIZE);
    }
  });

  it("orders 'latest' by last_updated, newest first, for the whole visible page", async () => {
    const [latest] = await createSource(host()).getHomeSections();
    const expected = [...novelRows]
      .sort((a, b) => Date.parse(b.last_updated ?? "") - Date.parse(a.last_updated ?? ""))
      .slice(0, PAGE_SIZE)
      .map((r) => r.title_ar);
    expect(latest.cards.map((c) => c.title)).toEqual(expected);
  });

  it("orders 'popular' by chapters_count, most chapters first, for the whole visible page", async () => {
    const sections = await createSource(host()).getHomeSections();
    const popular = sections.find((s) => s.id === "popular")!;
    const expected = [...novelRows]
      .sort((a, b) => (b.chapters_count ?? 0) - (a.chapters_count ?? 0))
      .slice(0, PAGE_SIZE)
      .map((r) => r.title_ar);
    expect(popular.cards.map((c) => c.title)).toEqual(expected);
  });

  it("puts only completed novels in the completed row, capped at PAGE_SIZE", async () => {
    const completedRows = novelRows.filter((r) => r.status === "completed");
    const completedUrls = new Set(completedRows.map((r) => cardFor(r).url));
    const sections = await createSource(host()).getHomeSections();
    const section = sections.find((s) => s.id === "completed")!;

    // Every card must be a genuinely completed novel...
    for (const card of section.cards) expect(completedUrls.has(card.url)).toBe(true);
    // ...and the cap must actually be exercised, not silently returning
    // everything (or nothing): this only proves what it claims because the
    // fixture has more completed novels than one page holds.
    expect(completedRows.length).toBeGreaterThan(PAGE_SIZE);
    expect(section.cards).toHaveLength(PAGE_SIZE);
  });
});

describe("search", () => {
  it("matches on the Arabic title", async () => {
    const r = await createSource(host()).search("عبد الظل", 1);
    expect(r.cards.map((c) => c.title)).toEqual(["عبد الظل"]);
    expect(r.query).toBe("عبد الظل");
    expect(r.page).toBe(1);
  });

  it("matches on the original title too", async () => {
    const r = await createSource(host()).search("Shadow Slave", 1);
    expect(r.cards.map((c) => c.title)).toEqual(["عبد الظل"]);
  });

  it("excludes rows that do not match the query — a query matching every row would prove nothing", async () => {
    // "shadow" matches a handful of rows in the fixture, not all of them.
    // If a broken implementation ignored the query and returned the whole
    // catalogue, this test (unlike one that only checks inclusion) would
    // catch it.
    const q = "shadow";
    const matchingSlugs = new Set(
      novelRows
        .filter(
          (r) =>
            r.title_ar.toLowerCase().includes(q) ||
            (r.title_original ?? "").toLowerCase().includes(q) ||
            r.slug.toLowerCase().includes(q),
        )
        .map((r) => r.slug),
    );
    expect(matchingSlugs.size).toBeGreaterThan(0);
    expect(matchingSlugs.size).toBeLessThan(novelRows.length);

    const r = await createSource(host()).search(q, 1);
    const expectedUrls = new Set(
      [...matchingSlugs].map((slug) => cardFor({ slug, title_ar: "" }).url),
    );
    expect(r.cards.length).toBe(matchingSlugs.size);
    for (const card of r.cards) expect(expectedUrls.has(card.url)).toBe(true);
  });

  it("defaults to page 1 when the page argument is omitted", async () => {
    const r = await createSource(host()).search("عبد الظل");
    expect(r.page).toBe(1);
  });

  it("paginates the filtered list and reports hasMore truthfully", async () => {
    // The server ignores query params, so paging is ours to do correctly.
    // "ا" is deliberately broad enough to span multiple pages in the
    // committed fixture (verified below) — a query narrow enough to fit on
    // one page would make a "hasMore" assertion vacuous.
    const q = "ا";
    const totalMatches = novelRows.filter(
      (r) =>
        r.title_ar.toLowerCase().includes(q) ||
        (r.title_original ?? "").toLowerCase().includes(q) ||
        r.slug.toLowerCase().includes(q),
    ).length;
    expect(totalMatches).toBeGreaterThan(PAGE_SIZE);

    const source = createSource(host());
    const seenUrls = new Set<string>();
    let page = 1;
    let result = await source.search(q, page);
    expect(result.cards).toHaveLength(PAGE_SIZE);
    while (result.hasMore) {
      for (const c of result.cards) seenUrls.add(c.url);
      page += 1;
      result = await source.search(q, page);
      expect(result.cards.length).toBeGreaterThan(0);
    }
    for (const c of result.cards) seenUrls.add(c.url);

    // Every match was seen exactly once across all pages: no duplicates,
    // no gaps, and the walk actually terminates (hasMore eventually false).
    expect(seenUrls.size).toBe(totalMatches);
  });

  it("returns an empty result rather than throwing when nothing matches", async () => {
    const r = await createSource(host()).search("zzzzzzzznomatch", 1);
    expect(r.cards).toEqual([]);
    expect(r.hasMore).toBe(false);
  });
});

describe("the catalogue memo is per-instance, not shared across createSource calls", () => {
  // This is the direct regression test for the fix to the brief's original
  // defect: a module-scope `cataloguePromise` would let the FIRST host ever
  // passed to createSource win permanently, so a second createSource(host2)
  // would silently replay the first host's catalogue instead of fetching
  // its own. Reverting the fix (hoisting cataloguePromise out of
  // createSource) makes this test fail — see task-2-report.md.
  const soleRow: CatalogueRow = {
    slug: "only-one",
    title_ar: "فريد",
    status: "ongoing",
    chapters_count: 1,
    last_updated: "2020-01-01T00:00:00Z",
  };

  it("does not leak one instance's catalogue into a second instance", async () => {
    const hostA = host();
    const hostB = createTestHost({
      responses: { "/api/novels": JSON.stringify([soleRow]) },
      locale: "ar",
    });

    const sourceA = createSource(hostA);
    await sourceA.getHomeSections(); // warm A's memo first

    const sourceB = createSource(hostB);
    const sectionsB = await sourceB.getHomeSections();
    const latestB = sectionsB.find((s) => s.id === "latest")!;
    expect(latestB.cards).toHaveLength(1);
    expect(latestB.cards[0].title).toBe("فريد");

    // A's own catalogue must still be its own, unaffected by B existing.
    const sectionsA = await sourceA.getHomeSections();
    const latestA = sectionsA.find((s) => s.id === "latest")!;
    expect(latestA.cards).toHaveLength(PAGE_SIZE);
  });

  it("fetches the catalogue at most once per instance across multiple calls", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const testHost = createTestHost({
      responses: { "/api/novels": novelsFixture },
      locale: "ar",
      calls,
    });
    const source = createSource(testHost);
    await source.getHomeSections();
    await source.search("ا", 1);
    const catalogueCalls = calls.filter((c) => c.url.includes("/api/novels"));
    expect(catalogueCalls).toHaveLength(1);
  });
});
