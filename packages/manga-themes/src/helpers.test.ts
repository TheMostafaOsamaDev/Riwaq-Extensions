import { describe, expect, it } from "vitest";
import type { SourceChapter } from "@riwaq/extension-api";
import { createTestHost } from "@riwaq/extension-api/testing";
import { chapterIdFromUrl, createCheckedRequest, lockedError, pagesAsLines, parseChapterNumber, withoutQuery } from "./helpers";
import { mangaStrings } from "./strings";

describe("parseChapterNumber", () => {
  it("reads the first number", () => {
    expect(parseChapterNumber("190")).toBe(190);
    expect(parseChapterNumber("65.2")).toBe(65.2);
    expect(parseChapterNumber("04 FREE")).toBe(4);
    expect(parseChapterNumber("١٢")).toBe(12);
    expect(parseChapterNumber("۱۲")).toBe(12);
    expect(parseChapterNumber("الفصل 12")).toBe(12);
    expect(parseChapterNumber("Chapter 7.5 - End")).toBe(7.5);
    expect(parseChapterNumber("1155-5")).toBe(1155.5);
    expect(parseChapterNumber("")).toBeUndefined();
    expect(parseChapterNumber("FREE")).toBeUndefined();
  });
});

describe("chapterIdFromUrl", () => {
  it("is stable, positive and spreads", () => {
    const url = "https://example.com/manga/x/chapter-1";
    expect(chapterIdFromUrl(url)).toBe(chapterIdFromUrl(url));
    const ids = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const id = chapterIdFromUrl(`https://example.com/manga/x/chapter-${i}`);
      expect(id).toBeGreaterThan(0);
      expect(id).toBeLessThan(2 ** 31);
      ids.add(id);
    }
    expect(ids.size).toBe(2000);
  });
});

describe("pagesAsLines", () => {
  it("maps each page to an image line in order", () => {
    expect(
      pagesAsLines({ pages: [{ url: "https://c/1.jpg" }, { url: "https://c/2.jpg", width: 10 }] }),
    ).toEqual([
      { type: "image", content: "https://c/1.jpg" },
      { type: "image", content: "https://c/2.jpg" },
    ]);
  });
});

describe("withoutQuery", () => {
  it("drops the query but keeps named params", () => {
    expect(withoutQuery("https://c/p/1.webp?md5=x&expires=9", [])).toBe("https://c/p/1.webp");
    expect(withoutQuery("https://c/p/1.webp?md5=x&v=3", ["v"])).toBe("https://c/p/1.webp?v=3");
    expect(withoutQuery("https://c/p/1.webp")).toBe("https://c/p/1.webp");
  });
});

describe("lockedError", () => {
  it("starts with the id", () => {
    const ch = { url: "u" } as SourceChapter;
    expect(lockedError("site", ch).message).toBe("site: chapter is locked");
  });
});

describe("mangaStrings", () => {
  it("localises", () => {
    expect(mangaStrings("en")).toMatchObject({ latest: "Latest updates", popular: "Popular" });
    expect(mangaStrings("en").part(3)).toBe("Part 3");
    expect(mangaStrings("ar")).toMatchObject({ latest: "آخر التحديثات", popular: "الأكثر مشاهدة" });
    expect(mangaStrings("ar").part(3)).toBe("الجزء 3");
  });
});

describe("createCheckedRequest", () => {
  it("names a Cloudflare challenge", async () => {
    const host = createTestHost({
      responses: { "x.test": "" },
      status: { "x.test": 403 },
      headers: { "x.test": { "cf-mitigated": "challenge" } },
    });
    await expect(createCheckedRequest(host, "demo")("https://x.test/a")).rejects.toThrow(
      "demo: blocked by a Cloudflare check",
    );
  });

  it("turns any other non-200 into a prefixed error", async () => {
    const host = createTestHost({ responses: { "x.test": "" }, status: { "x.test": 404 } });
    await expect(createCheckedRequest(host, "demo")("https://x.test/a")).rejects.toThrow(
      "demo: https://x.test/a answered HTTP 404",
    );
  });

  it("returns a 200 response", async () => {
    const host = createTestHost({ responses: { "x.test": "ok" } });
    expect((await createCheckedRequest(host, "demo")("https://x.test/a")).text).toBe("ok");
  });
});
