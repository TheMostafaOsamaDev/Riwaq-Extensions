// Fixtures in tests/fixtures were captured live on 2026-11-05 with a browser UA
// from https://manga-api.kawaii-anime.com/api/manga (every call needs the
// `x-app-key: km_2026_live` header and an `x-app-token` from GET /token):
//   token.json   GET /token. The live token is NOT committed: the token below is
//                a placeholder JWT (header.payload.signature, exp in year 2100).
//   browse.json  GET /own?action=browse&page=1&sort=views   (20 results)
//   search.json  GET /own?action=search&q=grocery
//   series.json  GET /own?action=series&slug=wanna-go-grocery-shopping-together
//                (24 chapters inline, ids are opaque strings)
//   pages.json   GET /own?action=pages&chapterId=mw3y2jnzmlc3w1 (24 signed URLs)
// Site pages: series /manga/<slug>, reader /reader/<slug>/<number>.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createTestHost } from "@riwaq/extension-api/testing";
import type { SourceHost } from "@riwaq/extension-api";
import createSource from "../src/index";

// fileURLToPath rather than `new URL(rel, import.meta.url)`: see the note in
// extensions/cenele/tests/cenele.test.ts (happy-dom patches global URL).
const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");
const read = (name: string) => readFileSync(join(FIXTURES_DIR, name), "utf8");

const SITE = "https://kawaiimanga.org";
const API = "https://manga-api.kawaii-anime.com/api/manga";
const SLUG = "wanna-go-grocery-shopping-together";
const SERIES = `${SITE}/manga/${SLUG}`;

const tokenJson = read("token.json");
const browse = JSON.parse(read("browse.json")) as { results: Array<{ slug: string; title: string; coverUrl: string }>; hasMore: boolean };
const search = JSON.parse(read("search.json")) as { results: Array<{ slug: string }> };
const series = JSON.parse(read("series.json")) as {
  title: string;
  chapters: Array<{ id: string; number: number; title: string }>;
};
const pagesJson = JSON.parse(read("pages.json")) as { pages: string[] };

const responses = {
  [`${API}/token`]: tokenJson,
  "action=browse": read("browse.json"),
  "action=search": read("search.json"),
  "action=series": read("series.json"),
  "action=pages": read("pages.json"),
};

type Call = { url: string; method: string; headers: Record<string, string> };

/** A host answering from `handler`, recording url and request headers. */
function hostWith(handler: (url: string, n: number) => { status: number; text: string }, calls: Call[] = []): SourceHost {
  const base = createTestHost();
  return {
    ...base,
    async fetch(url, opts) {
      calls.push({ url, method: opts?.method ?? "GET", headers: { ...(opts?.headers ?? {}) } });
      const r = handler(url, calls.length);
      return { status: r.status, text: r.text, headers: {} };
    },
  };
}

const answerFromFixtures = (url: string) => {
  const key = Object.keys(responses).find((k) => url.includes(k));
  return { status: key ? 200 : 404, text: key ? responses[key as keyof typeof responses] : "" };
};

/** An unsigned JWT whose payload carries `exp` (unix seconds). */
const jwt = (exp: number, tag = "a") =>
  `${btoa('{"alg":"HS256"}')}.${btoa(JSON.stringify({ exp, tag })).replace(/=+$/, "")}.sig`;

describe("kawaii-manga", () => {
  it("canHandle accepts kawaiimanga.org and www.kawaiimanga.org only", () => {
    const source = createSource(createTestHost());
    expect(source.canHandle(SERIES)).toBe(true);
    expect(source.canHandle(`${SITE}/reader/${SLUG}/24`)).toBe(true);
    expect(source.canHandle("https://www.kawaiimanga.org/manga/x")).toBe(true);
    expect(source.canHandle("https://kawaii-anime.com/manga/x")).toBe(false);
    expect(source.canHandle("nope")).toBe(false);
  });

  it("every API call carries the app key and the token", async () => {
    const calls: Call[] = [];
    const source = createSource(hostWith(answerFromFixtures, calls));
    const sections = await source.getHomeSections();
    await source.search("grocery");
    const novel = await source.getNovel(SERIES);
    await source.getChapterPages!(novel.volumes[0].chapters[0]);

    const token = (JSON.parse(tokenJson) as { token: string }).token;
    const api = calls.filter((c) => !c.url.endsWith("/token"));
    expect(api.length).toBeGreaterThanOrEqual(5);
    for (const c of calls) expect(c.headers["x-app-key"]).toBe("km_2026_live");
    for (const c of api) expect(c.headers["x-app-token"]).toBe(token);
    // one token fetch served every call, including the two parallel home calls
    expect(calls.filter((c) => c.url === `${API}/token`)).toHaveLength(1);

    expect(sections.map((s) => s.id)).toEqual(["latest", "popular"]);
    expect(calls.map((c) => c.url)).toContain(`${API}/own?action=browse&page=1`);
    expect(calls.map((c) => c.url)).toContain(`${API}/own?action=browse&page=1&sort=views`);
    expect(sections[1].cards).toHaveLength(browse.results.length);
    expect(sections[1].cards[0]).toMatchObject({
      url: `${SITE}/manga/${browse.results[0].slug}`,
      title: browse.results[0].title,
      coverUrl: browse.results[0].coverUrl,
      contentType: "manga",
    });
  });

  it("search is one page", async () => {
    const calls: Call[] = [];
    const res = await createSource(hostWith(answerFromFixtures, calls)).search("a b&c", 3);
    expect(calls.map((c) => c.url)).toContain(`${API}/own?action=search&q=a%20b%26c`);
    expect(res.hasMore).toBe(false);
    expect(res.cards.map((c) => c.url)).toEqual(search.results.map((r) => `${SITE}/manga/${r.slug}`));
  });

  it("an expired token is renewed once and the call retried", async () => {
    let tokens = 0;
    let own = 0;
    const calls: Call[] = [];
    const host = hostWith((url) => {
      if (url.endsWith("/token")) return { status: 200, text: JSON.stringify({ token: jwt(4102444800, String(++tokens)), expiresIn: 1800 }) };
      own++;
      return own === 1 ? { status: 401, text: '{"error":"token_required"}' } : { status: 200, text: read("browse.json") };
    }, calls);
    const res = await createSource(host).search("x");
    expect(res.cards.length).toBe(browse.results.length);
    const ownCalls = calls.filter((c) => c.url.includes("/own?"));
    expect(ownCalls).toHaveLength(2);
    expect(calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(2);
    expect(ownCalls[0].headers["x-app-token"]).not.toBe(ownCalls[1].headers["x-app-token"]);
  });

  it("a second 401 is an error, not a loop", async () => {
    const calls: Call[] = [];
    const host = hostWith((url) => (url.endsWith("/token") ? { status: 200, text: tokenJson } : { status: 401, text: "{}" }), calls);
    await expect(createSource(host).search("x")).rejects.toThrow(/^kawaii-manga: /);
    expect(calls.filter((c) => c.url.includes("/own?"))).toHaveLength(2);
  });

  it("a token is reused while more than 60 s remain on its exp", async () => {
    const now = Math.floor(Date.now() / 1000);
    let tokens = 0;
    const host = hostWith((url) =>
      url.endsWith("/token")
        ? { status: 200, text: JSON.stringify({ token: jwt(now + 200, String(++tokens)), expiresIn: 1800 }) }
        : { status: 200, text: read("search.json") },
    );
    const source = createSource(host);
    await source.search("a");
    await source.search("b");
    expect(tokens).toBe(1);
  });

  it("a token inside the 60 s margin is renewed on the next call", async () => {
    const now = Math.floor(Date.now() / 1000);
    let tokens = 0;
    const host = hostWith((url) =>
      url.endsWith("/token")
        ? { status: 200, text: JSON.stringify({ token: jwt(now + 30, String(++tokens)), expiresIn: 1800 }) }
        : { status: 200, text: read("search.json") },
    );
    const source = createSource(host);
    await source.search("a");
    await source.search("b");
    expect(tokens).toBe(2);
  });

  it("an undecodable token is valid for 1740 s and a malformed one reads as kawaii-manga", async () => {
    let tokens = 0;
    const host = hostWith((url) =>
      url.endsWith("/token") ? { status: 200, text: JSON.stringify({ token: `opaque${++tokens}`, expiresIn: 1800 }) } : { status: 200, text: read("search.json") },
    );
    const source = createSource(host);
    await source.search("a");
    await source.search("b");
    expect(tokens).toBe(1);

    const bad = hostWith((url) => (url.endsWith("/token") ? { status: 200, text: "<html>" } : { status: 200, text: "{}" }));
    await expect(createSource(bad).search("a")).rejects.toThrow(/^kawaii-manga: /);
  });

  it("series: details and chapters oldest first, with the site's reader urls", async () => {
    const novel = await createSource(hostWith(answerFromFixtures)).getNovel(SERIES);
    expect(novel).toMatchObject({ title: series.title, language: "ar", direction: "rtl", contentType: "manga" });
    expect(novel.description).toBeTruthy();
    expect(novel.description).not.toMatch(/<[a-z]/);
    expect(novel.tags.length).toBeGreaterThan(0);
    const chapters = novel.volumes[0].chapters;
    expect(chapters).toHaveLength(series.chapters.length);
    const numbers = chapters.map((c) => c.number!);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    const last = chapters[chapters.length - 1];
    expect(last.number).toBe(Math.max(...series.chapters.map((c) => c.number)));
    expect(last.url).toBe(`${SITE}/reader/${SLUG}/${last.number}`);
    expect(new Set(chapters.map((c) => c.id)).size).toBe(chapters.length);
    for (const c of chapters) expect(c.lock).toBeUndefined();
  });

  it("an unknown slug or a bad url is a kawaii-manga error", async () => {
    await expect(createSource(hostWith(answerFromFixtures)).getNovel(`${SITE}/about`)).rejects.toThrow(/^kawaii-manga: /);
  });

  it("page cacheKeys drop the signature and expiresAt follows it", async () => {
    const calls: Call[] = [];
    const source = createSource(hostWith(answerFromFixtures, calls));
    const novel = await source.getNovel(SERIES);
    const chapter = novel.volumes[0].chapters.find((c) => c.number === 24)!;
    const { pages, expiresAt } = await source.getChapterPages!(chapter);
    const wanted = series.chapters.find((c) => c.number === 24)!;
    expect(calls.map((c) => c.url)).toContain(`${API}/own?action=pages&chapterId=${wanted.id}`);
    expect(pages.map((p) => p.url)).toEqual(pagesJson.pages);
    for (const p of pages) {
      expect(p.cacheKey).toBe(p.url.split("?")[0]);
      expect(p.cacheKey).not.toContain("md5");
    }
    const expires = pagesJson.pages.map((u) => Number(new URL(u).searchParams.get("expires")));
    expect(expiresAt).toBe(Math.min(...expires) * 1000);
  });

  it("pages resolve on a fresh instance by reading the series first", async () => {
    const calls: Call[] = [];
    const source = createSource(hostWith(answerFromFixtures, calls));
    const chapter = { id: 1, title: "x", url: `${SITE}/reader/${SLUG}/23`, number: 23, lines: [] };
    const { pages } = await source.getChapterPages!(chapter);
    expect(pages.length).toBe(pagesJson.pages.length);
    const wanted = series.chapters.find((c) => c.number === 23)!;
    expect(calls.map((c) => c.url)).toContain(`${API}/own?action=pages&chapterId=${wanted.id}`);
  });

  it("getChapterContent is the pages as image lines", async () => {
    const source = createSource(hostWith(answerFromFixtures));
    const novel = await source.getNovel(SERIES);
    const lines = await source.getChapterContent(novel.volumes[0].chapters[0]);
    expect(lines).toEqual(pagesJson.pages.map((content) => ({ type: "image", content })));
  });

  it("a locked chapter is flagged and never fetched", async () => {
    const inline = {
      ...series,
      chapters: [{ ...series.chapters[0], isLocked: true }, { ...series.chapters[1], is_premium: true }, series.chapters[2]],
    };
    const calls: Call[] = [];
    const source = createSource(
      hostWith((url) => (url.endsWith("/token") ? { status: 200, text: tokenJson } : { status: 200, text: JSON.stringify(inline) }), calls),
    );
    const novel = await source.getNovel(SERIES);
    const [a, b, c] = novel.volumes[0].chapters.slice().reverse();
    expect(a.lock).toEqual({ reason: "locked", openUrl: a.url });
    expect(b.lock).toBeDefined();
    expect(c.lock).toBeUndefined();
    calls.length = 0;
    await expect(source.getChapterPages!(a)).rejects.toThrow("kawaii-manga: chapter is locked");
    expect(calls).toEqual([]);
  });

  it("a decimal chapter number keeps its fraction", async () => {
    const inline = { ...series, chapters: [{ id: "abc", number: 10.5, title: "الفصل 10.5", pageCount: 3 }] };
    const source = createSource(
      hostWith((url) => (url.endsWith("/token") ? { status: 200, text: tokenJson } : { status: 200, text: JSON.stringify(inline) }), []),
    );
    const [ch] = (await source.getNovel(SERIES)).volumes[0].chapters;
    expect(ch.number).toBe(10.5);
    expect(ch.url).toBe(`${SITE}/reader/${SLUG}/10.5`);
  });
});
