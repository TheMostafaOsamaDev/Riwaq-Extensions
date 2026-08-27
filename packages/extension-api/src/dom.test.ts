import { describe, expect, it } from "vitest";
import { absoluteUrl, attrOf, parseHtml, sanitizeText, textOf } from "@riwaq/extension-api";
import { createTestHost } from "@riwaq/extension-api/testing";

describe("parseHtml", () => {
  it("parses an HTML string into a queryable Document", () => {
    const doc = parseHtml(
      '<html><body><ul><li class="item">first</li><li class="item">second</li></ul></body></html>',
    );
    const items = Array.from(doc.querySelectorAll(".item")).map((el) => el.textContent);
    expect(items).toEqual(["first", "second"]);
  });
});

describe("absoluteUrl", () => {
  it("resolves a relative href against a base", () => {
    expect(absoluteUrl("/chapter/12", "https://example.com/novel/1")).toBe(
      "https://example.com/chapter/12",
    );
  });

  it("passes an already-absolute href through unchanged", () => {
    expect(absoluteUrl("https://other.com/x", "https://example.com/")).toBe(
      "https://other.com/x",
    );
  });
});

describe("textOf", () => {
  it("returns the trimmed text of the first match", () => {
    const doc = parseHtml("<div><span class='title'>  Hello World  </span></div>");
    expect(textOf(doc, ".title")).toBe("Hello World");
  });

  it("returns null when nothing matches", () => {
    const doc = parseHtml("<div></div>");
    expect(textOf(doc, ".missing")).toBeNull();
  });
});

describe("attrOf", () => {
  it("returns the attribute value of the first match", () => {
    const doc = parseHtml('<img class="cover" src="/cover.jpg" />');
    expect(attrOf(doc, ".cover", "src")).toBe("/cover.jpg");
  });

  it("returns null when nothing matches", () => {
    const doc = parseHtml("<div></div>");
    expect(attrOf(doc, ".missing", "src")).toBeNull();
  });
});

describe("sanitizeText", () => {
  it("collapses internal whitespace runs to a single space", () => {
    expect(sanitizeText("a\n\n  b\t\tc")).toBe("a b c");
  });

  it("trims leading and trailing whitespace", () => {
    expect(sanitizeText("   padded   ")).toBe("padded");
  });

  it("returns an empty string for null or undefined", () => {
    expect(sanitizeText(null)).toBe("");
    expect(sanitizeText(undefined)).toBe("");
  });
});

describe("createTestHost", () => {
  it("serves an exact-match fixture", async () => {
    const host = createTestHost({
      responses: { "https://example.com/novel/1": "<html>novel one</html>" },
    });
    const res = await host.fetch("https://example.com/novel/1");
    expect(res).toEqual({ status: 200, text: "<html>novel one</html>", headers: {} });
  });

  it("falls back to a substring match when there is no exact key", async () => {
    // The fixture key is a fragment of a URL; any request whose URL contains
    // it should resolve to the same body (e.g. a paginated listing).
    const host = createTestHost({ responses: { "page=2": "page two results" } });
    const res = await host.fetch("https://example.com/search?q=novel&page=2");
    expect(res.text).toBe("page two results");
  });

  it("prefers an exact match over a substring match", async () => {
    const host = createTestHost({
      responses: {
        "https://example.com/a": "exact match body",
        a: "substring match body", // a substring of every URL below
      },
    });
    const res = await host.fetch("https://example.com/a");
    expect(res.text).toBe("exact match body");
  });

  it("records the method and body of every fetch call", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const host = createTestHost({
      responses: { "https://example.com/search": "results" },
      calls,
    });
    await host.fetch("https://example.com/search", { method: "POST", body: "q=term" });
    expect(calls).toEqual([{ url: "https://example.com/search", method: "POST", body: "q=term" }]);
  });

  it("records fetchBytes calls the same way as fetch calls", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const bytes = new Uint8Array([1, 2, 3]);
    const host = createTestHost({
      byteResponses: { "https://example.com/file.pdf": bytes },
      calls,
    });
    const result = await host.fetchBytes("https://example.com/file.pdf", { method: "GET" });
    expect(result).toBe(bytes);
    expect(calls).toEqual([{ url: "https://example.com/file.pdf", method: "GET", body: undefined }]);
  });

  it("defaults an unspecified method to GET when recording a call", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const host = createTestHost({ responses: { "/x": "y" }, calls });
    await host.fetch("https://example.com/x");
    expect(calls[0].method).toBe("GET");
  });

  it("throws a named error listing the known keys when a text fixture is missing", async () => {
    const host = createTestHost({ responses: { "/known-a": "a", "/known-b": "b" } });
    await expect(host.fetch("https://example.com/nope")).rejects.toThrow(
      "createTestHost: no text fixture for https://example.com/nope. Known keys: /known-a, /known-b",
    );
  });

  it("throws a named error listing the known keys when a bytes fixture is missing", async () => {
    const host = createTestHost({ byteResponses: { "/known.pdf": new Uint8Array() } });
    await expect(host.fetchBytes("https://example.com/other.pdf")).rejects.toThrow(
      "createTestHost: no bytes fixture for https://example.com/other.pdf. Known keys: /known.pdf",
    );
  });

  it("reports '(none)' as the known keys when no fixtures were configured at all", async () => {
    const host = createTestHost();
    await expect(host.fetch("https://example.com/anything")).rejects.toThrow("Known keys: (none)");
  });

  it("defaults locale to 'en' and honours an explicit locale", () => {
    expect(createTestHost().locale).toBe("en");
    expect(createTestHost({ locale: "ar" }).locale).toBe("ar");
  });

  it("throws a clear error from renderAndExtract instead of reaching the network", async () => {
    const host = createTestHost();
    await expect(host.renderAndExtract("https://example.com", { script: "1" })).rejects.toThrow(
      "renderAndExtract is not available in tests",
    );
  });

  it("throws a clear error from pdf.extractChapter unless a test stubs it explicitly", async () => {
    const host = createTestHost();
    await expect(
      host.pdf.extractChapter(new Uint8Array(), {
        chapterUrl: "https://example.com/c/1",
        mintImageRef: () => "ref",
      }),
    ).rejects.toThrow("pdf.extractChapter is not stubbed");
  });
});
