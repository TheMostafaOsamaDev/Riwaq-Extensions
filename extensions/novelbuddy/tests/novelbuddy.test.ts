import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import createSource, {
  buildNovel,
  canonicalChapterUrl,
  cardFor,
  chapterLinesFrom,
  chapterListUrl,
  htmlToRawLines,
  indexTitleItems,
  normalizeStatus,
  novelPath,
  searchUrl,
  slugFromUrl,
} from "../src/index";
import { strings } from "../src/strings";
import { parseHtml, sanitizeText, SourceUrlError, type SourceHost } from "@riwaq/extension-api";
import { createTestHost } from "@riwaq/extension-api/testing";

// Fixtures are read via fileURLToPath + path.join, never `new URL(...)`:
// under happy-dom the global URL resolves a relative `new URL(href, base)`
// against its fake window.location — see the repo README's Testing section.
const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");
const fixture = (name: string) => readFileSync(join(FIXTURES_DIR, name), "utf8");

/** This extension's own manifest id. Every thrown error is prefixed with
 *  it (README → Rules); reading it from the manifest means renaming the id
 *  without updating the error strings fails this suite. */
const MANIFEST = JSON.parse(readFileSync(join(FIXTURES_DIR, "..", "..", "manifest.json"), "utf8")) as {
  id: string;
};
const ID = MANIFEST.id;
const PREFIX = `${ID}: `;

// Every fixture is an unedited live capture (2026-10-29):
//   home.html          https://novelbuddy.me/home
//   search.html        https://novelbuddy.me/search?q=shadow
//   search-page2.html  https://novelbuddy.me/search?q=shadow&page=2
//   search-empty.html  https://novelbuddy.me/search?q=zzqqxxnomatch
//   novel.html         https://novelbuddy.me/shadows-oath
//   chapters.json      https://api.novelbuddy.me/titles/eDkM6O8Q/chapters?cv=1742199221000
//   novel-rich.html    https://novelbuddy.me/shadow-slave
//   chapter.html       https://novelbuddy.me/shadows-oath/chapter-108
//   chapter-heading.html  …/complete-martial-arts-attributes/chapter-4895-…-life-stain-2
//   chapter-mtl.html   https://novelbuddy.me/mtl-cultivation-fishermen/chapter-1
const homeHtml = fixture("home.html");
const searchHtml = fixture("search.html");
const searchPage2Html = fixture("search-page2.html");
const searchEmptyHtml = fixture("search-empty.html");
const novelHtml = fixture("novel.html");
const chaptersJson = fixture("chapters.json");
const novelRichHtml = fixture("novel-rich.html");
const chapterHtml = fixture("chapter.html");
const chapterHeadingHtml = fixture("chapter-heading.html");
const chapterMtlHtml = fixture("chapter-mtl.html");

/** The test's own __NEXT_DATA__ reader — deliberately not the one in
 *  src/index.ts, so a bug there can't make its own test pass. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pageProps(html: string): any {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("fixture sanity: no __NEXT_DATA__ — re-capture it");
  return JSON.parse(m[1]).props.pageProps;
}

const homeProps = pageProps(homeHtml);
const searchProps = pageProps(searchHtml);
const searchPage2Props = pageProps(searchPage2Html);
const novelManga = pageProps(novelHtml).initialManga;
const richManga = pageProps(novelRichHtml).initialManga;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chapterRows: any[] = JSON.parse(chaptersJson).data.chapters;

const NOVEL_URL = "https://novelbuddy.me/shadows-oath";
const CHAPTER_LIST_URL = `https://api.novelbuddy.me/titles/${novelManga.id}/chapters?cv=${novelManga.cv}`;

type LogEntry = { level: string; message: string };

/** createTestHost with a working log() and an overridable status. */
function host(
  responses: Record<string, string>,
  opts: {
    locale?: "en" | "ar";
    calls?: Array<{ url: string; method: string; body?: string }>;
    logs?: LogEntry[];
    status?: (url: string) => number;
  } = {},
): SourceHost {
  const base = createTestHost({ responses, locale: opts.locale ?? "en", calls: opts.calls });
  return {
    ...base,
    async fetch(url, o) {
      const r = await base.fetch(url, o);
      return { ...r, status: opts.status ? opts.status(url) : r.status };
    },
    log(level, message) {
      opts.logs?.push({ level, message });
    },
  };
}

const novelHost = (opts: Parameters<typeof host>[1] = {}) =>
  host({ [NOVEL_URL]: novelHtml, [CHAPTER_LIST_URL]: chaptersJson }, opts);

// ── canHandle + URLs ───────────────────────────────────────────────────

describe("canHandle", () => {
  const source = createSource(createTestHost());

  it("accepts novel and chapter URLs on novelbuddy.me and its mirrors", () => {
    for (const url of [
      "https://novelbuddy.me/shadow-slave",
      "https://novelbuddy.me/shadow-slave/chapter-1-nightmare-begins",
      "https://www.novelbuddy.me/shadow-slave",
      "https://novelbuddy.io/novel/shadow-slave",
      "https://www.novelbuddy.io/shadow-slave",
      "https://novelbuddy.com/novel/shadow-slave/chapter-1",
      "https://www.novelbuddy.com/",
      "http://novelbuddy.me/home",
    ]) {
      expect(source.canHandle(url), url).toBe(true);
    }
  });

  it("rejects other sites, look-alike hosts and non-URLs", () => {
    for (const url of [
      "https://sunovels.com/novel/x",
      "https://novelbuddy.me.evil.example/shadow-slave",
      "https://notnovelbuddy.me/shadow-slave",
      "https://api.novelbuddy.me/titles/search",
      "https://mangabuddy.com/x",
      "not a url",
      "",
    ]) {
      expect(source.canHandle(url), url).toBe(false);
    }
  });
});

describe("URL helpers", () => {
  it("reads the slug from every accepted novel and chapter URL shape", () => {
    for (const url of [
      "https://novelbuddy.me/shadow-slave",
      "https://novelbuddy.me/shadow-slave/",
      "https://novelbuddy.me/shadow-slave/chapter-3229-audience-with-the-abyss",
      "https://www.novelbuddy.me/shadow-slave?ref=x#top",
      "https://novelbuddy.io/novel/shadow-slave",
      "https://novelbuddy.com/novel/shadow-slave/chapter-1",
      "https://novelbuddy.me/read/shadow-slave",
    ]) {
      expect(slugFromUrl(url), url).toBe("shadow-slave");
    }
  });

  it("keeps a lone first segment even when it equals a legacy prefix", () => {
    expect(novelPath("https://novelbuddy.me/novel")).toEqual(["novel"]);
  });

  it("rejects the bare host and foreign URLs with a SourceUrlError prefixed by the id", () => {
    for (const url of ["https://novelbuddy.me/", "https://example.com/shadow-slave", "nope"]) {
      expect(() => slugFromUrl(url), url).toThrow(SourceUrlError);
      expect(() => slugFromUrl(url), url).toThrow(PREFIX);
    }
  });

  it("rewrites mirror, www and legacy chapter URLs onto https://novelbuddy.me", () => {
    // www.novelbuddy.me 301s to itself forever; novelbuddy.io/.com 301 to .me.
    expect(canonicalChapterUrl("https://www.novelbuddy.me/shadow-slave/chapter-2")).toBe(
      "https://novelbuddy.me/shadow-slave/chapter-2",
    );
    expect(canonicalChapterUrl("https://novelbuddy.io/novel/shadow-slave/chapter-2")).toBe(
      "https://novelbuddy.me/shadow-slave/chapter-2",
    );
    expect(() => canonicalChapterUrl("https://novelbuddy.me/shadow-slave")).toThrow(PREFIX);
  });

  it("builds search and chapter-list URLs the way the site does", () => {
    expect(searchUrl("martial peak", 1)).toBe("https://novelbuddy.me/search?q=martial+peak");
    expect(searchUrl("shadow", 3)).toBe("https://novelbuddy.me/search?q=shadow&page=3");
    expect(chapterListUrl("VYPGVZ8z", 1793294071047)).toBe(
      "https://api.novelbuddy.me/titles/VYPGVZ8z/chapters?cv=1793294071047",
    );
    expect(chapterListUrl("VYPGVZ8z", undefined)).toBe("https://api.novelbuddy.me/titles/VYPGVZ8z/chapters");
  });
});

// ── home ───────────────────────────────────────────────────────────────

describe("getHomeSections", () => {
  it("fetches /home and returns the site's own novel rows, in page order", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const sections = await createSource(host({ "https://novelbuddy.me/home": homeHtml }, { calls })).getHomeSections();

    expect(calls.map((c) => c.url)).toEqual(["https://novelbuddy.me/home"]);
    expect(sections.map((s) => s.title)).toEqual(["Trending", "Popular Updates", "Latest Updates"]);
    expect(sections.map((s) => s.id)).toEqual(["trending", "popular-updates", "latest-updates"]);
    // The two non-novel rows the page also titles with an <h2>.
    expect(sections.map((s) => s.title)).not.toContain("XP Leaderboard");
    expect(sections.map((s) => s.title)).not.toContain("Latest Lists");
  });

  it("fills each row from the payload array the site renders it from", async () => {
    const sections = await createSource(host({ "https://novelbuddy.me/home": homeHtml })).getHomeSections();
    const byId = Object.fromEntries(sections.map((s) => [s.id, s]));
    const urls = (items: Array<{ slug: string }>) => items.map((i) => `https://novelbuddy.me/${i.slug}`);

    expect(byId["popular-updates"].cards.map((c) => c.url)).toEqual(urls(homeProps.popularItems));
    expect(byId["latest-updates"].cards.map((c) => c.url)).toEqual(urls(homeProps.latest.items));
    // Trending renders a prefix of the 50-item trendingItems array.
    const trending = byId.trending.cards.map((c) => c.url);
    expect(trending.length).toBeGreaterThan(0);
    expect(trending).toEqual(urls(homeProps.trendingItems).slice(0, trending.length));
  });

  it("builds cards with clean titles, covers, latest-chapter subtitles and genre badges", async () => {
    const sections = await createSource(host({ "https://novelbuddy.me/home": homeHtml })).getHomeSections();
    const latest = sections.find((s) => s.id === "latest-updates")!;
    latest.cards.forEach((card, i) => {
      const item = homeProps.latest.items[i];
      expect(card.title).toBe(sanitizeText(item.name));
      expect(card.coverUrl).toBe(item.cover);
      expect(card.subtitle).toBe(item.latestChapters[0].name);
      const genres = item.genres.map((g: { name: string }) => g.name).slice(0, 3);
      expect(card.badges).toEqual(genres.length > 0 ? genres : undefined);
    });
    // Trending titles must not carry the rank digits the markup prefixes.
    const trending = sections.find((s) => s.id === "trending")!;
    expect(trending.cards[0].title).toBe(sanitizeText(homeProps.trendingItems[0].name));
    for (const card of sections.flatMap((s) => s.cards)) {
      expect(card.coverUrl).toMatch(/^https:\/\//);
      expect(card.url).toMatch(/^https:\/\/novelbuddy\.me\/[^/]+$/);
    }
  });

  it("keeps each row's own 'See all' link", async () => {
    const sections = await createSource(host({ "https://novelbuddy.me/home": homeHtml })).getHomeSections();
    const byId = Object.fromEntries(sections.map((s) => [s.id, s]));
    expect(byId.trending.viewMoreUrl).toBe("https://novelbuddy.me/trending/manga");
    expect(byId["popular-updates"].viewMoreUrl).toBe("https://novelbuddy.me/search?sort=views_today");
    expect(byId["latest-updates"].viewMoreUrl).toBeUndefined();
  });

  it("throws, naming the status, on a non-2xx answer", async () => {
    const source = createSource(host({ "/home": homeHtml }, { status: () => 503 }));
    await expect(source.getHomeSections()).rejects.toThrow(`${PREFIX}https://novelbuddy.me/home answered HTTP 503.`);
  });

  it("throws on a page with no __NEXT_DATA__ (a challenge or error page)", async () => {
    const source = createSource(host({ "/home": "<html><body>Just a moment...</body></html>" }));
    await expect(source.getHomeSections()).rejects.toThrow(`${PREFIX}https://novelbuddy.me/home has no __NEXT_DATA__`);
  });

  it("throws when the page parses but holds no novel rows", async () => {
    // A real page of a different shape: the search page has no home sections.
    const source = createSource(host({ "/home": searchEmptyHtml }));
    await expect(source.getHomeSections()).rejects.toThrow(`${PREFIX}found no novel rows`);
  });

  it("logs at info", async () => {
    const logs: LogEntry[] = [];
    await createSource(host({ "/home": homeHtml }, { logs })).getHomeSections();
    expect(logs).toEqual([{ level: "info", message: "getHomeSections" }]);
  });
});

describe("indexTitleItems", () => {
  it("indexes titles but never chapters, genres or authors", () => {
    const index = indexTitleItems(homeProps);
    for (const item of homeProps.latest.items) expect(index.has(item.slug)).toBe(true);
    for (const [slug, item] of index) {
      expect(item.url).toBe(`/${slug}`);
    }
    expect(index.has("fantasy")).toBe(false);
  });

  it("fills fields an earlier, thinner copy of the same title left empty", () => {
    const index = indexTitleItems({
      a: [{ slug: "x", name: "X", url: "/x", latestChapters: [] }],
      b: [{ slug: "x", name: "X", url: "/x", latestChapters: [{ name: "Chapter 9" }] }],
    });
    expect(index.get("x")?.latestChapters).toEqual([{ name: "Chapter 9" }]);
  });
});

// ── search ─────────────────────────────────────────────────────────────

describe("search", () => {
  it("returns a hollow result for an empty or blank query without touching the site", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const source = createSource(host({}, { calls }));
    expect(await source.search("")).toEqual({ cards: [], hasMore: false, query: "", page: 1 });
    expect(await source.search("   ", 3)).toEqual({ cards: [], hasMore: false, query: "", page: 3 });
    expect(calls).toEqual([]);
  });

  it("reads page 1's results and the site's has_next flag", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const source = createSource(host({ "https://novelbuddy.me/search?q=shadow": searchHtml }, { calls }));
    const result = await source.search("  shadow ");

    expect(calls.map((c) => c.url)).toEqual(["https://novelbuddy.me/search?q=shadow"]);
    expect(result.query).toBe("shadow");
    expect(result.page).toBe(1);
    expect(result.hasMore).toBe(searchProps.ssrPagination.has_next);
    expect(result.hasMore).toBe(true);
    expect(result.cards.map((c) => c.url)).toEqual(
      searchProps.ssrItems.map((i: { slug: string }) => `https://novelbuddy.me/${i.slug}`),
    );
    expect(result.cards[0]).toEqual({
      url: `https://novelbuddy.me/${searchProps.ssrItems[0].slug}`,
      title: sanitizeText(searchProps.ssrItems[0].name),
      coverUrl: searchProps.ssrItems[0].cover,
      subtitle: searchProps.ssrItems[0].latestChapters[0].name,
      badges: searchProps.ssrItems[0].genres.map((g: { name: string }) => g.name).slice(0, 3),
    });
  });

  it("asks for page 2 with &page=2 and gets a different set of cards", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const source = createSource(
      host(
        {
          "https://novelbuddy.me/search?q=shadow&page=2": searchPage2Html,
          "https://novelbuddy.me/search?q=shadow": searchHtml,
        },
        { calls },
      ),
    );
    const page1 = await source.search("shadow", 1);
    const page2 = await source.search("shadow", 2);

    expect(calls.map((c) => c.url)).toEqual([
      "https://novelbuddy.me/search?q=shadow",
      "https://novelbuddy.me/search?q=shadow&page=2",
    ]);
    expect(page2.page).toBe(2);
    expect(page2.hasMore).toBe(searchPage2Props.ssrPagination.has_next);
    expect(page2.cards.length).toBe(searchPage2Props.ssrItems.length);
    const page1Urls = new Set(page1.cards.map((c) => c.url));
    expect(page2.cards.some((c) => page1Urls.has(c.url))).toBe(false);
  });

  it("returns no cards and hasMore=false when nothing matches", async () => {
    const source = createSource(host({ "/search?q=zzqqxxnomatch": searchEmptyHtml }));
    expect(await source.search("zzqqxxnomatch")).toEqual({
      cards: [],
      hasMore: false,
      query: "zzqqxxnomatch",
      page: 1,
    });
  });

  it("throws on a non-2xx answer and on a page with no results list", async () => {
    await expect(
      createSource(host({ "/search": searchHtml }, { status: () => 429 })).search("shadow"),
    ).rejects.toThrow(`${PREFIX}https://novelbuddy.me/search?q=shadow answered HTTP 429.`);
    // The home page is a real Next.js page, just not a search page.
    await expect(createSource(host({ "/search": homeHtml })).search("shadow")).rejects.toThrow(
      `${PREFIX}search page https://novelbuddy.me/search?q=shadow carried no results list`,
    );
  });
});

describe("cardFor", () => {
  it("refuses objects that can't name a novel", () => {
    expect(cardFor(null)).toBeNull();
    expect(cardFor({ slug: "x" })).toBeNull();
    expect(cardFor({ name: "X" })).toBeNull();
    expect(cardFor({ name: "X", url: "/x/chapter-1" })).toBeNull();
    expect(cardFor({ name: " X ", url: "/x" })).toEqual({
      url: "https://novelbuddy.me/x",
      title: "X",
      coverUrl: undefined,
      subtitle: undefined,
      badges: undefined,
    });
  });
});

// ── getNovel ───────────────────────────────────────────────────────────

describe("getNovel", () => {
  it("fetches the novel page, then the full chapter list with the page's cv", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    await createSource(novelHost({ calls })).getNovel(NOVEL_URL);
    expect(calls.map((c) => c.url)).toEqual([NOVEL_URL, CHAPTER_LIST_URL]);
  });

  it("goes to the canonical host from a mirror or legacy /novel/ URL", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const novel = await createSource(novelHost({ calls })).getNovel("https://novelbuddy.io/novel/shadows-oath");
    expect(calls[0].url).toBe(NOVEL_URL);
    expect(novel.title).toBe(novelManga.name);
  });

  it("reads the novel's metadata", async () => {
    const novel = await createSource(novelHost()).getNovel(NOVEL_URL);
    expect(novel.title).toBe("Shadow's Oath");
    expect(novel.author).toBe(novelManga.authors.map((a: { name: string }) => a.name).join(", "));
    expect(novel.originalTitle).toBe(novelManga.altName);
    expect(novel.language).toBe("en");
    expect(novel.direction).toBe("ltr");
    expect(novel.coverUrl).toBe(novelManga.cover);
    expect(novel.description).toBe(sanitizeText(novelManga.summary));
    expect(novel.tags).toEqual(novelManga.genres.map((g: { name: string }) => g.name));
    expect(novel.status).toBe("Ongoing");
    expect(novel.meta).toEqual([
      { label: "Type", value: novelManga.type.name },
      { label: "Chapters", value: String(chapterRows.length) },
      { label: "Rating", value: `${novelManga.displayRating} (${novelManga.ratingsCount})` },
      { label: "Views", value: novelManga.displayViews },
      { label: "Last updated", value: novelManga.updatedAt.slice(0, 10) },
    ]);
  });

  it("returns every chapter, oldest first, with 1-based ids and absolute URLs", async () => {
    const novel = await createSource(novelHost()).getNovel(NOVEL_URL);
    expect(novel.volumes).toHaveLength(1);
    const [volume] = novel.volumes;
    expect(volume.id).toBe(1);
    expect(volume.title).toBe("All Chapters");
    expect(volume.chapterCount).toBe(chapterRows.length);
    expect(volume.chapters).toHaveLength(chapterRows.length);

    // The API sends newest first; the book reads oldest first.
    const reversed = [...chapterRows].reverse();
    expect(volume.chapters.map((c) => c.url)).toEqual(reversed.map((r) => `https://novelbuddy.me${r.url}`));
    expect(volume.chapters.map((c) => c.title)).toEqual(reversed.map((r) => r.name));
    expect(volume.chapters.map((c) => c.id)).toEqual(reversed.map((_, i) => i + 1));
    expect(volume.chapters.every((c) => c.lines.length === 0)).toBe(true);
    expect(volume.chapters[0].title).toMatch(/^Chapter 1\b/);
  });

  it("leaves a list that is already oldest-first in that order", async () => {
    const ascending = JSON.stringify({ success: true, data: { chapters: [...chapterRows].reverse() } });
    const novel = await createSource(
      host({ [NOVEL_URL]: novelHtml, [CHAPTER_LIST_URL]: ascending }),
    ).getNovel(NOVEL_URL);
    expect(novel.volumes[0].chapters[0].url).toBe(`https://novelbuddy.me${chapterRows.at(-1).url}`);
  });

  it("titles the volume in the host's locale", async () => {
    const novel = await createSource(novelHost({ locale: "ar" })).getNovel(NOVEL_URL);
    expect(novel.volumes[0].title).toBe("جميع الفصول");
    expect(novel.meta[0].label).toBe("النوع");
  });

  it("warns when the chapter list disagrees with the page's chapter count", async () => {
    const logs: LogEntry[] = [];
    const short = JSON.stringify({ success: true, data: { chapters: chapterRows.slice(0, 5) } });
    await createSource(host({ [NOVEL_URL]: novelHtml, [CHAPTER_LIST_URL]: short }, { logs })).getNovel(NOVEL_URL);
    expect(logs.filter((l) => l.level === "warn").map((l) => l.message)).toEqual([
      `${PREFIX}${NOVEL_URL} reports ${novelManga.stats.chaptersCount} chapters but the chapter list returned 5.`,
    ]);
  });

  it("logs at info and stays quiet when the counts agree", async () => {
    const logs: LogEntry[] = [];
    await createSource(novelHost({ logs })).getNovel(NOVEL_URL);
    expect(logs).toEqual([{ level: "info", message: `getNovel(${NOVEL_URL})` }]);
  });

  it("throws, naming the page, when the novel page answers non-2xx", async () => {
    const source = createSource(novelHost({ status: (u) => (u === NOVEL_URL ? 404 : 200) }));
    await expect(source.getNovel(NOVEL_URL)).rejects.toThrow(`${PREFIX}${NOVEL_URL} answered HTTP 404.`);
  });

  it("throws when the page carries no novel data", async () => {
    const source = createSource(host({ [NOVEL_URL]: searchEmptyHtml }));
    await expect(source.getNovel(NOVEL_URL)).rejects.toThrow(
      `${PREFIX}${NOVEL_URL} carried no novel data (pageProps.initialManga)`,
    );
  });

  it("throws on a chapter-list failure instead of returning a truncated book", async () => {
    const withList = (body: string, status = 200) =>
      createSource(
        host({ [NOVEL_URL]: novelHtml, [CHAPTER_LIST_URL]: body }, { status: (u) => (u === NOVEL_URL ? 200 : status) }),
      ).getNovel(NOVEL_URL);

    await expect(withList(chaptersJson, 500)).rejects.toThrow(
      `${PREFIX}chapter list ${CHAPTER_LIST_URL} answered HTTP 500.`,
    );
    await expect(withList("<html>bad gateway</html>")).rejects.toThrow(
      `${PREFIX}chapter list ${CHAPTER_LIST_URL} did not return JSON (HTTP 200).`,
    );
    await expect(withList(JSON.stringify({ success: false, message: "Title not found" }))).rejects.toThrow(
      `${PREFIX}chapter list ${CHAPTER_LIST_URL} did not contain data.chapters (Title not found).`,
    );
  });

  it("rejects a non-NovelBuddy URL before fetching anything", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    await expect(createSource(host({}, { calls })).getNovel("https://example.com/x")).rejects.toThrow(
      SourceUrlError,
    );
    expect(calls).toEqual([]);
  });
});

describe("buildNovel (metadata-rich page: Shadow Slave)", () => {
  const novel = buildNovel(richManga, [], strings("en"));

  it("lists genres then tags, without case-insensitive duplicates", () => {
    const genres: string[] = richManga.genres.map((g: { name: string }) => g.name);
    const tags: string[] = richManga.tags.map((g: { name: string }) => g.name);
    const expected: string[] = [];
    for (const name of [...genres, ...tags]) {
      if (!expected.some((e) => e.toLowerCase() === name.toLowerCase())) expected.push(name);
    }
    expect(novel.tags).toEqual(expected);
    expect(novel.tags.slice(0, genres.length)).toEqual(genres);
    expect(novel.tags.length).toBeLessThan(genres.length + tags.length);
  });

  it("turns the HTML summary into plain paragraphs", () => {
    const doc = parseHtml(richManga.summary);
    doc.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
    const expected = (doc.body.textContent ?? "")
      .split("\n")
      .map((s) => sanitizeText(s))
      .filter(Boolean)
      .join("\n\n");
    expect(novel.description).toBe(expected);
    expect(novel.description).not.toMatch(/<|&lt;/);
    expect(novel.description?.split("\n\n").length).toBe(2);
  });

  it("drops an alt name that just repeats the title, and keeps bookmarks", () => {
    expect(novel.originalTitle).toBeUndefined();
    expect(novel.author).toBe("Guiltythree");
    expect(novel.meta).toContainEqual({ label: "Bookmarks", value: richManga.displayBookmarks });
    expect(novel.meta).toContainEqual({ label: "Chapters", value: "0" });
  });
});

describe("normalizeStatus", () => {
  it("renders the site's spellings consistently", () => {
    expect(normalizeStatus("OnGoing")).toBe("Ongoing");
    expect(normalizeStatus("ongoing")).toBe("Ongoing");
    expect(normalizeStatus("Completed")).toBe("Completed");
    expect(normalizeStatus("")).toBeUndefined();
    expect(normalizeStatus(null)).toBeUndefined();
  });
});

// ── getChapterContent ──────────────────────────────────────────────────

/** Independent of src: the chapter body's own `<p>` texts, as the test
 *  reads them. */
function paragraphsOf(pageHtml: string): string[] {
  const content: string = pageProps(pageHtml).initialChapter.content;
  return Array.from(parseHtml(content).querySelectorAll("p"))
    .map((p) => sanitizeText(p.textContent))
    .filter(Boolean);
}

const chapterOf = (url: string) => ({ id: 1, title: "t", url, lines: [] });

describe("getChapterContent", () => {
  const CH_URL = "https://novelbuddy.me/shadows-oath/chapter-108";

  it("returns the chapter's paragraphs minus credit lines and the site's TTS notice", async () => {
    const lines = await createSource(host({ [CH_URL]: chapterHtml })).getChapterContent(chapterOf(CH_URL));
    const credits = /^\[(Translator|Proofreader) - \w+\]$/;
    const paragraphs = paragraphsOf(chapterHtml);
    expect(paragraphs.filter((p) => credits.test(p)).length).toBeGreaterThan(0); // fixture sanity

    expect(lines).toEqual(paragraphs.filter((p) => !credits.test(p)).map((content) => ({ type: "text", content })));
    expect(lines.some((l) => /text-to-speech/.test(l.content))).toBe(false);
    expect(pageProps(chapterHtml).initialChapter.content).toContain("text-to-speech"); // fixture sanity
  });

  it("drops a wrapper heading and an Editor credit that sit outside <p>", async () => {
    const url = pageProps(chapterHeadingHtml).initialChapter.url;
    const absolute = `https://novelbuddy.me${url}`;
    const lines = await createSource(host({ [absolute]: chapterHeadingHtml })).getChapterContent(chapterOf(absolute));
    expect(lines.map((l) => l.content)).toEqual(paragraphsOf(chapterHeadingHtml));
    expect(lines[0].content).not.toMatch(/^Chapter \d+/);
    expect(lines.some((l) => /Henyee/.test(l.content))).toBe(false);
  });

  it("splits a <br>-only machine translation into lines", async () => {
    const url = "https://novelbuddy.me/mtl-cultivation-fishermen/chapter-1";
    const content: string = pageProps(chapterMtlHtml).initialChapter.content;
    expect(paragraphsOf(chapterMtlHtml)).toEqual([]); // fixture sanity: no <p> text at all

    const expected = content
      .split(/<br\s*\/?>/i)
      .map((s) => sanitizeText(parseHtml(s).body.textContent))
      .filter(Boolean);
    expect(expected[0]).toBe("Chapter 1");
    expect(expected.at(-1)).toBe("(End of this chapter)");

    const lines = await createSource(host({ [url]: chapterMtlHtml })).getChapterContent(chapterOf(url));
    expect(lines.map((l) => l.content)).toEqual(expected.slice(1, -1));
    expect(lines.every((l) => l.type === "text")).toBe(true);
  });

  it("fetches the canonical URL for a mirror or legacy chapter URL", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    await createSource(host({ [CH_URL]: chapterHtml }, { calls })).getChapterContent(
      chapterOf("https://novelbuddy.io/novel/shadows-oath/chapter-108"),
    );
    expect(calls.map((c) => c.url)).toEqual([CH_URL]);
  });

  it("logs at debug, not info", async () => {
    const logs: LogEntry[] = [];
    await createSource(host({ [CH_URL]: chapterHtml }, { logs })).getChapterContent(chapterOf(CH_URL));
    expect(logs).toEqual([{ level: "debug", message: `getChapterContent(${CH_URL})` }]);
  });

  it("throws on a non-2xx answer", async () => {
    const source = createSource(host({ [CH_URL]: chapterHtml }, { status: () => 404 }));
    await expect(source.getChapterContent(chapterOf(CH_URL))).rejects.toThrow(`${PREFIX}${CH_URL} answered HTTP 404.`);
  });

  it("throws when the page carries no chapter", async () => {
    const source = createSource(host({ [CH_URL]: novelHtml }));
    await expect(source.getChapterContent(chapterOf(CH_URL))).rejects.toThrow(
      `${PREFIX}${CH_URL} carried no chapter text (pageProps.initialChapter.content)`,
    );
  });

  it("throws when the chapter body has no text in it", async () => {
    const empty = chapterHtml.replace(
      /("initialChapter":\{[^]*?"content":)"(?:\\.|[^"\\])*"/,
      '$1"<div></div><p> </p>"',
    );
    expect(empty).not.toBe(chapterHtml);
    const source = createSource(host({ [CH_URL]: empty }));
    await expect(source.getChapterContent(chapterOf(CH_URL))).rejects.toThrow(
      `${PREFIX}chapter body at ${CH_URL} parsed to zero lines of text.`,
    );
  });

  it("rejects a novel URL passed as a chapter", async () => {
    await expect(createSource(host({})).getChapterContent(chapterOf(NOVEL_URL))).rejects.toThrow(PREFIX);
  });
});

describe("htmlToRawLines + chapterLinesFrom", () => {
  it("emits images as absolute image lines and skips data: URIs and scripts", () => {
    const raw = htmlToRawLines(
      '<p>Before</p><img src="/static/a.png"><p>x<img src="data:image/png;base64,AAA">y</p><script>ad()</script><p>After</p>',
      "https://novelbuddy.me/n/c",
    );
    expect(chapterLinesFrom(raw)).toEqual([
      { type: "text", content: "Before" },
      { type: "image", content: "https://novelbuddy.me/static/a.png" },
      { type: "text", content: "x" },
      { type: "text", content: "y" },
      { type: "text", content: "After" },
    ]);
  });

  it("keeps a 'Chapter N' line a translator wrote as a real paragraph", () => {
    const raw = htmlToRawLines("<p>Chapter 3: Rain</p><p>It rained.</p>", "https://novelbuddy.me/n/c");
    expect(chapterLinesFrom(raw).map((l) => l.content)).toEqual(["Chapter 3: Rain", "It rained."]);
  });

  it("does not mistake dialogue that mentions an editor for a credit line", () => {
    const raw = htmlToRawLines(
      "<p>The editor: a tired man who never slept.</p><p>Editor: Henyee Translations</p>",
      "https://novelbuddy.me/n/c",
    );
    expect(chapterLinesFrom(raw).map((l) => l.content)).toEqual(["The editor: a tired man who never slept."]);
  });
});

// ── searchChapters ─────────────────────────────────────────────────────

describe("searchChapters", () => {
  it("filters the list getNovel already fetched, without another request", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const source = createSource(novelHost({ calls }));
    await source.getNovel(NOVEL_URL);
    calls.length = 0;

    const hits = await source.searchChapters!(NOVEL_URL, "  CHAPTER 10 ");
    expect(calls).toEqual([]);
    const expected = [...chapterRows]
      .reverse()
      .filter((r) => r.name.toLowerCase().includes("chapter 10"))
      .map((r) => `https://novelbuddy.me${r.url}`);
    expect(hits.map((h) => h.url)).toEqual(expected);
    expect(hits.length).toBeGreaterThan(1);
  });

  it("fetches the list itself when getNovel hasn't run in this session", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const hits = await createSource(novelHost({ calls })).searchChapters!(NOVEL_URL, "chapter 1");
    expect(calls.map((c) => c.url)).toEqual([NOVEL_URL, CHAPTER_LIST_URL]);
    expect(hits.length).toBeGreaterThan(0);
  });

  it("returns nothing for an empty query", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    expect(await createSource(novelHost({ calls })).searchChapters!(NOVEL_URL, "  ")).toEqual([]);
    expect(calls).toEqual([]);
  });
});

// ── catalogue + icon ───────────────────────────────────────────────────

describe("strings + manifest", () => {
  it("has the same keys in both locales", async () => {
    const mod = await import("../src/strings");
    const en = mod.strings("en");
    const ar = mod.strings("ar");
    expect(en("allChapters")).toBe("All Chapters");
    expect(ar("allChapters")).toBe("جميع الفصول");
    expect(en("chapterFallback", { n: 7 })).toBe("Chapter 7");
    expect(ar("chapterFallback", { n: 7 })).toBe("الفصل 7");
  });

  it("ships a 128x128 icon.png", () => {
    const png = readFileSync(join(FIXTURES_DIR, "..", "..", "icon.png"));
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(128);
    expect(png.readUInt32BE(20)).toBe(128);
  });

  it("declares the id the errors are prefixed with", () => {
    expect(ID).toBe("novelbuddy");
  });
});
