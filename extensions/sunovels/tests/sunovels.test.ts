import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import createSource, {
  BASE_URL,
  parseChaptersCount,
  parseNovelPage,
  slugFromUrl,
} from "../src/index";
import { createTestHost } from "@riwaq/extension-api/testing";
import { SourceUrlError } from "@riwaq/extension-api";

// Deliberately not `readFileSync(new URL("./fixtures/novel.html", import.meta.url), ...)`:
// this suite runs under `environment: "happy-dom"` (see vitest.config.ts), and
// happy-dom's patched global `URL` silently resolves a *relative* two-argument
// `new URL(href, base)` against its fake `window.location` instead of the given
// file: base. `fileURLToPath` on this file's own `import.meta.url` (no relative
// resolution involved) plus plain path-segment arithmetic sidesteps it entirely
// (see extensions/cenele/tests/cenele.test.ts for the same pattern).
const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");
const novelHtml = readFileSync(join(FIXTURES_DIR, "novel.html"), "utf8");

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

  it("getChapterContent is not implemented yet", async () => {
    const source = createSource(createTestHost());
    await expect(
      source.getChapterContent({ id: 1, title: "t", url: "https://example.com/c/1", lines: [] }),
    ).rejects.toThrow("not implemented");
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
  // Exercises the fixture's actual markup shape, independent of the
  // async getNovel plumbing (host.fetch, strings(), volume assembly).
  const parse = () => parseNovelPage(new DOMParser().parseFromString(novelHtml, "text/html"));

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
    const parsed = parseNovelPage(doc);
    expect(parsed.title).toBe("Only Original");
    expect(parsed.originalTitle).toBe("Only Original");
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
