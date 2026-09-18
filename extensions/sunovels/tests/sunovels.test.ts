import { describe, expect, it } from "vitest";
import createSource, { slugFromUrl } from "../src/index";
import { createTestHost } from "@riwaq/extension-api/testing";
import { SourceUrlError } from "@riwaq/extension-api";

// Every method on the scaffolded Source still throws "not implemented"
// except `canHandle`, which Task 1 implements for real (plus the
// `slugFromUrl` helper future tasks build on). As each remaining method is
// implemented, delete its assertion below and replace it with a real test
// against fixture HTML saved under tests/fixtures/ — read fixtures with
// fileURLToPath(import.meta.url) + path.join, never `new URL(...)`, which
// resolves against the wrong base under this repo's vitest setup (see
// extensions/cenele/tests/cenele.test.ts for the working pattern).

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
});
