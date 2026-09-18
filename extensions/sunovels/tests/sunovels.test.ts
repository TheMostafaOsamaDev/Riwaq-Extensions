import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import createSource, {
  BASE_URL,
  chapterPageUrl,
  parseChapterLines,
  parseChapterRows,
  parseChaptersCount,
  parseNovelPage,
  slugFromUrl,
} from "../src/index";
import { createTestHost } from "@riwaq/extension-api/testing";
import { parseHtml, SourceUrlError } from "@riwaq/extension-api";

// Deliberately not `readFileSync(new URL("./fixtures/novel.html", import.meta.url), ...)`:
// this suite runs under `environment: "happy-dom"` (see vitest.config.ts), and
// happy-dom's patched global `URL` silently resolves a *relative* two-argument
// `new URL(href, base)` against its fake `window.location` instead of the given
// file: base. `fileURLToPath` on this file's own `import.meta.url` (no relative
// resolution involved) plus plain path-segment arithmetic sidesteps it entirely
// (see extensions/cenele/tests/cenele.test.ts for the same pattern).
const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");
const novelHtml = readFileSync(join(FIXTURES_DIR, "novel.html"), "utf8");
const chaptersPage0Html = readFileSync(join(FIXTURES_DIR, "chapters-page0.html"), "utf8");
const chaptersPage1Html = readFileSync(join(FIXTURES_DIR, "chapters-page1.html"), "utf8");
const chapterHtml = readFileSync(join(FIXTURES_DIR, "chapter.html"), "utf8");
// parseChapterRows takes the fetched page's own URL now (used only to name
// the offending page when the chapter-list container is missing) — these
// mirror exactly what getVolumeChapters itself would have fetched.
const CHAPTERS_PAGE0_URL = chapterPageUrl("shadow-slave", 0);
const CHAPTERS_PAGE1_URL = chapterPageUrl("shadow-slave", 1);
// The captured fixture is chapter 1 of shadow-slave (confirmed against the
// page's own embedded `"url":"https://sunovels.com/novel/shadow-slave/1"`).
const CHAPTER_URL = "https://sunovels.com/novel/shadow-slave/1";

// Every real (non-decoy) paragraph in the fixture is a bare `<p>...</p>`
// with no attributes and no nested markup; every decoy is the exact
// literal `<p class="d-none">...</p>`. Both facts are asserted on below,
// not assumed — so these three counts are independent of parseChapterLines
// itself (plain substring counts over the raw file, not a DOM query), and
// give the "real non-empty line" total parseChapterLines must reproduce.
const FIXTURE_DECOY_COUNT = (chapterHtml.match(/<p class="d-none">/g) ?? []).length;
const FIXTURE_BARE_P_COUNT = (chapterHtml.match(/<p>/g) ?? []).length;
const FIXTURE_EMPTY_BARE_P_COUNT = (chapterHtml.match(/<p><\/p>/g) ?? []).length;
const EXPECTED_CHAPTER_LINE_COUNT = FIXTURE_BARE_P_COUNT - FIXTURE_EMPTY_BARE_P_COUNT;
// The fixture's dialogue-heavy prose is riddled with literal `&quot;`/
// `&#x27;` character references (78 and 2 occurrences respectively inside
// the container) — decoded by any real HTML parser (including the one
// parseChapterLines itself runs on) into a single `"`/`'` each, but NOT
// decoded by the raw regex walk below. Without unescaping them here first,
// every paragraph containing one would come out longer in this
// independent count than in the parser's real output, for a reason that
// has nothing to do with paragraph selection. This only reverses the small,
// fixed set of entities this fixture actually uses — it does not parse
// markup, so it stays independent of parseChapterLines.
function decodeBasicEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// Ordered, independently of the DOM entirely: a plain regex walk over the
// raw text from the container's own opening tag, collecting only bare
// `<p>...</p>` matches (which — because decoys are written as `<p
// class="d-none">`, a different literal opening tag — already skips every
// decoy without needing to inspect content) and recording each survivor's
// sanitized length rather than its text. Length, not content, is what's
// compared against the real parser's output below, per this task's rule
// against embedding chapter prose in assertions — but the sequence is
// diverse enough (68 distinct lengths across 90 entries, not sorted) that
// a reordering or a dropped/duplicated line would still change it.
const EXPECTED_CHAPTER_LINE_LENGTHS = Array.from(
  chapterHtml.slice(chapterHtml.indexOf("chapter-content")).matchAll(/<p>([^<]*)<\/p>/g),
)
  .map((m) => decodeBasicEntities(m[1]).replace(/\s+/g, " ").trim())
  .filter((text) => text.length > 0)
  .map((text) => text.length);

// Independently derived from the fixture at run time, via a code path
// `parseChaptersCount` does NOT use (the page's `application/ld+json` block,
// not the `self.__next_f.push` RSC payload). If both agree, that's real
// confirmation of the fixture's actual count rather than a copy of the
// brief's example figure — and if the fixture is ever recaptured against a
// site that has gained chapters, this constant moves with it instead of
// silently going stale.
const EXPECTED_CHAPTERS_COUNT = (() => {
  const m = novelHtml.match(/"numberOfPages":(\d+)/);
  if (!m) {
    throw new Error(
      "fixture: couldn't independently derive the chapter count from the ld+json numberOfPages field — fixture may have changed shape.",
    );
  }
  return Number.parseInt(m[1], 10);
})();

// Every method on the scaffolded Source still throws "not implemented"
// except `canHandle` (Task 1) and `getNovel` (this task). As each
// remaining method is implemented, delete its assertion below and replace
// it with a real test against fixture HTML saved under tests/fixtures/.

describe("sunovels: createSource", () => {
  it("constructs a Source from a host", () => {
    expect(() => createSource(createTestHost())).not.toThrow();
  });

  it("getHomeSections is not implemented yet", async () => {
    const source = createSource(createTestHost());
    await expect(source.getHomeSections()).rejects.toThrow("not implemented");
  });

  it("search is not implemented yet", async () => {
    const source = createSource(createTestHost());
    await expect(source.search("query")).rejects.toThrow("not implemented");
  });
});

describe("canHandle", () => {
  const source = createSource(createTestHost());

  it("accepts novel and chapter URLs", () => {
    expect(source.canHandle("https://sunovels.com/novel/shadow-slave")).toBe(true);
    expect(source.canHandle("https://sunovels.com/novel/shadow-slave/12")).toBe(true);
    expect(source.canHandle("https://www.sunovels.com/novel/x")).toBe(true);
  });

  it("rejects other sites and malformed input", () => {
    expect(source.canHandle("https://seanovel.org/novels/x")).toBe(false);
    expect(source.canHandle("nonsense")).toBe(false);
  });

  // A previous extension in this programme shipped a `canHandle` whose
  // test suite could not distinguish it from a plain substring match:
  // "notsunovels.com".includes("sunovels.com") is true, and so is the
  // leading label of "sunovels.com.evil.com". Both must be false — a
  // substring/prefix/suffix check on the raw URL or hostname would wrongly
  // accept one or both of these.
  it("rejects near-miss hostnames that a substring check would wrongly accept", () => {
    // Prefixed domain: "sunovels.com" is a suffix of the hostname, but the
    // hostname itself is a different, unrelated registrable domain.
    expect(source.canHandle("https://notsunovels.com/novel/x")).toBe(false);
    // The real host appears only as a subdomain label of another domain.
    expect(source.canHandle("https://sunovels.com.evil.com/novel/x")).toBe(false);
  });

  // The two cases above also pass a `hostname === "sunovels.com" ||
  // hostname.endsWith(".sunovels.com")` suffix check — it rejects both
  // near-misses exactly like the real Set does. What a suffix check would
  // NOT reject is an arbitrary subdomain, which the exact two-host `Set`
  // deliberately excludes (no wildcard mirrors are known for this site).
  it("rejects an arbitrary subdomain not in the exact hostname set", () => {
    expect(source.canHandle("https://cdn.sunovels.com/novel/x")).toBe(false);
  });
});

describe("slugFromUrl", () => {
  it("extracts the slug from a bare novel URL", () => {
    expect(slugFromUrl("https://sunovels.com/novel/shadow-slave")).toBe("shadow-slave");
  });

  it("extracts the slug from a novel URL with a trailing chapter number", () => {
    expect(slugFromUrl("https://sunovels.com/novel/shadow-slave/12")).toBe("shadow-slave");
  });

  it("decodes a percent-encoded slug", () => {
    expect(slugFromUrl("https://sunovels.com/novel/%D8%B8%D9%84")).toBe("ظل");
  });

  it("throws SourceUrlError for a URL that is not a novel page", () => {
    expect(() => slugFromUrl("https://sunovels.com/")).toThrow(SourceUrlError);
    expect(() => slugFromUrl("https://sunovels.com/search?q=x")).toThrow(SourceUrlError);
  });

  // Pins the "novel" path segment itself, not merely "the path has at
  // least two segments". A mutant like /^\/([^/]+)\/([^/]+)/ — any
  // two-segment path, capture the second — passes every case above: both
  // novel-URL cases still extract correctly, and "/" and "/search?q=x"
  // still throw because they have fewer than two segments. Without this
  // case, nothing distinguishes that mutant from the real implementation.
  // "/chapter/5" has a real second segment ("5") but the wrong first one
  // ("chapter"), so it only throws when "novel" is actually enforced.
  it("throws SourceUrlError for a non-novel path with a real second segment", () => {
    expect(() => slugFromUrl("https://sunovels.com/chapter/5")).toThrow(SourceUrlError);
  });
});

describe("parseChaptersCount", () => {
  it("reads the count out of the RSC payload, independently cross-checked", () => {
    // Cross-checked above against ld+json's numberOfPages, a field this
    // function never touches — the two agreeing is evidence the fixture's
    // count really is what we think it is, not a coincidence of a shared
    // hardcoded literal.
    expect(parseChaptersCount(novelHtml)).toBe(EXPECTED_CHAPTERS_COUNT);
  });

  // Pins that the count is NOT the highest chapter number. This novel's
  // fixture holds chapters whose newest is numbered well past its
  // chaptersCount (1611 on the day this fixture was captured) — a wrong
  // implementation that scraped "highest chapter number" instead of the
  // payload's own count would produce a materially different, provably
  // wrong value here.
  it("is not the same thing as the highest chapter number in the fixture", () => {
    const chapterNumbers = Array.from(novelHtml.matchAll(/\/novel\/shadow-slave\/(\d+)/g)).map(
      (m) => Number.parseInt(m[1], 10),
    );
    expect(chapterNumbers.length).toBeGreaterThan(0);
    const highest = Math.max(...chapterNumbers);
    expect(parseChaptersCount(novelHtml)).not.toBe(highest);
  });

  it("returns 0 when the payload has no chaptersCount field", () => {
    expect(parseChaptersCount("<html><body>no payload here</body></html>")).toBe(0);
  });

  // Tamper target: a mutant that captures the wrong group, or that drops
  // the `\s*`, would still pass the two tests above by accident if it
  // happened to grab an adjacent number. This pins the exact numeric
  // value character-for-character, so any digit mismatch fails loudly.
  it("parses a synthetic payload with the escaped-quote shape byte for byte", () => {
    const html = String.raw`<script>self.__next_f.push([1,"29:...,\"chaptersCount\":42,..."]</script>`;
    expect(parseChaptersCount(html)).toBe(42);
  });
});

describe("parseNovelPage", () => {
  const FIXTURE_URL = "https://sunovels.com/novel/shadow-slave";

  // Exercises the fixture's actual markup shape, independent of the
  // async getNovel plumbing (host.fetch, strings(), volume assembly).
  const parse = () =>
    parseNovelPage(new DOMParser().parseFromString(novelHtml, "text/html"), FIXTURE_URL);

  it("takes the Arabic title from h3 and the original from h1, scoped to .main-head", () => {
    // Inverted relative to seanovel: here h1 is the ORIGINAL title. The
    // page also carries an unscoped h1 ("شمس الروايات", the site's own
    // name) — if this read from a bare `querySelector("h1")` instead of
    // `.main-head h1`, both title and originalTitle below would come back
    // wrong, but in a way that would still look like plausible strings.
    const parsed = parse();
    expect(parsed.title).toBe("عبد الظل");
    expect(parsed.originalTitle).toBe("Shadow Slave");
  });

  // The fixture always has both h1 and h3, so this exercises the h3-absent
  // fallback path directly on synthetic markup — nothing in the committed
  // fixture would ever hit this branch, so without this test the fallback
  // could be deleted or broken and every other test would stay green.
  it("falls back title to h1 when h3 is absent", () => {
    const doc = new DOMParser().parseFromString(
      `<div class="main-head"><h1>Only Original</h1></div>`,
      "text/html",
    );
    const parsed = parseNovelPage(doc, FIXTURE_URL);
    expect(parsed.title).toBe("Only Original");
    expect(parsed.originalTitle).toBe("Only Original");
  });

  // Fix round 1, F1: a missing `.main-head` (layout change, an anti-bot
  // interstitial or error page served with HTTP 200, a redirect elsewhere)
  // must not silently produce a structurally valid but empty SourceNovel —
  // that reads identically to a real novel with no title, which never
  // happens on this site. The message assertion (not just `.toThrow()`)
  // guards against a mutant that throws for some unrelated, incidental
  // reason and would otherwise satisfy a bare "it throws" check too.
  it("throws instead of returning a hollow novel when .main-head is missing entirely", () => {
    const doc = new DOMParser().parseFromString(
      `<html><body><p>Service temporarily unavailable.</p></body></html>`,
      "text/html",
    );
    expect(() => parseNovelPage(doc, FIXTURE_URL)).toThrow(/main-head|title/i);
  });

  // Same guard, the case the reviewer allowed as equivalent: the
  // container is present but both h1 and h3 inside it are empty/absent,
  // so the derived title is still "".
  it("throws when .main-head is present but yields no title at all", () => {
    const doc = new DOMParser().parseFromString(`<div class="main-head"></div>`, "text/html");
    expect(() => parseNovelPage(doc, FIXTURE_URL)).toThrow(/main-head|title/i);
  });

  it("absolutises the site-relative cover path", () => {
    // Cross-checked against a fresh regex over the raw fixture, not just
    // "matches the https://.../uploads/ prefix" — pins the exact filename
    // too, so a selector that grabbed the wrong <img> (e.g. a related-
    // novel thumbnail elsewhere on the page) would be caught even though
    // it would still satisfy a bare prefix match.
    const srcMatch = novelHtml.match(/<figure class="cover"><img[^>]*\ssrc="([^"]+)"/);
    if (!srcMatch) throw new Error("fixture: couldn't independently find the cover <img src>.");
    const parsed = parse();
    expect(parsed.coverUrl).toBe(`${BASE_URL}${srcMatch[1]}`);
    expect(parsed.coverUrl).toMatch(/^https:\/\/sunovels\.com\/uploads\//);
  });

  it("collects the tag chips, matching every a.tag on the fixture", () => {
    // Cross-checked against an independent count of `class="tag"` in the
    // raw fixture text, so a selector that only grabbed the first chip (or
    // that also picked up an unrelated element) would be caught even
    // though "at least one non-empty tag" alone would not catch either.
    const rawTagCount = (novelHtml.match(/class="tag"/g) ?? []).length;
    const parsed = parse();
    expect(rawTagCount).toBeGreaterThan(0);
    expect(parsed.tags).toHaveLength(rawTagCount);
    expect(parsed.tags.every((t) => t.trim() !== "")).toBe(true);
  });
});

describe("getNovel", () => {
  const source = createSource(
    createTestHost({ responses: { "/novel/shadow-slave": novelHtml }, locale: "ar" }),
  );

  it("takes the Arabic title from h3 and the original from h1", async () => {
    const novel = await source.getNovel("https://sunovels.com/novel/shadow-slave");
    expect(novel.title).toBe("عبد الظل");
    expect(novel.originalTitle).toBe("Shadow Slave");
  });

  it("absolutises the site-relative cover path", async () => {
    const novel = await source.getNovel("https://sunovels.com/novel/shadow-slave");
    expect(novel.coverUrl).toMatch(/^https:\/\/sunovels\.com\/uploads\//);
  });

  it("collects the tag chips", async () => {
    const novel = await source.getNovel("https://sunovels.com/novel/shadow-slave");
    expect(novel.tags.length).toBeGreaterThan(0);
    expect(novel.tags.every((t) => t.trim() !== "")).toBe(true);
  });

  // The page surfaces no author anywhere in its rendered markup (verified
  // against the live site) — "" is the deliberate contract, not a gap.
  // A wrong implementation that invented a literal "Unknown" would fail
  // this, and so would one that quietly dropped the field (undefined !== "").
  it("leaves author empty rather than inventing an Unknown placeholder", async () => {
    const novel = await source.getNovel("https://sunovels.com/novel/shadow-slave");
    expect(novel.author).toBe("");
  });

  it("declares one lazy volume carrying the real chapter count, keyed by slug", async () => {
    expect(source.hasLazyVolumes).toBe(true);
    const novel = await source.getNovel("https://sunovels.com/novel/shadow-slave");
    expect(novel.volumes).toHaveLength(1);
    expect(novel.volumes[0].chapters).toEqual([]);
    expect(novel.volumes[0].chapterCount).toBe(EXPECTED_CHAPTERS_COUNT);
    // key carries the slug forward for Task 3's getVolumeChapters to
    // rebuild the paginated chapter-list URL from.
    expect(novel.volumes[0].key).toBe("shadow-slave");
  });

  // The test above uses a novel whose own slug happens to spell
  // "shadow-slave" — a hardcoded `key: "shadow-slave"` literal in the
  // implementation would pass it by coincidence. Requesting a second,
  // differently-slugged novel and checking `key` tracks THAT slug closes
  // that gap: a hardcoded literal fails this one instead.
  it("keys the volume by the requested novel's own slug, not a hardcoded literal", async () => {
    const minimalHtml = `<html><body>
      <div class="main-head"><h1>Other Book</h1><h3>كتاب آخر</h3></div>
      <script>self.__next_f = self.__next_f || []; self.__next_f.push([1,"x:{\\"chaptersCount\\":7}"]);</script>
    </body></html>`;
    const otherSource = createSource(
      createTestHost({ responses: { "/novel/other-book": minimalHtml } }),
    );
    const novel = await otherSource.getNovel("https://sunovels.com/novel/other-book");
    expect(novel.volumes[0].key).toBe("other-book");
    expect(novel.volumes[0].chapterCount).toBe(7);
  });

  it("titles the lazy volume with the locale's own string, not a hardcoded English literal", async () => {
    const arSource = createSource(
      createTestHost({ responses: { "/novel/shadow-slave": novelHtml }, locale: "ar" }),
    );
    const enSource = createSource(
      createTestHost({ responses: { "/novel/shadow-slave": novelHtml }, locale: "en" }),
    );
    const arNovel = await arSource.getNovel("https://sunovels.com/novel/shadow-slave");
    const enNovel = await enSource.getNovel("https://sunovels.com/novel/shadow-slave");
    expect(arNovel.volumes[0].title).not.toBe(enNovel.volumes[0].title);
    expect(arNovel.volumes[0].title.trim()).not.toBe("");
    expect(enNovel.volumes[0].title.trim()).not.toBe("");
  });

  it("is rtl Arabic", async () => {
    const novel = await source.getNovel("https://sunovels.com/novel/shadow-slave");
    expect(novel.language).toBe("ar");
    expect(novel.direction).toBe("rtl");
  });

  // Fix round 1, F1, at the getNovel level: a fetch that returns something
  // other than a real novel page (an anti-bot interstitial or an error
  // page served with HTTP 200, say) must reject rather than resolve to a
  // hollow SourceNovel with an empty title, empty tags and no cover — a
  // blank card that looks like the site has nothing, indistinguishable
  // from legitimate absence.
  it("rejects rather than resolving to a hollow novel when the page has no .main-head", async () => {
    const blockedSource = createSource(
      createTestHost({
        responses: { "/novel/blocked": `<html><body><p>Access denied.</p></body></html>` },
      }),
    );
    await expect(blockedSource.getNovel("https://sunovels.com/novel/blocked")).rejects.toThrow(
      /main-head|title/i,
    );
  });
});

describe("chapterPageUrl", () => {
  it("uses a 0-indexed page parameter", () => {
    // The site's own pagination starts at 0 — a 1-indexed guess would
    // silently drop the first fifty chapters of every novel.
    expect(chapterPageUrl("shadow-slave", 0)).toBe(
      "https://sunovels.com/novel/shadow-slave?activeTab=chapters&page=0",
    );
    expect(chapterPageUrl("shadow-slave", 1)).toBe(
      "https://sunovels.com/novel/shadow-slave?activeTab=chapters&page=1",
    );
  });
});

describe("parseChapterRows", () => {
  it("parses only chapter-list rows, not the header's first/latest shortcuts", () => {
    // The page header links the first and newest chapters on EVERY page.
    // Counting those would duplicate chapter 1 into all 32 pages.
    const rows = parseChapterRows(parseHtml(chaptersPage0Html), "shadow-slave", CHAPTERS_PAGE0_URL);
    expect(rows.length).toBeLessThanOrEqual(50);
    expect(rows.filter((c) => c.url.endsWith("/1"))).toHaveLength(1);
  });

  // Stronger than the length check above: derives, independently of
  // parseChapterRows itself, the exact chapter number that appears ONLY
  // in the header/"last read" shortcuts on this page (not inside
  // `.chaptersList` at all) — for the committed fixture that's the
  // newest chapter, which does not belong on page 0's 1..50 range. If
  // scoping to `.chaptersList` were ever dropped, that number would leak
  // into this page's rows; a test that only bounds the row COUNT can be
  // satisfied by coincidence (e.g. if de-duplication happened to also
  // absorb the leak), so this pins the specific chapter id instead.
  it("excludes a header-only chapter number that isn't part of this page's real range", () => {
    const listMatch = chaptersPage0Html.match(/<ul class="chaptersList">([\s\S]*?)<\/ul>/);
    if (!listMatch) {
      throw new Error("fixture: couldn't independently find the .chaptersList markup.");
    }
    const listNums = new Set(
      Array.from(listMatch[1].matchAll(/href="\/novel\/shadow-slave\/(\d+)"/g)).map((m) =>
        Number.parseInt(m[1], 10),
      ),
    );
    const allNums = Array.from(
      chaptersPage0Html.matchAll(/href="\/novel\/shadow-slave\/(\d+)"/g),
    ).map((m) => Number.parseInt(m[1], 10));
    const headerOnlyNums = new Set(allNums.filter((n) => !listNums.has(n)));
    expect(headerOnlyNums.size).toBeGreaterThan(0);

    const rows = parseChapterRows(parseHtml(chaptersPage0Html), "shadow-slave", CHAPTERS_PAGE0_URL);
    for (const n of headerOnlyNums) {
      expect(rows.some((c) => c.id === n)).toBe(false);
    }
    // And every real row IS accounted for — this side isn't vacuous.
    expect(rows.map((c) => c.id).sort((a, b) => a - b)).toEqual(
      Array.from(listNums).sort((a, b) => a - b),
    );
  });

  it("returns the second page's chapters, not the first's", () => {
    const p0 = parseChapterRows(parseHtml(chaptersPage0Html), "shadow-slave", CHAPTERS_PAGE0_URL);
    const p1 = parseChapterRows(parseHtml(chaptersPage1Html), "shadow-slave", CHAPTERS_PAGE1_URL);
    expect(p1[0].url).not.toBe(p0[0].url);
    expect(new Set([...p0, ...p1].map((c) => c.url)).size).toBe(p0.length + p1.length);
  });

  it("gives every chapter a non-empty title and an absolute URL", () => {
    for (const c of parseChapterRows(parseHtml(chaptersPage0Html), "shadow-slave", CHAPTERS_PAGE0_URL)) {
      expect(c.title.trim()).not.toBe("");
      expect(c.url).toMatch(/^https:\/\/sunovels\.com\/novel\/shadow-slave\/\d+$/);
    }
  });

  // Cross-checked against an independent regex over the raw fixture
  // rather than just "non-empty" — catches a selector that grabbed the
  // wrong text (e.g. the whole `<li>`, which also carries the date and
  // view count) even though that text would still be non-empty.
  it("extracts the exact chapter-title text, cross-checked against the raw fixture", () => {
    const m = chaptersPage0Html.match(/<strong class="chapter-title">([^<]*)<\/strong>/);
    if (!m) throw new Error("fixture: couldn't independently find a chapter-title span.");
    const rows = parseChapterRows(parseHtml(chaptersPage0Html), "shadow-slave", CHAPTERS_PAGE0_URL);
    const first = rows.find((c) => c.id === 1);
    expect(first).toBeDefined();
    expect(first!.title).toBe(m[1]);
  });

  // A genuinely EMPTY container (the real end of the list — no more
  // chapters exist past this page) must still return [] quietly, not
  // throw. This is the case the guard below must NOT trip on.
  it("returns an empty array for a present but empty chapter-list container", () => {
    const doc = parseHtml(`<html><body><ul class="chaptersList"></ul></body></html>`);
    expect(parseChapterRows(doc, "shadow-slave", CHAPTERS_PAGE0_URL)).toEqual([]);
  });

  // Fix round 1, F1: a MISSING container — the same 200-status "blocked"
  // shape getNovel's own tests exercise for a missing .main-head — must
  // throw rather than return [], which getVolumeChapters would otherwise
  // treat identically to a genuine end of list and silently truncate the
  // novel at whichever page happened to be blocked. The message assertion
  // (not just `.toThrow()`) also pins that the offending page's URL is
  // named in the error, and guards against a mutant that throws for some
  // unrelated, incidental reason.
  it("throws instead of returning an empty array when .chaptersList is missing entirely", () => {
    const doc = parseHtml(`<html><body><p>Access denied.</p></body></html>`);
    expect(() => parseChapterRows(doc, "shadow-slave", CHAPTERS_PAGE0_URL)).toThrow(
      /chaptersList/i,
    );
    expect(() => parseChapterRows(doc, "shadow-slave", CHAPTERS_PAGE0_URL)).toThrow(
      new RegExp(CHAPTERS_PAGE0_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  });
});

describe("getVolumeChapters", () => {
  const twoPageHost = () =>
    createTestHost({
      responses: {
        "activeTab=chapters&page=0": chaptersPage0Html,
        "activeTab=chapters&page=1": chaptersPage1Html,
      },
      locale: "ar",
    });

  it("walks every page implied by chapterCount and de-duplicates across them", async () => {
    const src = createSource(twoPageHost());
    const chapters = await src.getVolumeChapters!("https://sunovels.com/novel/shadow-slave", {
      id: 1,
      title: "all",
      chapters: [],
      chapterCount: 100,
      key: "shadow-slave",
    });
    expect(new Set(chapters.map((c) => c.url)).size).toBe(chapters.length);
    expect(chapters).toHaveLength(100);
  });

  // The test above cannot fail from a missing de-dup step alone: the two
  // real fixture pages happen to carry disjoint chapter ranges (1-50,
  // 51-100), so even with zero cross-page de-duplication the concatenated
  // result would already be unique. This test forces genuine overlap —
  // page 1 is deliberately made to answer with page 0's own markup — so
  // removing the de-dup `Set` in getVolumeChapters is the only way this
  // one goes red.
  it("de-duplicates when two fetched pages genuinely return overlapping chapter urls", async () => {
    const host = createTestHost({
      responses: {
        "activeTab=chapters&page=0": chaptersPage0Html,
        "activeTab=chapters&page=1": chaptersPage0Html,
      },
    });
    const src = createSource(host);
    const chapters = await src.getVolumeChapters!("https://sunovels.com/novel/shadow-slave", {
      id: 1,
      title: "all",
      chapters: [],
      chapterCount: 100,
      key: "shadow-slave",
    });
    expect(chapters).toHaveLength(50);
    expect(new Set(chapters.map((c) => c.url)).size).toBe(50);
  });

  it("derives the page count from chapterCount rather than a hardcoded number of pages", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const host = createTestHost({
      responses: {
        "activeTab=chapters&page=0": chaptersPage0Html,
        "activeTab=chapters&page=1": chaptersPage1Html,
      },
      calls,
    });
    const src = createSource(host);
    // chapterCount worth exactly one page (50) must fetch ONLY page 0 —
    // an implementation that ignores chapterCount and always walks every
    // fixture it can find would over-fetch here and this would catch it,
    // even though page 1's fixture is readily available and would
    // "succeed" if fetched.
    const chapters = await src.getVolumeChapters!("https://sunovels.com/novel/shadow-slave", {
      id: 1,
      title: "all",
      chapters: [],
      chapterCount: 50,
      key: "shadow-slave",
    });
    expect(chapters).toHaveLength(50);
    expect(calls).toHaveLength(1);
  });

  it("still fetches at least one page when chapterCount is 0", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const host = createTestHost({
      responses: { "activeTab=chapters&page=0": chaptersPage0Html },
      calls,
    });
    const src = createSource(host);
    const chapters = await src.getVolumeChapters!("https://sunovels.com/novel/shadow-slave", {
      id: 1,
      title: "all",
      chapters: [],
      chapterCount: 0,
      key: "shadow-slave",
    });
    expect(calls).toHaveLength(1);
    expect(chapters).toHaveLength(50);
  });

  it("stops fetching once a page yields no rows, without erroring on later pages", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const host = createTestHost({
      responses: {
        "activeTab=chapters&page=0": chaptersPage0Html,
        "activeTab=chapters&page=1": chaptersPage1Html,
        "activeTab=chapters&page=2": `<html><body><ul class="chaptersList"></ul></body></html>`,
        // Deliberately no fixture for page=3 or page=4: chapterCount
        // below implies 5 pages total. If the implementation kept
        // walking past page 2's empty result instead of stopping, the
        // next fetch would reject with "no text fixture for ..." and
        // this whole call would reject instead of resolving.
      },
      calls,
    });
    const src = createSource(host);
    const chapters = await src.getVolumeChapters!("https://sunovels.com/novel/shadow-slave", {
      id: 1,
      title: "all",
      chapters: [],
      chapterCount: 250, // Math.ceil(250 / 50) = 5 pages
      key: "shadow-slave",
    });
    expect(chapters).toHaveLength(100);
    expect(calls).toHaveLength(3);
  });

  // Fix round 1, F1: a blocked/errored page and the genuine end of the
  // list are NOT the same thing, and getVolumeChapters must not conflate
  // them. Page 1 here answers with the same 200-status "blocked" shape
  // getNovel's own tests use for a missing .main-head (no .chaptersList
  // at all) — chapterCount implies more pages exist beyond it, so this
  // is a mid-sequence failure, not a real end of list. Before this fix,
  // parseChapterRows returned [] for both "missing" and "empty", so the
  // loop's `if (rows.length === 0) break` would silently truncate the
  // novel to just page 0's 50 chapters, with nothing anywhere signalling
  // that anything went wrong. Now it must reject instead.
  it("rejects rather than silently truncating when a mid-sequence page is blocked/errored", async () => {
    const host = createTestHost({
      responses: {
        "activeTab=chapters&page=0": chaptersPage0Html,
        "activeTab=chapters&page=1": `<html><body><p>Access denied.</p></body></html>`,
      },
    });
    const src = createSource(host);
    await expect(
      src.getVolumeChapters!("https://sunovels.com/novel/shadow-slave", {
        id: 1,
        title: "all",
        chapters: [],
        chapterCount: 100, // Math.ceil(100 / 50) = 2 pages — page 1 is real, not past the end
        key: "shadow-slave",
      }),
    ).rejects.toThrow(/chaptersList/i);
  });

  it("builds the chapter-list URL from the volume's key, not by re-deriving the slug from novelUrl", async () => {
    const src = createSource(twoPageHost());
    // novelUrl deliberately names a DIFFERENT slug than volume.key. This
    // does NOT reject with "no text fixture for ..." if the
    // implementation ignores volume.key — twoPageHost's fixture keys are
    // the bare "activeTab=chapters&page=N" query strings, which the test
    // host matches by substring, so a fetch to
    // ".../novel/not-the-real-slug?activeTab=chapters&page=0" still
    // resolves to page0's HTML either way. What actually catches an
    // implementation that re-derived the slug from novelUrl is
    // parseChapterRows's row selector: fed "not-the-real-slug" instead of
    // "shadow-slave", `a[href^="/novel/not-the-real-slug/"]` matches zero
    // of the fixture's real anchors, so `chapters` comes back empty and
    // the assertion below fails.
    const chapters = await src.getVolumeChapters!(
      "https://sunovels.com/novel/not-the-real-slug",
      { id: 1, title: "all", chapters: [], chapterCount: 100, key: "shadow-slave" },
    );
    expect(chapters.length).toBeGreaterThan(0);
  });

  it("fetches chapter pages sequentially, never more than one in flight", async () => {
    const base = twoPageHost();
    let inFlight = 0;
    let maxInFlight = 0;
    const host: typeof base = {
      ...base,
      async fetch(url, opts) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Yield the event loop before resolving: a caller that fired
        // page 1's request without awaiting page 0's first would have
        // both in flight at once when this runs for the second call.
        await new Promise((resolve) => setTimeout(resolve, 0));
        const result = await base.fetch(url, opts);
        inFlight--;
        return result;
      },
    };
    const src = createSource(host);
    await src.getVolumeChapters!("https://sunovels.com/novel/shadow-slave", {
      id: 1,
      title: "all",
      chapters: [],
      chapterCount: 100,
      key: "shadow-slave",
    });
    expect(maxInFlight).toBe(1);
  });
});

describe("parseChapterLines", () => {
  const parse = () => parseChapterLines(parseHtml(chapterHtml), CHAPTER_URL);

  // The site salts every real paragraph with a matching decoy sibling
  // (`<p class="d-none">`, hidden by a display:none utility class but
  // sitting right in the markup) — every decoy observed carries real,
  // non-empty text, so an implementation that forgot to filter them would
  // not just add a little noise, it would roughly double the fixture's
  // line count. The three counts below (all plain substring counts over
  // the raw fixture, not a DOM query) confirm the fixture actually
  // exercises that: real decoys exist, and at least one real paragraph is
  // itself empty, so "drop empty strings" alone could not accidentally
  // produce the right count without also excluding decoys.
  it("returns exactly the real, non-empty paragraphs — derived from the fixture, not a hardcoded count", () => {
    expect(FIXTURE_DECOY_COUNT).toBeGreaterThan(0);
    expect(FIXTURE_EMPTY_BARE_P_COUNT).toBeGreaterThan(0);
    expect(EXPECTED_CHAPTER_LINE_COUNT).toBeGreaterThan(20);

    const lines = parse();
    expect(lines).toHaveLength(EXPECTED_CHAPTER_LINE_COUNT);
    expect(lines.every((l) => l.type === "text")).toBe(true);
    expect(lines.every((l) => l.content.trim() !== "")).toBe(true);
  });

  // Same fixture, a structural (not textual) fingerprint: each line's
  // content LENGTH, in order. Comparing lengths rather than the sanitized
  // text itself keeps this test off chapter prose while still catching
  // reordering, drops, duplicates or leaked decoys — the length sequence
  // has 68 distinct values across 90 entries and is not sorted, so any of
  // those mutations would change it.
  it("preserves paragraph order and per-paragraph content, checked by length rather than text", () => {
    const lines = parse();
    expect(lines.map((l) => l.content.length)).toEqual(EXPECTED_CHAPTER_LINE_LENGTHS);
  });

  // A synthetic, minimal document pins the exact behavior the fixture-scale
  // tests above can only prove statistically: a decoy with real non-empty
  // text is dropped (not just "empty things are dropped"), an empty real
  // paragraph (a blank-line spacer) is dropped too, and the two survivors
  // come back in document order with their content untouched.
  it("drops a non-empty decoy and an empty spacer, on a synthetic minimal document", () => {
    const doc = parseHtml(
      `<div class="chapter-content">` +
        `<p>First line.</p>` +
        `<p class="d-none">decoy text that is not empty</p>` +
        `<p></p>` +
        `<p>Second line.</p>` +
        `</div>`,
    );
    const lines = parseChapterLines(doc, CHAPTER_URL);
    expect(lines).toEqual([
      { type: "text", content: "First line." },
      { type: "text", content: "Second line." },
    ]);
  });

  // Mirrors parseNovelPage's and parseChapterRows's own guard on a missing
  // container: a page that isn't really a chapter body (an anti-bot
  // interstitial or error page served with HTTP 200, a layout change) must
  // reject by name rather than resolve to an empty chapter indistinguishable
  // from a real chapter with no text.
  it("throws, naming the URL, when .chapter-content is missing entirely", () => {
    const doc = parseHtml(`<html><body><p>Access denied.</p></body></html>`);
    expect(() => parseChapterLines(doc, CHAPTER_URL)).toThrow(/chapter-content|chapter body/i);
    expect(() => parseChapterLines(doc, CHAPTER_URL)).toThrow(CHAPTER_URL);
  });

  // The other half of the same guard: a present container that yields zero
  // real lines (every paragraph a decoy, or the real ones all empty) is the
  // same silent-emptiness failure as a missing container and must reject
  // too, rather than resolving to `[]` and letting the reader render a
  // blank page.
  it("throws, naming the URL, when the body is present but parses to zero real lines", () => {
    const doc = parseHtml(
      `<div class="chapter-content"><p class="d-none">decoy only</p><p></p></div>`,
    );
    expect(() => parseChapterLines(doc, CHAPTER_URL)).toThrow(/chapter-content|chapter body/i);
    expect(() => parseChapterLines(doc, CHAPTER_URL)).toThrow(CHAPTER_URL);
  });
});

describe("getChapterContent", () => {
  it("fetches the chapter's own URL, exactly, and returns its parsed body", async () => {
    // createTestHost resolves a fixture by SUBSTRING match against the
    // requested URL (see its own doc comment) — a call that merely
    // *contains* "/novel/shadow-slave/1" (a mangled query string tacked
    // on, say) would still resolve to this same fixture and pass a test
    // that only checked the returned lines. Asserting the exact recorded
    // call URL (the same `calls` pattern getVolumeChapters's own tests
    // use) closes that gap.
    const calls: Array<{ url: string; method: string }> = [];
    const source = createSource(
      createTestHost({ responses: { "/novel/shadow-slave/1": chapterHtml }, calls }),
    );
    const lines = await source.getChapterContent({
      id: 1,
      title: "الفصل 1",
      url: CHAPTER_URL,
      lines: [],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(CHAPTER_URL);
    expect(lines).toHaveLength(EXPECTED_CHAPTER_LINE_COUNT);
    expect(lines.every((l) => l.type === "text")).toBe(true);
    expect(lines.every((l) => l.content.trim() !== "")).toBe(true);
  });

  it("throws a descriptive error naming the URL when the body is missing", async () => {
    const empty = createSource(
      createTestHost({ responses: { "/novel/x/9": "<html><body></body></html>" } }),
    );
    await expect(
      empty.getChapterContent({ id: 9, title: "", url: "https://sunovels.com/novel/x/9", lines: [] }),
    ).rejects.toThrow(/chapter-content|chapter body/i);
    await expect(
      empty.getChapterContent({ id: 9, title: "", url: "https://sunovels.com/novel/x/9", lines: [] }),
    ).rejects.toThrow("https://sunovels.com/novel/x/9");
  });
});

describe("BASE_URL", () => {
  // Exported for three later tasks to build fetch URLs from (see the
  // brief's Interfaces block). A typo here — a trailing slash, a wrong
  // TLD — would only surface once one of those tasks calls host.fetch
  // with it, far from where the typo was introduced.
  it("is exactly the site's https origin, no trailing slash", () => {
    expect(BASE_URL).toBe("https://sunovels.com");
  });
});
