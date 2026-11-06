// Fixtures in tests/fixtures were captured live from https://api.azorafly.com
// on 2026-11-05 (plain GET, no special headers):
//   query-latest.json  GET /api/query?perPage=18&page=1&searchTerm=&orderBy=lastChapterAddedAt
//   query-novels.json  the same query, page=2 — the first page holding NOVEL series
//   query-search.json  GET /api/query?perPage=18&page=1&searchTerm=sponsor&orderBy=lastChapterAddedAt
//   post.json          GET /api/post?postSlug=villain-familys-strongest-butler
//   chapters.json      GET /api/chapters?postId=2823 (chapters 20-25 are paid)
//   chapter.json       GET /api/chapter?chapterId=143479 (free, 12 images)
//   chapter-locked.json GET /api/chapter?chapterId=143476 (paid: 200 with images: [])
// Novels are marked `seriesType: "NOVEL"` today; no post carries `isNovel`
// (the older flag), so that case is covered by a patched copy of a fixture.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createTestHost } from "@riwaq/extension-api/testing";
import createSource from "../src/index";

// fileURLToPath rather than `new URL(rel, import.meta.url)`: see the note in
// extensions/cenele/tests/cenele.test.ts (happy-dom patches global URL).
const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");
const read = (name: string) => readFileSync(join(FIXTURES_DIR, name), "utf8");
const json = (name: string) => JSON.parse(read(name));

const latest = json("query-latest.json");
const novelsPage = json("query-novels.json");
const search = json("query-search.json");
const postJson = json("post.json");
const chaptersJson = json("chapters.json");
const chapterJson = json("chapter.json");

const SITE = "https://azorafly.com";
const API = "https://api.azorafly.com";
const SERIES = `${SITE}/series/villain-familys-strongest-butler`;

/** Order matters: the host answers the first key a URL contains. */
const responses = {
  "searchTerm=sponsor": read("query-search.json"),
  "orderBy=lastChapterAddedAt": read("query-latest.json"),
  "orderBy=totalViews": read("query-novels.json"),
  "/api/post?": read("post.json"),
  "/api/chapters?": read("chapters.json"),
  "chapterId=143479": read("chapter.json"),
  "chapterId=143476": read("chapter-locked.json"),
};

const isNovel = (p: { isNovel?: boolean; seriesType?: string }) => p.isNovel === true || p.seriesType === "NOVEL";

describe("azora", () => {
  it("home sections are latest then popular", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const sections = await createSource(createTestHost({ responses, calls })).getHomeSections();
    expect(sections.map((s) => s.id)).toEqual(["latest", "popular"]);
    expect(calls.map((c) => c.url).sort()).toEqual(
      [
        `${API}/api/query?perPage=18&page=1&orderBy=lastChapterAddedAt`,
        `${API}/api/query?perPage=18&page=1&orderBy=totalViews`,
      ].sort(),
    );
    const expected = latest.posts.filter((p: { seriesType: string }) => p.seriesType !== "NOVEL");
    expect(expected.length).toBeGreaterThan(0);
    expect(sections[0].cards).toHaveLength(expected.length);
    for (const c of sections[0].cards) {
      expect(c.url).toMatch(/^https:\/\/azorafly\.com\/series\/[^/]+$/);
      expect(c.title).not.toBe("");
      expect(c.coverUrl).toMatch(/^https:\/\/storage\.azorafly\.com\//);
      expect(c.contentType).toBe("manga");
    }
    expect(sections[0].cards[0].url).toBe(`${SITE}/series/${expected[0].slug}`);
    expect(sections[0].cards[0].title).toBe(expected[0].postTitle);
  });

  it("lists drop novels", async () => {
    const novels = novelsPage.posts.filter(isNovel);
    expect(novels.length).toBeGreaterThan(0);
    const res = await createSource(createTestHost({ responses: { "/api/query": read("query-novels.json") } })).search(
      "x",
      1,
    );
    expect(res.cards).toHaveLength(novelsPage.posts.length - novels.length);
    const slugs = new Set(res.cards.map((c) => c.url.split("/").pop()));
    for (const n of novels) expect(slugs.has(n.slug)).toBe(false);

    // The older flag: a post carrying `isNovel: true` under a comic type.
    const patched = structuredClone(latest);
    patched.posts[0].isNovel = true;
    const res2 = await createSource(createTestHost({ responses: { "/api/query": JSON.stringify(patched) } })).search(
      "x",
      1,
    );
    expect(res2.cards.map((c) => c.url)).not.toContain(`${SITE}/series/${latest.posts[0].slug}`);
    expect(res2.cards).toHaveLength(latest.posts.length - 1);
  });

  it("search builds the query and pages with page", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const source = createSource(createTestHost({ responses, calls }));
    const res = await source.search("sponsor", 1);
    expect(calls[0].url).toBe(`${API}/api/query?perPage=18&page=1&searchTerm=sponsor&orderBy=lastChapterAddedAt`);
    expect(res.page).toBe(1);
    expect(res.query).toBe("sponsor");
    expect(res.cards).toHaveLength(search.posts.filter((p: object) => !isNovel(p)).length);
    expect(res.cards.length).toBeGreaterThan(0);
    const empty = await source.search("  ", 1);
    expect(empty.cards).toEqual([]);
    expect(empty.hasMore).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("hasMore follows totalCount", async () => {
    const source = createSource(createTestHost({ responses }));
    const body = (totalCount: number) => ({ posts: search.posts, totalCount });
    const more = (total: number, page: number) =>
      createSource(createTestHost({ responses: { "/api/query": JSON.stringify(body(total)) } }))
        .search("a", page)
        .then((r) => r.hasMore);
    expect(await more(18, 1)).toBe(false);
    expect(await more(19, 1)).toBe(true);
    expect(await more(36, 2)).toBe(false);
    expect(await more(37, 2)).toBe(true);
    // The real capture: 4 matches fit on one page.
    expect((await source.search("sponsor", 1)).hasMore).toBe(search.totalCount > 18);
  });

  it("getNovel reads the post and lists every chapter oldest first", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const novel = await createSource(createTestHost({ responses, calls })).getNovel(SERIES);
    expect(calls.map((c) => c.url)).toEqual([
      `${API}/api/post?postSlug=villain-familys-strongest-butler`,
      `${API}/api/chapters?postId=${postJson.post.id}`,
    ]);
    expect(novel.title).toBe(postJson.post.postTitle);
    expect(novel.direction).toBe("rtl");
    expect(novel.language).toBe("ar");
    expect(novel.contentType).toBe("manga");
    expect(novel.coverUrl).toBe(postJson.post.featuredImage);
    expect(novel.tags).toEqual(postJson.post.genres.map((g: { name: string }) => g.name));
    expect(novel.volumes).toHaveLength(1);
    const chapters = novel.volumes[0].chapters;
    const source = chaptersJson.post.chapters as Array<{ id: number; number: number; slug: string }>;
    expect(chapters).toHaveLength(source.length);
    expect(chapters).toHaveLength(chaptersJson.totalChapterCount);
    expect(chapters.map((c) => c.number)).toEqual(source.map((c) => c.number).sort((a, b) => a - b));
    const first = [...source].sort((a, b) => a.number - b.number)[0];
    expect(chapters[0].id).toBe(first.id);
    expect(chapters[0].url).toBe(`${SERIES}/${first.slug}`);
    expect(new Set(chapters.map((c) => c.id)).size).toBe(chapters.length);
  });

  it("the description is plain text, one paragraph per line", async () => {
    const novel = await createSource(createTestHost({ responses })).getNovel(SERIES);
    const html = postJson.post.postContent as string;
    const paragraphs = [...html.matchAll(/<p>(.*?)<\/p>/gs)].map((m) => m[1].trim()).filter(Boolean);
    expect(html).toContain("<p>");
    expect(paragraphs.length).toBeGreaterThan(1);
    expect(novel.description).toBeDefined();
    expect(novel.description).not.toContain("<");
    expect(novel.description).not.toMatch(/&\w+;/);
    const lines = novel.description!.split("\n");
    expect(lines).toHaveLength(paragraphs.length);
    expect(lines[0]).toBe(paragraphs[0].replace(/<[^>]*>/g, "").trim());

    // Entities, <br> and the older plain-text form.
    const withPost = (postContent: string) =>
      JSON.stringify({ ...postJson, post: { ...postJson.post, postContent } });
    const get = async (postContent: string) =>
      (await createSource(createTestHost({ responses: { ...responses, "/api/post?": withPost(postContent) } })).getNovel(SERIES))
        .description;
    expect(await get("<p>a &amp; b</p><p>c<br>d</p>")).toBe("a & b\nc\nd");
    expect(await get("one\r\ntwo")).toBe("one\ntwo");
  });

  it("a malformed series URL is an azora error", async () => {
    const source = createSource(createTestHost({ responses }));
    await expect(source.getNovel(`${SITE}/series/%E0%A4%A`)).rejects.toThrow("azora: ");
  });

  it("locked chapters carry a lock and refuse pages without a request", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const source = createSource(createTestHost({ responses, calls }));
    const chapters = (await source.getNovel(SERIES)).volumes[0].chapters;
    const expected = (chaptersJson.post.chapters as Array<{ isLocked: boolean; isPermanentlyLocked: boolean }>).filter(
      (c) => c.isLocked || c.isPermanentlyLocked,
    );
    expect(expected.length).toBeGreaterThan(0);
    const locked = chapters.filter((c) => c.lock);
    expect(locked).toHaveLength(expected.length);
    expect(locked[0].lock).toEqual({ reason: "paid", openUrl: locked[0].url });
    expect(chapters.filter((c) => !c.lock).length).toBeGreaterThan(0);
    calls.length = 0;
    await expect(source.getChapterPages!(locked[0])).rejects.toThrow("azora: chapter is locked");
    await expect(source.getChapterContent(locked[0])).rejects.toThrow("azora: chapter is locked");
    expect(calls).toEqual([]);
  });

  it("pages keep their order and size", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const source = createSource(createTestHost({ responses, calls }));
    const chapter = { id: 143479, title: "54", url: `${SITE}/series/i-need-a-sponsor/chapter-54`, lines: [] };
    const { pages } = await source.getChapterPages!(chapter);
    expect(calls.map((c) => c.url)).toEqual([`${API}/api/chapter?chapterId=143479`]);
    const images = [...chapterJson.chapter.images].sort(
      (a: { order: number }, b: { order: number }) => a.order - b.order,
    );
    expect(images.length).toBeGreaterThan(1);
    expect(pages).toEqual(
      images.map((i: { url: string; width: number; height: number }) => ({
        url: i.url,
        width: i.width,
        height: i.height,
      })),
    );
    // The page list is not the order the API happened to send.
    const shuffled = structuredClone(chapterJson);
    shuffled.chapter.images.reverse();
    const again = await createSource(
      createTestHost({ responses: { "chapterId=143479": JSON.stringify(shuffled) } }),
    ).getChapterPages!(chapter);
    expect(again.pages).toEqual(pages);
    const lines = await source.getChapterContent(chapter);
    expect(lines).toEqual(pages.map((p) => ({ type: "image", content: p.url })));
  });

  it("an unlocked chapter with no images is an error", async () => {
    const empty = JSON.parse(read("chapter-locked.json"));
    const source = createSource(createTestHost({ responses: { "chapterId=": JSON.stringify(empty) } }));
    await expect(
      source.getChapterPages!({ id: 5, title: "5", url: `${SERIES}/chapter-5`, lines: [] }),
    ).rejects.toThrow("azora: ");
  });

  it("canHandle matches the site", () => {
    const source = createSource(createTestHost({ responses }));
    expect(source.canHandle(SERIES)).toBe(true);
    expect(source.canHandle("https://www.azorafly.com/series/x")).toBe(true);
    expect(source.canHandle("https://example.com/series/x")).toBe(false);
    expect(source.canHandle("not a url")).toBe(false);
  });
});
