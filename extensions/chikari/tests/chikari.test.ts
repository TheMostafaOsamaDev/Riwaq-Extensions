import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import createSource, {
  CHAPTER_PAGE_SIZE,
  SEARCH_PAGE_SIZE,
  chapterRefFromUrl,
  isJunkLine,
  parseChapterBody,
  slugFromUrl,
  type ChapterRead,
  type ChapterRow,
  type NovelDetail,
  type SeriesItem,
} from "../src/index";
import { strings } from "../src/strings";
import { SourceUrlError } from "@riwaq/extension-api";
import { createTestHost, type TestHostOptions } from "@riwaq/extension-api/testing";

// Fixture paths via fileURLToPath + join, never `new URL(rel, import.meta.url)`:
// happy-dom's patched URL resolves a relative URL against its fake
// window.location instead (see the repo README's Testing section).
const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");
const fixture = (name: string) => readFileSync(join(FIXTURES_DIR, name), "utf8");

/** Errors are prefixed with the manifest id, read from the manifest itself so
 *  renaming the id without updating the messages fails this suite. */
const MANIFEST = JSON.parse(readFileSync(join(FIXTURES_DIR, "..", "..", "manifest.json"), "utf8")) as {
  id: string;
  icon: string;
};
const ID = MANIFEST.id;
const PREFIX = `${ID}:`;

// Every fixture is an unedited live capture of the URL named beside it,
// taken 2026-10-29. Expectations are derived from the parsed fixtures at
// test time wherever the value is "whatever the site said", so a recapture
// doesn't need the assertions rewritten.
const B = "https://chikari.moe";
const HOME_URL = `${B}/api/home?type=novel`;
const searchUrl = (q: string, offset: number) =>
  `${B}/api/series?q=${encodeURIComponent(q)}&type=novel&limit=${SEARCH_PAGE_SIZE}&offset=${offset}`;
const SLUG = "swordmasters-youngest-son";
const NOVEL_URL = `${B}/novels/${SLUG}`;
const NOVEL_API = `${B}/api/novels/${SLUG}`;
const chaptersUrl = (offset: number, q?: string) =>
  `${NOVEL_API}/chapters?${q ? `q=${encodeURIComponent(q)}&` : ""}order=asc&limit=${CHAPTER_PAGE_SIZE}&offset=${offset}`;
const readUrl = (slug: string, n: number) => `${B}/api/novels/${slug}/chapters/${n}/read`;

const homeJson = fixture("home.json"); // GET /api/home?type=novel
const searchP1Json = fixture("search-p1.json"); // GET /api/series?q=sword&type=novel&limit=36&offset=0
const searchP2Json = fixture("search-p2.json"); // … offset=36
const searchNoneJson = fixture("search-none.json"); // … q=zzqqxxnotitle … offset=0
const novelJson = fixture("novel.json"); // GET /api/novels/swordmasters-youngest-son
const chaptersP1Json = fixture("chapters-p1.json"); // … /chapters?order=asc&limit=500&offset=0
const chaptersP2Json = fixture("chapters-p2.json"); // … offset=500
const chapterSearchJson = fixture("chapter-search.json"); // … /chapters?q=Banquet&order=asc&limit=500&offset=0
const notFoundJson = fixture("not-found.json"); // GET /api/novels/no-such-novel-zz (HTTP 404)

const home = JSON.parse(homeJson) as { rows: Array<{ slug: string; items: SeriesItem[] }> };
const searchP1 = JSON.parse(searchP1Json) as { items: SeriesItem[]; total: number };
const searchP2 = JSON.parse(searchP2Json) as { items: SeriesItem[]; total: number };
const novel = JSON.parse(novelJson) as NovelDetail & { tags: Array<{ name: string }> };
const chaptersP1 = JSON.parse(chaptersP1Json) as { items: ChapterRow[]; total: number };
const chaptersP2 = JSON.parse(chaptersP2Json) as { items: ChapterRow[]; total: number };
const chapterSearch = JSON.parse(chapterSearchJson) as { items: ChapterRow[]; total: number };

/** Chapter fixtures: GET /api/novels/<slug>/chapters/<n>/read. */
const CHAPTERS = {
  // inline <strong> headings, then a Ko-fi plug at the end
  promo: { file: "chapter.json", slug: SLUG, n: 400 },
  // a "Translator: … Editor: …" credit line first
  credits: { file: "chapter-credits.json", slug: "lord-of-the-mysteries", n: 5 },
  // "<Dark Exploration Records>" is story text, not markup
  angle: { file: "chapter-angle-brackets.json", slug: "got-dropped-into-a-ghost-story-still-gotta-work", n: 110 },
  // a trailing "Translator's Comments" block of Discord/advance-chapter plugs
  notes: { file: "chapter-notes.json", slug: "trash-of-the-counts-family", n: 929 },
  // Discord/support links at both ends, plus a translator's note
  links: { file: "chapter-links.json", slug: "a-regressors-tale-of-cultivation", n: 75 },
  // one of the newest-8 early-access chapters: locked, empty body
  locked: { file: "chapter-locked.json", slug: "genetic-ascension", n: 2496 },
} as const;
type ChapterKey = keyof typeof CHAPTERS;
const chapterJson = (k: ChapterKey) => fixture(CHAPTERS[k].file);
const chapterOf = (k: ChapterKey) => ({
  id: CHAPTERS[k].n,
  title: "",
  url: `${B}/novels/${CHAPTERS[k].slug}/${CHAPTERS[k].n}`,
  lines: [],
});

/** The site reader's own paragraph split (index.ts must agree with it),
 *  re-implemented here rather than imported so a bug there can't make its
 *  own test pass: split on newlines, honour only the reader's inline-tag
 *  whitelist, collapse whitespace. No junk filtering. */
function readerLines(body: string): string[] {
  const out: string[] = [];
  for (const para of body.split(/\n\s*\n|\n/)) {
    for (const piece of para.split(/<br\s*\/?>/i)) {
      const text = piece
        .replace(/<\/?(em|strong|i|b|u|s|sup|sub)>/gi, "")
        .replace(/\s+/g, " ")
        .trim();
      if (text) out.push(text);
    }
  }
  return out;
}

const NOVEL_ROUTES = {
  [NOVEL_API]: novelJson,
  [chaptersUrl(0)]: chaptersP1Json,
  [chaptersUrl(500)]: chaptersP2Json,
};

type Calls = Array<{ url: string; method: string; body?: string }>;

/** Every request answers `status` with `text`. */
const statusHost = (status: number, text: string) =>
  createTestHost({ responses: { [B]: text }, status: { [B]: status } });

const CHALLENGE_BODY = JSON.stringify({ code: "challenge_required" });

/** Settles `run()` under fake timers, so the shared fetcher's retry
 *  backoffs take no real time. */
async function settled<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const pending = run();
    pending.catch(() => {});
    await vi.runAllTimersAsync();
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

// ── manifest ────────────────────────────────────────────────────────────────

describe("manifest", () => {
  it("has the directory name as its id", () => {
    expect(ID).toBe("chikari");
  });

  it("ships a 128×128 PNG icon", () => {
    const png = readFileSync(join(FIXTURES_DIR, "..", "..", MANIFEST.icon));
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(png.subarray(12, 16).toString("latin1")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(128);
    expect(png.readUInt32BE(20)).toBe(128);
  });
});

describe("strings", () => {
  it("defines every key in both locales", async () => {
    const en = strings("en");
    const ar = strings("ar");
    // Every en key must resolve to a non-empty, different-language string in ar.
    for (const key of ["homeTrending", "statusCompleted", "chapterFallback", "metaRating"] as const) {
      expect(en(key)).not.toBe("");
      expect(ar(key)).not.toBe("");
      expect(ar(key)).not.toBe(en(key));
    }
    expect(en("chapterFallback", { n: 7 })).toBe("Chapter 7");
    expect(ar("chapterFallback", { n: 7 })).toBe("الفصل 7");
  });
});

// ── canHandle / URL helpers ─────────────────────────────────────────────────

describe("canHandle", () => {
  const source = createSource(createTestHost());

  it("accepts novel and chapter URLs on the live domain", () => {
    expect(source.canHandle(`${B}/novels/shadow-slave`)).toBe(true);
    expect(source.canHandle(`${B}/novels/shadow-slave/`)).toBe(true);
    expect(source.canHandle(`${B}/novels/shadow-slave/12`)).toBe(true);
    expect(source.canHandle(`${B}/novels/shadow-slave/12.5`)).toBe(true);
    expect(source.canHandle(`${B}/novels/shadow-slave/reviews/3`)).toBe(true);
    expect(source.canHandle("https://www.chikari.moe/novels/shadow-slave")).toBe(true);
  });

  it("rejects the site's manga, its non-novel pages and other sites", () => {
    expect(source.canHandle(`${B}/series/solo-leveling`)).toBe(false);
    expect(source.canHandle(`${B}/series/solo-leveling/1`)).toBe(false);
    expect(source.canHandle(`${B}/`)).toBe(false);
    expect(source.canHandle(`${B}/novels`)).toBe(false);
    expect(source.canHandle(`${B}/novels/`)).toBe(false);
    expect(source.canHandle(`${B}/search?q=sword`)).toBe(false);
    expect(source.canHandle("https://lightnovelworld.org/novel/shadow-slave")).toBe(false);
    expect(source.canHandle("https://seanovel.org/novels/shadow-slave")).toBe(false);
    expect(source.canHandle("not a url")).toBe(false);
  });

  it("rejects hostnames that merely contain chikari.moe", () => {
    expect(source.canHandle("https://notchikari.moe/novels/x")).toBe(false);
    expect(source.canHandle("https://chikari.moe.evil.com/novels/x")).toBe(false);
  });
});

describe("slugFromUrl / chapterRefFromUrl", () => {
  it("extracts the slug from novel, chapter and review URLs", () => {
    expect(slugFromUrl(`${B}/novels/shadow-slave`)).toBe("shadow-slave");
    expect(slugFromUrl(`${B}/novels/shadow-slave/42`)).toBe("shadow-slave");
    expect(slugFromUrl(`${B}/novels/shadow-slave/reviews/3`)).toBe("shadow-slave");
  });

  it("extracts slug and number from chapter URLs, fractional numbers included", () => {
    expect(chapterRefFromUrl(`${B}/novels/shadow-slave/42`)).toEqual({ slug: "shadow-slave", number: 42 });
    expect(chapterRefFromUrl(`${B}/novels/x/12.5`)).toEqual({ slug: "x", number: 12.5 });
  });

  it("throws a branded SourceUrlError for anything else", () => {
    for (const bad of [`${B}/series/solo-leveling`, "https://example.com/novels/x", "nope"]) {
      expect(() => slugFromUrl(bad)).toThrow(SourceUrlError);
      expect(() => slugFromUrl(bad)).toThrow(PREFIX);
    }
    for (const bad of [`${B}/novels/x`, `${B}/novels/x/reviews/3`, `${B}/novels/x/abc`]) {
      expect(() => chapterRefFromUrl(bad)).toThrow(SourceUrlError);
      expect(() => chapterRefFromUrl(bad)).toThrow(PREFIX);
    }
  });
});

// ── getHomeSections ─────────────────────────────────────────────────────────

describe("getHomeSections", () => {
  it("asks for the novel-only home feed", async () => {
    const calls: Calls = [];
    await createSource(createTestHost({ responses: { [HOME_URL]: homeJson }, calls })).getHomeSections();
    expect(calls.map((c) => c.url)).toEqual([HOME_URL]);
  });

  it("returns the site's own rows, in order, with stable ids and its headings", async () => {
    const sections = await createSource(
      createTestHost({ responses: { [HOME_URL]: homeJson }, locale: "en" }),
    ).getHomeSections();
    expect(sections.map((s) => s.id)).toEqual(home.rows.map((r) => r.slug));
    expect(sections.map((s) => s.title)).toEqual([
      "Trending",
      "Popular",
      "Top Rated",
      "Recently Updated",
      "Recently Added",
    ]);
    for (const [i, s] of sections.entries()) {
      expect(s.cards).toHaveLength(home.rows[i].items.length);
      expect(s.viewMoreUrl).toMatch(/^https:\/\/chikari\.moe\/search\?sort=\w+&type=novel$/);
    }
  });

  it("localises the headings for Arabic", async () => {
    const sections = await createSource(
      createTestHost({ responses: { [HOME_URL]: homeJson }, locale: "ar" }),
    ).getHomeSections();
    const ar = strings("ar");
    expect(sections[0].title).toBe(ar("homeTrending"));
  });

  it("builds each card from the feed row", async () => {
    const [first] = await createSource(createTestHost({ responses: { [HOME_URL]: homeJson } })).getHomeSections();
    const row = home.rows[0].items[0];
    expect(first.cards[0]).toEqual({
      url: `${B}/novels/${row.slug}`,
      title: row.title,
      coverUrl: row.cover_url,
      subtitle: `Ch. ${row.latest_chapter}`,
    });
    for (const card of first.cards) expect(card.url).toMatch(/^https:\/\/chikari\.moe\/novels\/[^/]+$/);
  });

  it("drops non-novel items and rows the site's own client doesn't know", async () => {
    // Derived from the capture: a manga item spliced into the first row, and
    // an extra row with an unknown slug.
    const doctored = structuredClone(home);
    doctored.rows[0].items.push({ ...doctored.rows[0].items[0], slug: "solo-leveling", medium: "comic" });
    doctored.rows.push({ slug: "because-you-read", items: doctored.rows[1].items });
    const sections = await createSource(
      createTestHost({ responses: { [HOME_URL]: JSON.stringify(doctored) } }),
    ).getHomeSections();
    expect(sections.map((s) => s.id)).toEqual(home.rows.map((r) => r.slug));
    expect(sections[0].cards.map((c) => c.url)).not.toContain(`${B}/novels/solo-leveling`);
    expect(sections[0].cards).toHaveLength(home.rows[0].items.length);
  });

  it("throws a branded error on an unexpected shape or an empty feed", async () => {
    for (const body of ["{}", JSON.stringify({ rows: [] }), "[]"]) {
      await expect(
        createSource(createTestHost({ responses: { [HOME_URL]: body } })).getHomeSections(),
      ).rejects.toThrow(PREFIX);
    }
  });

  it("throws a branded error on a non-200 or non-JSON answer", async () => {
    const down = createSource(statusHost(503, "<html>bad gateway</html>"));
    await expect(settled(() => down.getHomeSections())).rejects.toThrow(
      `${PREFIX} /api/home?type=novel answered HTTP 503.`,
    );
    await expect(createSource(statusHost(200, "<!doctype html>")).getHomeSections()).rejects.toThrow(
      `${PREFIX} /api/home?type=novel did not return JSON`,
    );
  });
});

// ── search ──────────────────────────────────────────────────────────────────

describe("search", () => {
  const searchHost = (calls: Calls = []) =>
    createTestHost({
      responses: { [searchUrl("sword", 0)]: searchP1Json, [searchUrl("sword", 36)]: searchP2Json },
      calls,
    });

  it("returns a hollow result for an empty query without calling the site", async () => {
    const calls: Calls = [];
    const source = createSource(createTestHost({ calls }));
    expect(await source.search("")).toEqual({ cards: [], hasMore: false, query: "", page: 1 });
    expect(await source.search("   ", 3)).toEqual({ cards: [], hasMore: false, query: "", page: 3 });
    expect(calls).toEqual([]);
  });

  it("searches novels only, page 1, with more pages to come", async () => {
    const calls: Calls = [];
    const r = await createSource(searchHost(calls)).search("  sword ", 1);
    expect(calls.map((c) => c.url)).toEqual([searchUrl("sword", 0)]);
    expect(r.query).toBe("sword");
    expect(r.page).toBe(1);
    expect(r.cards).toHaveLength(searchP1.items.length);
    expect(r.hasMore).toBe(searchP1.items.length < searchP1.total);
    expect(r.hasMore).toBe(true);
    expect(r.cards[0]).toEqual({
      url: `${B}/novels/${searchP1.items[0].slug}`,
      title: searchP1.items[0].title,
      coverUrl: searchP1.items[0].cover_url,
      subtitle: `Ch. ${searchP1.items[0].latest_chapter}`,
    });
  });

  it("pages by offset, and the last page reports no more", async () => {
    const calls: Calls = [];
    const source = createSource(searchHost(calls));
    const p1 = await source.search("sword", 1);
    const p2 = await source.search("sword", 2);
    expect(calls.map((c) => c.url)).toEqual([searchUrl("sword", 0), searchUrl("sword", 36)]);
    expect(p2.page).toBe(2);
    expect(p2.cards).toHaveLength(searchP2.items.length);
    expect(p2.hasMore).toBe(false);
    expect(p1.cards.length + p2.cards.length).toBe(searchP1.total);
    const p1Urls = new Set(p1.cards.map((c) => c.url));
    expect(p2.cards.filter((c) => p1Urls.has(c.url))).toEqual([]);
  });

  it("defaults a missing or nonsense page to 1", async () => {
    const calls: Calls = [];
    const source = createSource(searchHost(calls));
    expect((await source.search("sword")).page).toBe(1);
    expect((await source.search("sword", 0)).page).toBe(1);
    expect(calls.map((c) => c.url)).toEqual([searchUrl("sword", 0), searchUrl("sword", 0)]);
  });

  it("returns an empty, final page when nothing matches", async () => {
    const r = await createSource(
      createTestHost({ responses: { [searchUrl("zzqqxxnotitle", 0)]: searchNoneJson } }),
    ).search("zzqqxxnotitle");
    expect(r).toEqual({ cards: [], hasMore: false, query: "zzqqxxnotitle", page: 1 });
  });

  it("URL-encodes the query", async () => {
    const calls: Calls = [];
    await createSource(createTestHost({ responses: { "/api/series?": searchNoneJson }, calls })).search(
      "sword & sorcery?",
    );
    expect(calls[0].url).toBe(
      `${B}/api/series?q=sword%20%26%20sorcery%3F&type=novel&limit=${SEARCH_PAGE_SIZE}&offset=0`,
    );
  });

  it("never surfaces manga even if the API mixed some in", async () => {
    const doctored = structuredClone(searchP1);
    doctored.items[0] = { ...doctored.items[0], slug: "solo-leveling", medium: "comic" };
    const r = await createSource(
      createTestHost({ responses: { [searchUrl("sword", 0)]: JSON.stringify(doctored) } }),
    ).search("sword");
    expect(r.cards.map((c) => c.url)).not.toContain(`${B}/novels/solo-leveling`);
    expect(r.cards).toHaveLength(searchP1.items.length - 1);
  });

  it("throws branded errors for a rate-limit challenge, other failures and odd shapes", async () => {
    await expect(createSource(statusHost(429, CHALLENGE_BODY)).search("sword")).rejects.toThrow(
      /^chikari: chikari\.moe wants a human-verification check .*HTTP 429 challenge_required/,
    );
    await expect(createSource(statusHost(429, "slow down")).search("sword")).rejects.toThrow(
      `${PREFIX} chikari.moe is rate-limiting requests (HTTP 429`,
    );
    await expect(settled(() => createSource(statusHost(500, "oops")).search("sword"))).rejects.toThrow(PREFIX);
    await expect(createSource(statusHost(200, "[]")).search("sword")).rejects.toThrow(
      `${PREFIX} /api/series?q=sword&type=novel&limit=36&offset=0 returned an unexpected shape`,
    );
  });
});

// ── getNovel ────────────────────────────────────────────────────────────────

describe("getNovel", () => {
  const allRows = [...chaptersP1.items, ...chaptersP2.items];

  it("fetches the detail and every page of the chapter list", async () => {
    const calls: Calls = [];
    await createSource(createTestHost({ responses: NOVEL_ROUTES, calls })).getNovel(NOVEL_URL);
    expect(calls.map((c) => c.url).sort()).toEqual([NOVEL_API, chaptersUrl(0), chaptersUrl(500)].sort());
  });

  it("maps the detail object", async () => {
    const n = await createSource(createTestHost({ responses: NOVEL_ROUTES, locale: "en" })).getNovel(NOVEL_URL);
    expect(n.title).toBe(novel.title);
    expect(n.author).toBe(novel.authors!.map((a) => a.name).join(", "));
    expect(n.author).toBe("Emperor Penguin");
    expect(n.language).toBe("en");
    expect(n.direction).toBe("ltr");
    expect(n.coverUrl).toBe(novel.cover_url);
    expect(n.description).toBe(novel.description!.trim());
    expect(n.tags).toEqual(novel.genres!.map((g) => g.name));
    // The long NovelUpdates-style tag list is deliberately not surfaced.
    expect(n.tags).not.toContain(novel.tags[0].name);
    expect(n.status).toBe("Releasing");
    expect(n.meta).toEqual([
      { label: "Chapters", value: String(novel.chapter_count) },
      { label: "Rating", value: `${novel.rating} / 10 (${novel.rating_count} ratings)` },
      { label: "Views", value: String(novel.views) },
      { label: "Last updated", value: novel.last_chapter_at!.slice(0, 10) },
    ]);
  });

  it("localises synthesised labels for Arabic", async () => {
    const n = await createSource(createTestHost({ responses: NOVEL_ROUTES, locale: "ar" })).getNovel(NOVEL_URL);
    const ar = strings("ar");
    expect(n.status).toBe(ar("statusReleasing"));
    expect(n.meta[0].label).toBe(ar("metaChapters"));
    expect(n.volumes[0].title).toBe(ar("volumeFallback"));
  });

  it("returns every chapter, in order, in one populated volume", async () => {
    const n = await createSource(createTestHost({ responses: NOVEL_ROUTES })).getNovel(NOVEL_URL);
    expect(n.volumes).toHaveLength(1);
    const chapters = n.volumes[0].chapters;
    expect(chapters).toHaveLength(chaptersP1.total);
    expect(chapters).toHaveLength(allRows.length);
    expect(chapters.map((c) => c.id)).toEqual(allRows.map((r) => r.number));
    expect(new Set(chapters.map((c) => c.id)).size).toBe(chapters.length);
    expect(chapters[0]).toEqual({
      id: allRows[0].number,
      title: allRows[0].title,
      url: `${NOVEL_URL}/${allRows[0].number}`,
      lines: [],
    });
    const last = allRows[allRows.length - 1];
    expect(chapters[chapters.length - 1].url).toBe(`${NOVEL_URL}/${last.number}`);
  });

  it("falls back to the site's 'Chapter <n>' for an untitled chapter", async () => {
    const doctored = structuredClone(chaptersP1);
    doctored.items[0].title = "";
    const n = await createSource(
      createTestHost({ responses: { ...NOVEL_ROUTES, [chaptersUrl(0)]: JSON.stringify(doctored) }, locale: "en" }),
    ).getNovel(NOVEL_URL);
    expect(n.volumes[0].chapters[0].title).toBe(`Chapter ${doctored.items[0].number}`);
  });

  it("accepts a chapter URL in place of the novel URL", async () => {
    const n = await createSource(createTestHost({ responses: NOVEL_ROUTES })).getNovel(`${NOVEL_URL}/400`);
    expect(n.title).toBe(novel.title);
  });

  it("warns, rather than failing, when fewer chapters arrive than the list claims", async () => {
    const logs: NonNullable<TestHostOptions["logs"]> = [];
    const empty = JSON.stringify({ ...chaptersP2, items: [] });
    const host = createTestHost({ responses: { ...NOVEL_ROUTES, [chaptersUrl(500)]: empty }, logs });
    const n = await createSource(host).getNovel(NOVEL_URL);
    expect(n.volumes[0].chapters).toHaveLength(chaptersP1.items.length);
    const warned = logs.filter((l) => l.level === "warn" && l.message.startsWith("chikari:"));
    expect(warned.some((l) => l.message.includes(String(chaptersP1.total)))).toBe(true);
  });

  it("throws a branded 404 for a missing novel", async () => {
    await expect(createSource(statusHost(404, notFoundJson)).getNovel(`${B}/novels/no-such-novel-zz`)).rejects.toThrow(
      `${PREFIX} novel "no-such-novel-zz" was not found (HTTP 404`,
    );
  });

  it("throws a branded error for a foreign URL or an unexpected shape", async () => {
    await expect(createSource(createTestHost()).getNovel(`${B}/series/solo-leveling`)).rejects.toThrow(
      SourceUrlError,
    );
    await expect(
      createSource(createTestHost({ responses: { ...NOVEL_ROUTES, [NOVEL_API]: "[]" } })).getNovel(NOVEL_URL),
    ).rejects.toThrow(`${PREFIX} /api/novels/${SLUG} returned an unexpected shape`);
    await expect(
      createSource(createTestHost({ responses: { ...NOVEL_ROUTES, [chaptersUrl(0)]: "{}" } })).getNovel(NOVEL_URL),
    ).rejects.toThrow(`${PREFIX} /api/novels/${SLUG}/chapters?order=asc&limit=500&offset=0 returned an unexpected shape`);
  });
});

// ── searchChapters ──────────────────────────────────────────────────────────

describe("searchChapters", () => {
  it("returns nothing for an empty query without calling the site", async () => {
    const calls: Calls = [];
    expect(await createSource(createTestHost({ calls })).searchChapters!(NOVEL_URL, "  ")).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("uses the site's in-novel chapter search and matches getNovel's ids and URLs", async () => {
    const calls: Calls = [];
    const source = createSource(
      createTestHost({ responses: { ...NOVEL_ROUTES, [chaptersUrl(0, "Banquet")]: chapterSearchJson }, calls }),
    );
    const hits = await source.searchChapters!(NOVEL_URL, " Banquet ");
    expect(calls.map((c) => c.url)).toEqual([chaptersUrl(0, "Banquet")]);
    expect(hits.map((c) => c.id)).toEqual(chapterSearch.items.map((r) => r.number));
    expect(hits.map((c) => c.title)).toEqual(chapterSearch.items.map((r) => r.title));

    const byUrl = new Map(
      (await source.getNovel(NOVEL_URL)).volumes[0].chapters.map((c) => [c.url, c] as const),
    );
    for (const hit of hits) expect(byUrl.get(hit.url)).toEqual(hit);
  });
});

// ── getChapterContent ───────────────────────────────────────────────────────

describe("getChapterContent", () => {
  const contentOf = (k: ChapterKey, calls: Calls = []) =>
    createSource(
      createTestHost({ responses: { [readUrl(CHAPTERS[k].slug, CHAPTERS[k].n)]: chapterJson(k) }, calls }),
    ).getChapterContent(chapterOf(k));
  const bodyOf = (k: ChapterKey) => (JSON.parse(chapterJson(k)) as ChapterRead).body ?? "";

  /** Expected output = the reader's own lines minus exactly the named junk.
   *  Asserting the junk is really there first keeps the test honest. */
  async function expectLinesWithout(k: ChapterKey, junk: string[]) {
    const reader = readerLines(bodyOf(k));
    for (const j of junk) expect(reader).toContain(j);
    const lines = await contentOf(k);
    expect(lines.every((l) => l.type === "text")).toBe(true);
    expect(lines.map((l) => l.content)).toEqual(reader.filter((l) => !junk.includes(l)));
    return lines.map((l) => l.content);
  }

  it("calls the chapter's read endpoint", async () => {
    const calls: Calls = [];
    await contentOf("promo", calls);
    expect(calls.map((c) => c.url)).toEqual([readUrl(SLUG, 400)]);
  });

  it("strips the reader's inline tags and the Ko-fi plug", async () => {
    const lines = await expectLinesWithout("promo", [
      "KO-FIBUY ME A COFEE",
      "'Ko-fi o 'Buy Me A Coffe' for Adv4nc3 Ch4pt3r(Up to '120' more ch4pt3rs)Publication of up to 6 w33kly ch4pters, thanks.",
    ]);
    expect(lines[0]).toBe("C400 -Emperor Sword Banquet (5)");
    expect(lines[1]).toBe("When Ron's greetings concluded, the banquet began in earnest.");
    expect(lines.some((l) => /<\/?(strong|em|i)>/.test(l))).toBe(false);
  });

  it("drops a translator/editor credit line but keeps prose about translating", async () => {
    const lines = await expectLinesWithout("credits", ["Translator: AtlasStudios Editor: AtlasStudios"]);
    expect(lines[0]).toBe("Free? Free things cost the most!");
    expect(lines.some((l) => l.includes("he translated the"))).toBe(true);
  });

  it("keeps angle-bracketed story text the reader shows literally", async () => {
    const lines = await expectLinesWithout("angle", []);
    expect(lines).toContain("The <Dark Exploration Records> was an opensource wiki.");
  });

  it("drops a trailing translator's-comments block of Discord and advance-chapter plugs", async () => {
    const lines = await expectLinesWithout("notes", [
      "Translator's Comments",
      "Please join the discord to see an announcement that was posted.",
      "TCF is currently posted Mondays and Fridays at evening time GMT. Join our discord to be notified as soon as the chapter posts!",
      "If you can't wait, please subscribe to advanced chapters on our EAP website to get access to up to 8 chapters! Almost all tiers already have access to part 2 of TCF!",
    ]);
    expect(lines).toContain("The Sage Demon made one last comment.");
  });

  it("drops support links and translator notes at both ends", async () => {
    const reader = readerLines(bodyOf("links"));
    const note = reader.find((l) => l.startsWith("Translator Notes:"))!;
    const lines = await expectLinesWithout("links", [
      "Discord: https://dsc.gg/wetried",
      "Support: https://www.buymeacoffee.com/translatingnovice",
      note,
      "Link to donations in the discord!",
    ]);
    expect(lines[0]).toBe("It’s difficult to open my eyes.");
  });

  it("throws a branded error for a locked early-access chapter", async () => {
    await expect(contentOf("locked")).rejects.toThrow(
      `${PREFIX} chapter 2496 of "genetic-ascension" is locked on chikari.moe — early access for supporters (the newest 8 chapters).`,
    );
  });

  it("after a human-verification challenge, fails fast without asking the site again", async () => {
    const calls: Calls = [];
    const source = createSource(
      createTestHost({ responses: { [B]: CHALLENGE_BODY }, status: { [B]: 429 }, calls }),
    );
    await expect(source.getChapterContent(chapterOf("promo"))).rejects.toThrow(
      `${PREFIX} chikari.moe wants a human-verification check`,
    );
    await expect(source.search("sword")).rejects.toThrow(`${PREFIX} ${searchUrl("sword", 0)} was not requested`);
    expect(calls).toHaveLength(1);
  });

  it("throws a branded error for a club-restricted chapter", async () => {
    const doctored = { ...JSON.parse(chapterJson("promo")), club_block: { club: "x" } };
    await expect(
      createSource(createTestHost({ responses: { [readUrl(SLUG, 400)]: JSON.stringify(doctored) } })).getChapterContent(
        chapterOf("promo"),
      ),
    ).rejects.toThrow(`${PREFIX} chapter 400 of "${SLUG}" is restricted to a reading club`);
  });

  it("throws branded errors for 404, rate limiting, an empty body and a bad URL", async () => {
    const chapter = chapterOf("promo");
    await expect(createSource(statusHost(404, notFoundJson)).getChapterContent(chapter)).rejects.toThrow(
      `${PREFIX} chapter 400 of "${SLUG}" was not found (HTTP 404`,
    );
    await expect(createSource(statusHost(429, CHALLENGE_BODY)).getChapterContent(chapter)).rejects.toThrow(
      `${PREFIX} chikari.moe wants a human-verification check`,
    );
    const empty = JSON.stringify({ ...JSON.parse(chapterJson("promo")), body: "\n\n  \n" });
    await expect(createSource(statusHost(200, empty)).getChapterContent(chapter)).rejects.toThrow(
      `${PREFIX} chapter 400 of "${SLUG}" parsed to zero lines.`,
    );
    await expect(createSource(statusHost(200, "[]")).getChapterContent(chapter)).rejects.toThrow(
      `${PREFIX} /api/novels/${SLUG}/chapters/400/read returned an unexpected shape`,
    );
    await expect(
      createSource(createTestHost()).getChapterContent({ ...chapter, url: `${B}/series/solo-leveling/1` }),
    ).rejects.toThrow(SourceUrlError);
  });
});

// ── body parsing (pure) ─────────────────────────────────────────────────────

describe("parseChapterBody / isJunkLine", () => {
  it("splits on blank lines, single newlines and <br>", () => {
    expect(parseChapterBody("One.\n\nTwo.\nThree.<br>Four.<br />Five.").map((l) => l.content)).toEqual([
      "One.",
      "Two.",
      "Three.",
      "Four.",
      "Five.",
    ]);
  });

  it("strips only the reader's inline-tag whitelist", () => {
    expect(parseChapterBody("<em>Swoosh</em> <b>went</b> the <Blade of Night>.")).toEqual([
      { type: "text", content: "Swoosh went the <Blade of Night>." },
    ]);
  });

  it("drops credit lines at a chapter's top or bottom, not in the middle", () => {
    for (const credit of [
      "Translator: ChibiGeneral Editor: ChibiGeneral",
      "Editor: echo",
      "Translator: Willia",
    ]) {
      const story = ["One.", "Two.", "Three.", "Four.", "Five.", "Six.", "Seven.", "Eight."];
      const texts = (body: string[]) => parseChapterBody(body.join("\n\n")).map((l) => l.content);
      expect(texts([credit, ...story]), credit).toEqual(story);
      expect(texts([...story, credit]), credit).toEqual(story);
      const middle = [...story.slice(0, 4), credit, ...story.slice(4)];
      expect(texts(middle), credit).toEqual(middle);
    }
  });

  it("cuts an aggregator watermark out of a story line instead of dropping the line", () => {
    expect(parseChapterBody("He went home.lightnovelworld.com\n\nThe end.").map((l) => l.content)).toEqual([
      "He went home.",
      "The end.",
    ]);
  });

  it("flags promo and link lines", () => {
    for (const junk of [
      "For more chapters, you can check out my Patreon here –> https://patreon.com/warriorsballad",
      "Discord:https://dsc.gg/reapercomics",
      "12/17 Bonus chapter thanks to @Nathan To and others on Ko-fi!",
      "Read the latest chapters at lightnovelworld.com",
    ]) {
      expect(isJunkLine(junk), junk).toBe(true);
    }
  });

  it("keeps ordinary prose that merely brushes against those words", () => {
    // Lines seen in real chapters during calibration.
    for (const prose of [
      "“The coffee here is delicious.”",
      "Her eyes widened in shock as she pulled up the stream to see the endless number of comments.",
      "“Imbecile! What a waste of the Lord’s gift!”",
      "The word for imagination could also be translated as illusion, vision, or sight.",
      "There was discord between the two sects for a hundred years.",
      "It was about time.Me and him had waited long enough.",
      "Ed nodded and left the room without a word.",
      "Kofi Mensah lowered his sword.",
    ]) {
      expect(isJunkLine(prose), prose).toBe(false);
    }
  });
});
