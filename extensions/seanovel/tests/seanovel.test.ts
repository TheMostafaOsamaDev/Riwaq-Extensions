import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import createSource, {
  cardFor,
  PAGE_SIZE,
  slugFromUrl,
  type CatalogueRow,
  type NovelDetailRow,
} from "../src/index";
import { strings } from "../src/strings";
import { parseHtml, sanitizeText, SourceUrlError } from "@riwaq/extension-api";
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
const novelFixture = readFileSync(join(FIXTURES_DIR, "novel.json"), "utf8");

// The committed fixture is a live capture of https://seanovel.org/api/novels
// (2026-09-18). Every expectation below is derived from parsing it at test
// time, not from any number observed on that day — the site adds novels and
// chapters continuously, so a hardcoded count would drift and fail for a
// reason nobody could act on. See task-2-report.md for what this fixture
// actually contained on the day it was captured.
const novelRows = JSON.parse(novelsFixture) as CatalogueRow[];

// Same discipline for the novel-detail fixture: a live capture of
// https://seanovel.org/api/novel/shadow-slave (2026-09-18). It carries
// chapters_count: 3180 today; the site adds chapters daily, so every
// getNovel expectation below is computed from this parsed object, not
// hardcoded to 3180 or to any other number the brief observed on its own
// recon day. See task-3-report.md for what this fixture actually held.
const novelDetail = JSON.parse(novelFixture) as Required<
  Pick<NovelDetailRow, "slug" | "title_ar" | "chapters">
> &
  NovelDetailRow;

// The committed chapter fixture is a live capture of
// https://seanovel.org/novels/shadow-slave/chapters/1 (2026-09-18) — the
// one page this extension cannot read through the JSON API (the chapter
// endpoint 403s with "Invalid or expired token"). As with the two fixtures
// above, every expectation below is derived by parsing this fixture at
// test time, not from a count observed on capture day.
//
// Derivation is intentionally independent of src/index.ts's own
// getChapterContent: it re-walks the DOM here with the same public
// parseHtml/sanitizeText helpers rather than importing anything from
// index.ts, so a broken implementation can't make its own test trivially
// true by sharing buggy logic with the assertion.
const chapterFixture = readFileSync(join(FIXTURES_DIR, "chapter.html"), "utf8");
const chapterDoc = parseHtml(chapterFixture);
const chapterFixtureRoot = chapterDoc.querySelector("article.reader-content");
if (!chapterFixtureRoot) {
  throw new Error("fixture sanity: chapter.html has no article.reader-content — re-capture it");
}
const chapterFixtureParagraphs = Array.from(chapterFixtureRoot.querySelectorAll("p"));
const chapterFixtureSrOnly = chapterFixtureParagraphs.filter((p) =>
  p.classList.contains("sr-only"),
);
const chapterFixtureContentLines = chapterFixtureParagraphs
  .filter((p) => !p.classList.contains("sr-only"))
  .map((p) => sanitizeText(p.textContent))
  .filter((text) => text !== "");

const CHAPTER_URL = `https://seanovel.org/novels/${novelDetail.slug}/chapters/1`;
const chapterHost = () =>
  createTestHost({ responses: { [CHAPTER_URL]: chapterFixture } });

const host = (locale: "en" | "ar" = "ar") =>
  createTestHost({ responses: { "/api/novels": novelsFixture }, locale });

const novelHost = (locale: "en" | "ar" = "ar") =>
  createTestHost({
    responses: { [`/api/novel/${novelDetail.slug}`]: novelFixture },
    locale,
  });

const NOVEL_URL = `https://seanovel.org/novels/${novelDetail.slug}`;

describe("seanovel: createSource", () => {
  it("constructs a Source from a host", () => {
    expect(() => createSource(createTestHost())).not.toThrow();
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

describe("slugFromUrl", () => {
  it("extracts the slug from a novel page URL", () => {
    expect(slugFromUrl(NOVEL_URL)).toBe(novelDetail.slug);
  });

  it("extracts the same slug from one of its chapter page URLs", () => {
    expect(slugFromUrl(`${NOVEL_URL}/chapters/${novelDetail.chapters[0].id}`)).toBe(
      novelDetail.slug,
    );
  });

  it("decodes a percent-encoded slug", () => {
    expect(slugFromUrl("https://seanovel.org/novels/my%20slug")).toBe("my slug");
  });

  it("rejects a URL whose path isn't under /novels/, with SourceUrlError specifically", () => {
    expect(() => slugFromUrl("https://seanovel.org/about")).toThrow(SourceUrlError);
  });

  it("rejects a /novels/ URL with no slug segment at all", () => {
    expect(() => slugFromUrl("https://seanovel.org/novels/")).toThrow(SourceUrlError);
  });
});

describe("getNovel", () => {
  it("maps the API's fields onto SourceNovel", async () => {
    const novel = await createSource(novelHost()).getNovel(NOVEL_URL);
    expect(novel.title).toBe(novelDetail.title_ar);
    expect(novel.originalTitle).toBe(novelDetail.title_original);
    expect(novel.author).toBe(novelDetail.author);
    expect(novel.language).toBe("ar");
    expect(novel.direction).toBe("rtl");
    expect(novel.coverUrl).toContain(`/api/novel/${novelDetail.slug}/cover`);
    expect(novel.tags).toEqual(novelDetail.genres ?? []);
    expect(novel.tags.length).toBeGreaterThan(0);
    expect(novel.description).toBe(novelDetail.description);
    expect(novel.description).toBeTruthy();
    expect(novel.status).toBe(novelDetail.status);
  });

  it("returns one fully-populated volume, not a lazy one", async () => {
    // The fixture's chapters array is a complete list, not a page of one:
    // its length matches chapters_count exactly. That's what "not lazy"
    // means here — nothing is left for a getVolumeChapters call to fetch.
    expect(novelDetail.chapters.length).toBe(novelDetail.chapters_count);

    const source = createSource(novelHost());
    expect(source.hasLazyVolumes).toBeFalsy();
    const novel = await source.getNovel(NOVEL_URL);
    expect(novel.volumes).toHaveLength(1);
    expect(novel.volumes[0].chapters).toHaveLength(novelDetail.chapters.length);
  });

  it("does not warn when the chapter list already matches chapters_count", async () => {
    const logs: Array<{ level: string; message: string }> = [];
    const source = createSource({ ...novelHost(), log: (level, message) => logs.push({ level, message }) });
    await source.getNovel(NOVEL_URL);
    expect(logs.some((l) => l.level === "warn")).toBe(false);
  });

  it("warns (without throwing) when the chapter list disagrees with chapters_count", async () => {
    // The "always one fully-populated volume, never lazy" design rests on
    // `chapters` always matching `chapters_count`. Simulate the API
    // breaking that promise — a truncated or paginated response — by
    // dropping the fixture's last chapter while leaving chapters_count
    // untouched.
    expect(novelDetail.chapters_count).toBeDefined(); // fixture sanity
    const shortChapters = novelDetail.chapters.slice(0, -1);
    expect(shortChapters.length).toBe(novelDetail.chapters_count! - 1); // fixture sanity
    const mismatched = JSON.stringify({ ...novelDetail, chapters: shortChapters });

    const logs: Array<{ level: string; message: string }> = [];
    const source = createSource({
      ...createTestHost({ responses: { [`/api/novel/${novelDetail.slug}`]: mismatched } }),
      log: (level, message) => logs.push({ level, message }),
    });

    const novel = await source.getNovel(NOVEL_URL);
    // Still returns the (short) book rather than failing outright — the
    // chapters that did come back are still a useful, readable novel.
    expect(novel.volumes[0].chapters).toHaveLength(shortChapters.length);

    const warning = logs.find((l) => l.level === "warn");
    expect(warning).toBeDefined();
    expect(warning!.message).toContain(String(novelDetail.chapters_count));
    expect(warning!.message).toContain(String(shortChapters.length));
    expect(warning!.message).toContain(novelDetail.slug);
  });

  it("maps every chapter's id/title onto its own chapter-page URL, in source order", async () => {
    const novel = await createSource(novelHost()).getNovel(NOVEL_URL);
    const expected = novelDetail.chapters.map((c) => ({
      id: c.id,
      title: c.title,
      url: `${NOVEL_URL}/chapters/${c.id}`,
      lines: [],
    }));
    expect(novel.volumes[0].chapters).toEqual(expected);
    expect(novel.volumes[0].chapters[0].title).not.toBe("");
  });

  it("passes a non-integer chapter id straight through, unparsed and uncoerced", async () => {
    // The fixture carries at least one chapter id that is not a plain
    // integer (a fractional/inserted-chapter id like 1841.1). Named
    // explicitly here — not just covered incidentally by the full-array
    // `toEqual` above — so a future edit that "cleans up" chapter ids with
    // e.g. parseInt/Math.round doesn't silently break this novel's chapter
    // URLs. See task-3 fix report for how this was found.
    const oddChapter = novelDetail.chapters.find((c) => !Number.isInteger(c.id));
    expect(oddChapter).toBeDefined(); // fixture sanity: it is known to have one

    const novel = await createSource(novelHost()).getNovel(NOVEL_URL);
    const mapped = novel.volumes[0].chapters.find((c) => c.id === oddChapter!.id);
    expect(mapped).toBeDefined();
    expect(mapped!.url).toBe(`${NOVEL_URL}/chapters/${oddChapter!.id}`);
  });

  it("titles the pseudo-volume via strings(locale), not a raw literal shared by both locales", async () => {
    const novelAr = await createSource(novelHost("ar")).getNovel(NOVEL_URL);
    const novelEn = await createSource(novelHost("en")).getNovel(NOVEL_URL);
    expect(novelAr.volumes[0].id).toBe(1);
    expect(novelAr.volumes[0].title).toBe(strings("ar")("volumeFallback", { n: 1 }));
    expect(novelEn.volumes[0].title).toBe(strings("en")("volumeFallback", { n: 1 }));
    expect(novelAr.volumes[0].title).not.toBe(novelEn.volumes[0].title);
  });

  it("adds distinctly-labelled origin and chapter-count rows to meta", async () => {
    // Fixture sanity check: shadow-slave does carry an origin, so this
    // exercises the "origin present" branch, not just the fallback.
    expect(novelDetail.origin).toBeTruthy();

    const novel = await createSource(novelHost()).getNovel(NOVEL_URL);
    const originRow = novel.meta.find((m) => m.value === novelDetail.origin);
    const countRow = novel.meta.find((m) => m.value === String(novelDetail.chapters_count));
    expect(originRow).toBeDefined();
    expect(countRow).toBeDefined();
    expect(originRow!.label).not.toBe(countRow!.label);
  });

  it("leaves author empty rather than inventing 'Unknown'", async () => {
    const bare = createSource(
      createTestHost({
        responses: {
          "/api/novel/x": JSON.stringify({
            slug: "x",
            title_ar: "بلا",
            genres: [],
            chapters: [],
            chapters_count: 0,
          }),
        },
      }),
    );
    expect((await bare.getNovel("https://seanovel.org/novels/x")).author).toBe("");
  });

  it("falls back to the original title, then the slug, when the payload carries no title_ar", async () => {
    // `NovelDetailRow.title_ar` is typed as required, but the payload is
    // unvalidated JSON and the object guard accepts anything object-shaped
    // — `{}` included. Passing `data.title_ar` straight through therefore
    // put `undefined` on a SourceNovel at runtime, importing as a nameless
    // book. Same fallback chain as `cardFor`.
    const withOriginal = createSource(
      createTestHost({
        responses: {
          "/api/novel/x": JSON.stringify({ slug: "x", title_original: "Shadow Slave" }),
        },
      }),
    );
    expect((await withOriginal.getNovel("https://seanovel.org/novels/x")).title).toBe(
      "Shadow Slave",
    );

    const bare = createSource(
      createTestHost({ responses: { "/api/novel/x": "{}" } }),
    );
    expect((await bare.getNovel("https://seanovel.org/novels/x")).title).toBe("x");
  });

  it("omits the origin meta row (keeping only the chapter-count row) when the API doesn't carry one", async () => {
    const bare = createSource(
      createTestHost({
        responses: {
          "/api/novel/x": JSON.stringify({
            slug: "x",
            title_ar: "بلا",
            genres: [],
            chapters: [],
            chapters_count: 0,
          }),
        },
      }),
    );
    const novel = await bare.getNovel("https://seanovel.org/novels/x");
    expect(novel.meta).toHaveLength(1);
    expect(novel.meta[0].value).toBe("0");
  });

  it("rejects a URL that is not a novel page", async () => {
    const source = createSource(novelHost());
    await expect(source.getNovel("https://seanovel.org/about")).rejects.toThrow(SourceUrlError);
  });
});

describe("malformed API responses", () => {
  it("reports a branded error, not a bare SyntaxError, when /api/novels is not valid JSON", async () => {
    const source = createSource(
      createTestHost({ responses: { "/api/novels": "<html>please enable JavaScript</html>" } }),
    );
    await expect(source.getHomeSections()).rejects.toThrow(
      "Sea Novel: /api/novels did not return JSON (status 200).",
    );
  });

  it("reports a branded error, not a bare SyntaxError, when /api/novel/<slug> is not valid JSON", async () => {
    const source = createSource(
      createTestHost({ responses: { "/api/novel/x": "Service Unavailable" } }),
    );
    await expect(source.getNovel("https://seanovel.org/novels/x")).rejects.toThrow(
      "Sea Novel: /api/novel/x did not return JSON (status 200).",
    );
  });

  it("interpolates the response's real HTTP status, not a hardcoded literal", async () => {
    // createTestHost's stub always answers 200 (see packages/extension-api/src/testing.ts),
    // so the two tests above can't tell "${resp.status}" apart from a
    // hardcoded "200" baked into the message string. This hand-built host
    // answers 503 instead, so only a genuine interpolation passes.
    const host = {
      ...createTestHost(),
      fetch: async () => ({ status: 503, text: "<html>bad gateway</html>", headers: {} }),
    };
    const source = createSource(host);
    await expect(source.getHomeSections()).rejects.toThrow(
      "Sea Novel: /api/novels did not return JSON (status 503).",
    );
  });

  it("reports a branded error when /api/novels returns JSON that is not a list of novels", async () => {
    // Regression test for a previously-uncovered guard: before this task,
    // nothing exercised the `!Array.isArray(rows)` branch at all — an
    // error-shaped or object-shaped body (a WAF/maintenance JSON payload,
    // for instance) would have silently changed behaviour with no test
    // noticing either way.
    const source = createSource(
      createTestHost({ responses: { "/api/novels": JSON.stringify({ error: "blocked" }) } }),
    );
    await expect(source.getHomeSections()).rejects.toThrow(
      "Sea Novel: /api/novels did not return a list of novels.",
    );
  });

  it("reports a branded error when /api/novel/<slug> parses as JSON `null` instead of a novel object", async () => {
    // Regression test for finding F1: a response that parses successfully
    // (so the JSON.parse guard above doesn't fire) as `null` would
    // otherwise reach `data.origin` and throw a raw, unbranded
    // "Cannot read properties of null" TypeError.
    const source = createSource(
      createTestHost({ responses: { "/api/novel/x": JSON.stringify(null) } }),
    );
    await expect(source.getNovel("https://seanovel.org/novels/x")).rejects.toThrow(
      "Sea Novel: /api/novel/x did not return a novel object.",
    );
  });

  it("reports a branded error when /api/novel/<slug> parses as a JSON array instead of a novel object", async () => {
    // Same guard, different wrong shape — an array parses fine as JSON and
    // is a plausible mix-up (e.g. the catalogue endpoint's shape leaking
    // into the wrong route) that `typeof data === "object"` alone would
    // not catch.
    const source = createSource(
      createTestHost({ responses: { "/api/novel/x": JSON.stringify([{ slug: "x" }]) } }),
    );
    await expect(source.getNovel("https://seanovel.org/novels/x")).rejects.toThrow(
      "Sea Novel: /api/novel/x did not return a novel object.",
    );
  });
});

describe("getChapterContent", () => {
  it("returns exactly the fixture's non-sr-only paragraphs, all as non-empty text lines", async () => {
    // Fixture sanity: the captured page actually has sr-only markup to
    // filter and a substantial body — a fixture with neither would make
    // every assertion below vacuously true.
    expect(chapterFixtureSrOnly.length).toBeGreaterThan(0);
    expect(chapterFixtureContentLines.length).toBeGreaterThan(20);

    const source = createSource(chapterHost());
    const lines = await source.getChapterContent({
      id: 1,
      title: "الفصل 1",
      url: CHAPTER_URL,
      lines: [],
    });

    // Exact count, not just "more than a handful": a broken implementation
    // that leaked either sr-only paragraph back in, dropped a real one, or
    // emitted duplicates would land on a different number.
    expect(lines).toHaveLength(chapterFixtureContentLines.length);
    expect(lines.every((l) => l.type === "text")).toBe(true);
    expect(lines.every((l) => l.content.trim() !== "")).toBe(true);
  });

  it("preserves paragraph order — line lengths line up 1:1 with the fixture's paragraph order", async () => {
    // Comparing lengths (not the text itself) is a structural check: a
    // shuffle, a dropped paragraph, or a duplicated one would shift this
    // sequence, without the test needing to embed any chapter prose.
    const source = createSource(chapterHost());
    const lines = await source.getChapterContent({ id: 1, title: "", url: CHAPTER_URL, lines: [] });
    expect(lines.map((l) => l.content.length)).toEqual(
      chapterFixtureContentLines.map((t) => t.length),
    );
  });

  it("drops the leading screen-reader SEO blurb (\"you are reading chapter N of ...\")", async () => {
    const source = createSource(chapterHost());
    const lines = await source.getChapterContent({ id: 1, title: "", url: CHAPTER_URL, lines: [] });
    expect(lines[0].content).not.toMatch(/أنت تقرأ الفصل/);
  });

  it("also drops the TRAILING screen-reader blurb after the body — the brief only named the leading one", async () => {
    // Fixture reality check (see task report): the captured page carries
    // TWO sr-only paragraphs inside article.reader-content, not one — a
    // matching one appears after the last real paragraph
    // ("chapter N of <novel> ended, keep reading on seanovel.org...").
    // Confirm the fixture actually has both before trusting the assertion
    // below. Derived from the fixture's structure rather than asserted as
    // a bare count: the expected shape is exactly one sr-only paragraph
    // before the real body and exactly one after it, with none in
    // between — assert that shape directly so the assertion documents
    // *why* two is the right number, not just that it is.
    expect(chapterFixtureParagraphs[0].classList.contains("sr-only")).toBe(true);
    expect(chapterFixtureParagraphs.at(-1)?.classList.contains("sr-only")).toBe(true);
    expect(
      chapterFixtureParagraphs.slice(1, -1).every((p) => !p.classList.contains("sr-only")),
    ).toBe(true);
    expect(chapterFixtureSrOnly.length).toBe(2);

    const source = createSource(chapterHost());
    const lines = await source.getChapterContent({ id: 1, title: "", url: CHAPTER_URL, lines: [] });
    expect(lines[lines.length - 1].content).not.toMatch(/انتهى الفصل/);
    expect(lines.some((l) => /أنت تقرأ الفصل|انتهى الفصل/.test(l.content))).toBe(false);
  });

  it("fetches exactly chapter.url, never rebuilding it from chapter.id (which may be a non-integer)", async () => {
    // Carried forward from task 3: chapter ids are non-contiguous and not
    // all integers (e.g. 1841.1). getChapterContent must never parse,
    // truncate, or otherwise rebuild a URL from chapter.id — it only ever
    // has to fetch the URL it was already given.
    const calls: Array<{ url: string; method: string }> = [];
    const oddUrl = `${NOVEL_URL}/chapters/1841.1`;
    const source = createSource(
      createTestHost({ responses: { [oddUrl]: chapterFixture }, calls }),
    );
    await source.getChapterContent({ id: 1841.1, title: "", url: oddUrl, lines: [] });
    expect(calls.some((c) => c.url === oddUrl && c.method === "GET")).toBe(true);
  });

  it("throws specifically for the missing container, not by falling through to the zero-lines guard", async () => {
    // Deliberately NOT an empty <body>: the body here has real, non-empty
    // paragraph text — just not inside article.reader-content. A tamper
    // that fell back to `doc.body` (or any other container) when the
    // selector misses would find this text and return it as chapter
    // lines rather than throwing at all, so this fixture is the one that
    // actually exercises the "container not found" branch on its own —
    // an empty <body> would also satisfy the (separate) "parsed to zero
    // lines" guard and pass even if the container check were deleted.
    const wrongContainer = createSource(
      createTestHost({
        responses: {
          "/chapters/9": `<html><body><div class="not-the-reader"><p>محتوى خارج الحاوية الصحيحة تمامًا.</p></div></body></html>`,
        },
      }),
    );
    await expect(
      wrongContainer.getChapterContent({
        id: 9,
        title: "",
        url: "https://seanovel.org/novels/x/chapters/9",
        lines: [],
      }),
    ).rejects.toThrow(/article\.reader-content/i);
  });

  it("throws when the container is missing from an otherwise truly empty page", async () => {
    // Tightened to the specific missing-container message
    // ("no chapter body (article.reader-content)") rather than the looser
    // /reader-content|chapter body/i used previously: that looser regex
    // also matches the OTHER guard's message ("chapter body ... parsed
    // to zero lines"), so this test stayed green even under a tamper that
    // deleted the container check and fell back to querying paragraphs
    // from some other root — a zero-paragraph body still trips the
    // zero-lines guard, and its message satisfies the same loose regex.
    // The adjacent "throws specifically for the missing container" test
    // above already catches that tamper (its page has real text outside
    // the container, so a fallback would return it instead of throwing),
    // so this test is deliberately narrowed to assert the exact branch it
    // names rather than dropped, for fidelity to the brief's literal case.
    const empty = createSource(
      createTestHost({ responses: { "/chapters/9": "<html><body></body></html>" } }),
    );
    await expect(
      empty.getChapterContent({
        id: 9,
        title: "",
        url: "https://seanovel.org/novels/x/chapters/9",
        lines: [],
      }),
    ).rejects.toThrow(/no chapter body \(article\.reader-content\)/i);
  });

  it("throws rather than silently returning [] when the container exists but has no usable text", async () => {
    // Every paragraph present is sr-only, so after filtering there is
    // nothing left — this must fail loudly, not hand back an empty
    // chapter that looks successful.
    const onlyBlurb = createSource(
      createTestHost({
        responses: {
          "/chapters/9": `<html><body><article class="reader-content"><p class="sr-only">x</p></article></body></html>`,
        },
      }),
    );
    await expect(
      onlyBlurb.getChapterContent({
        id: 9,
        title: "",
        url: "https://seanovel.org/novels/x/chapters/9",
        lines: [],
      }),
    ).rejects.toThrow(/zero lines|chapter body/i);
  });
});
