import { describe, expect, it } from "vitest";
import createSource from "../src/index";
import { createTestHost } from "@riwaq/extension-api/testing";

// Every method on the scaffolded Source still throws "not implemented".
// As you implement one for real, delete its assertion below and replace it
// with a real test against fixture HTML saved under tests/fixtures/ — read
// fixtures with fileURLToPath(import.meta.url) + path.join, never
// `new URL(...)`, which resolves against the wrong base under this repo's
// vitest setup (see extensions/cenele/tests/cenele.test.ts for the working
// pattern).

describe("seanovel: createSource", () => {
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
