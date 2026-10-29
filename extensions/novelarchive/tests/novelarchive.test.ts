import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import createSource, {
  BASE_URL,
  cardFor,
  chapterRefFromUrl,
  chaptersFor,
  contentToLines,
  coverUrlFor,
  genresOf,
  novelIdFromUrl,
  PAGE_SIZE,
  type NovelRow,
} from "../src/index";
import { cleanLines, fold, repairMojibake, stripWatermarks } from "../src/clean";
import { strings } from "../src/strings";
import { SourceUrlError, type FetchResponse, type SourceHost } from "@riwaq/extension-api";
import { createTestHost, type TestHostOptions } from "@riwaq/extension-api/testing";

// Read fixtures with fileURLToPath(import.meta.url) + path.join, never a
// relative `new URL(...)`: happy-dom's patched URL resolves that against its
// fake window.location (see the repo README, "Testing").
const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");
const fixture = (name: string) => readFileSync(join(FIXTURES_DIR, name), "utf8");
const json = <T = any>(name: string): T => JSON.parse(fixture(name)) as T;

/** This extension's manifest id. Errors are prefixed with it, never with the
 *  display name; reading it here means renaming the id without updating the
 *  error strings fails this suite. */
const MANIFEST = JSON.parse(readFileSync(join(FIXTURES_DIR, "..", "..", "manifest.json"), "utf8")) as {
  id: string;
};
const PREFIX = `${MANIFEST.id}: `;

// Every fixture is an unedited live capture of the API (2026-10-29):
//   trending.json / editors-choice.json / recently-updated.json
//                         GET /api/novels/<row>?limit=24
//   search-page1.json / search-page2.json
//                         GET /api/novels?search=shadow%20slave&fuzzy=1&page=N&per_page=24
//   search-past-end.json  the same with page=99 (the API clamps it to page 4)
//   search-no-results.json  search=zzqqxxnotathing
//   novel.json            GET /api/novels/69faa859a5f4c7d1b734d496 (Shadow Slave, 3,227 chapters)
//   novel-lotm.json       GET /api/novels/69faadd3a5f4c7d1b734d49f (Lord of the Mysteries)
//   novel-not-found.json  the 404 body for an unknown id
//   chapter*.json         GET /api/novels/<id>/chapters/<n>?prefetch=1 — see each test
// Expectations are derived from the parsed fixture wherever possible rather
// than from numbers seen on capture day.

const SHADOW_SLAVE_ID = "69faa859a5f4c7d1b734d496";
const LOTM_ID = "69faadd3a5f4c7d1b734d49f";
const NOVEL_URL = `${BASE_URL}/novel?id=${SHADOW_SLAVE_ID}`;

type Logs = NonNullable<TestHostOptions["logs"]>;

/** Every request answers `body` with `status` — an error page, a 404 body. */
const answering = (status: number, body: string, opts: TestHostOptions = {}) =>
  createTestHost({ responses: { [BASE_URL]: body }, status: { [BASE_URL]: status }, ...opts });

/** `host` whose fetch first answers `first`, then serves its fixtures. */
function failingOnce(host: SourceHost, first: () => FetchResponse): SourceHost & { requests: () => number } {
  let n = 0;
  return {
    ...host,
    requests: () => n,
    fetch: async (url, opts) => (++n === 1 ? first() : host.fetch(url, opts)),
  };
}

const homeHost = (locale: "en" | "ar" = "en", calls: Array<{ url: string; method: string }> = []) =>
  createTestHost({
    responses: {
      "/api/novels/trending?limit=24": fixture("trending.json"),
      "/api/novels/editors-choice?limit=24": fixture("editors-choice.json"),
      "/api/novels/recently-updated?limit=24": fixture("recently-updated.json"),
    },
    locale,
    calls,
  });

/** The paragraphs of a chapter body, split independently of src/: every
 *  non-empty line, whitespace collapsed. */
const rawLines = (content: string) =>
  content
    .split(/\r?\n|\r/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

const chapterBody = (name: string): string => json(name).chapter.content;

afterEach(() => {
  vi.useRealTimers();
});

/** Settles `run()` under fake timers, so the shared fetcher's retry
 *  backoffs and 429 pauses take no real time. */
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

describe("manifest + icon", () => {
  it("ships a 128×128 PNG icon", () => {
    const png = readFileSync(join(FIXTURES_DIR, "..", "..", "icon.png"));
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    // IHDR: width and height are the first two big-endian uint32s of its data.
    expect(png.readUInt32BE(16)).toBe(128);
    expect(png.readUInt32BE(20)).toBe(128);
  });

  it("points baseUrl at the site the source talks to", () => {
    const manifest = JSON.parse(readFileSync(join(FIXTURES_DIR, "..", "..", "manifest.json"), "utf8"));
    expect(manifest.baseUrl).toBe(BASE_URL);
    expect(manifest.language).toBe("en");
  });
});

describe("strings", () => {
  it("has the same non-empty keys in en and ar", () => {
    const en = strings("en");
    const ar = strings("ar");
    for (const key of [
      "homeTrending",
      "homeEditorsChoice",
      "homeLatestUpdates",
      "allChapters",
      "chapterFallback",
      "metaChapters",
      "metaViews",
      "metaRating",
      "ratingValue",
      "metaLatestRelease",
      "metaUpdated",
      "metaAltNames",
    ] as const) {
      expect(en(key)).not.toBe("");
      expect(ar(key)).not.toBe("");
    }
    expect(en("chapterFallback", { n: 7 })).toBe("Chapter 7");
    expect(ar("chapterFallback", { n: 7 })).toBe("الفصل 7");
  });
});

describe("canHandle", () => {
  const source = createSource(createTestHost());

  it("accepts novel and reader pages on novelarchive.st and its .cc mirror", () => {
    expect(source.canHandle(NOVEL_URL)).toBe(true);
    expect(source.canHandle(`https://novelarchive.st/reader?novel=${SHADOW_SLAVE_ID}&chapter=3`)).toBe(true);
    expect(source.canHandle("https://www.novelarchive.st/library")).toBe(true);
    expect(source.canHandle(`https://novelarchive.cc/novel?id=${SHADOW_SLAVE_ID}`)).toBe(true);
    expect(source.canHandle("https://www.novelarchive.cc/")).toBe(true);
  });

  it("rejects other sites, look-alike hostnames and non-URLs", () => {
    expect(source.canHandle("https://seanovel.org/novels/shadow-slave")).toBe(false);
    expect(source.canHandle("https://notnovelarchive.st/novel?id=x")).toBe(false);
    expect(source.canHandle("https://novelarchive.st.evil.com/novel?id=x")).toBe(false);
    expect(source.canHandle("not a url")).toBe(false);
    expect(source.canHandle("")).toBe(false);
  });
});

describe("URL helpers", () => {
  it("reads the novel id from a novel page or a reader URL", () => {
    expect(novelIdFromUrl(NOVEL_URL)).toBe(SHADOW_SLAVE_ID);
    expect(novelIdFromUrl(`https://novelarchive.cc/reader?novel=${LOTM_ID}&chapter=9`)).toBe(LOTM_ID);
  });

  it("rejects URLs without a valid novel id, prefixed with the manifest id", () => {
    for (const bad of [
      `${BASE_URL}/library`,
      `${BASE_URL}/novel?id=shadow-slave`,
      `https://example.com/novel?id=${SHADOW_SLAVE_ID}`,
    ]) {
      expect(() => novelIdFromUrl(bad)).toThrow(SourceUrlError);
      expect(() => novelIdFromUrl(bad)).toThrow(PREFIX);
    }
  });

  it("reads the novel id and chapter number from a reader URL", () => {
    expect(chapterRefFromUrl(`${BASE_URL}/reader?novel=${LOTM_ID}&chapter=1434`)).toEqual({
      novelId: LOTM_ID,
      number: 1434,
    });
    for (const bad of [
      NOVEL_URL,
      `${BASE_URL}/reader?novel=${LOTM_ID}&chapter=0`,
      `${BASE_URL}/reader?novel=${LOTM_ID}&chapter=2.5`,
    ]) {
      expect(() => chapterRefFromUrl(bad)).toThrow(SourceUrlError);
      expect(() => chapterRefFromUrl(bad)).toThrow(PREFIX);
    }
  });
});

describe("cards and fields", () => {
  it("builds a card from an API row", () => {
    const row = json("trending.json").novels[0] as NovelRow;
    const card = cardFor(row);
    expect(card.url).toBe(`${BASE_URL}/novel?id=${row.id}`);
    expect(card.title).toBe(row.title);
    expect(card.subtitle).toBe(row.author);
    expect(card.coverUrl).toBe(`${BASE_URL}${row.cover_url}`);
    expect(card.badges).toEqual(genresOf(row.genres).slice(0, 3));
  });

  it("never shows a literal Unknown author", () => {
    const rows = (json("editors-choice.json").novels as NovelRow[]).filter(
      (r) => String(r.author).toLowerCase() === "unknown",
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(cardFor(row).subtitle).toBeUndefined();
  });

  it("splits genres, dropping duplicates, site categories and blanks", () => {
    expect(genresOf("Action, Fantasy, Mystery")).toEqual(["Action", "Fantasy", "Mystery"]);
    expect(genresOf("Action,action, ,Browse,Completed Novels,Unknown,Drama")).toEqual(["Action", "Drama"]);
    expect(genresOf(undefined)).toEqual([]);
  });

  it("makes cover URLs absolute, keeping absolute ones and falling back to the cover endpoint", () => {
    const id = SHADOW_SLAVE_ID;
    expect(coverUrlFor({ id, cover_url: "/api/novels/x/cover?w=640" })).toBe(`${BASE_URL}/api/novels/x/cover?w=640`);
    expect(coverUrlFor({ id, cover_url: "https://cdn.example/c.jpg" })).toBe("https://cdn.example/c.jpg");
    expect(coverUrlFor({ id, cover_url: "", image_url: "//cdn.example/c.jpg" })).toBe("https://cdn.example/c.jpg");
    expect(coverUrlFor({ id, cover_url: "iVBORw0KGgo=" })).toBe(`${BASE_URL}/api/novels/${id}/cover`);
  });

  it("numbers chapters by position and falls back to total_chapters placeholders", () => {
    const fallback = (n: number) => `Chapter ${n}`;
    const chapters = chaptersFor({ id: LOTM_ID, chapter_names: [], total_chapters: "3" }, fallback);
    expect(chapters.map((c) => [c.id, c.title, c.url])).toEqual([
      [1, "Chapter 1", `${BASE_URL}/reader?novel=${LOTM_ID}&chapter=1`],
      [2, "Chapter 2", `${BASE_URL}/reader?novel=${LOTM_ID}&chapter=2`],
      [3, "Chapter 3", `${BASE_URL}/reader?novel=${LOTM_ID}&chapter=3`],
    ]);
    expect(chaptersFor({ id: LOTM_ID, chapter_names: ["Prologue", "  "] }, fallback).map((c) => c.title)).toEqual([
      "Prologue",
      "Chapter 2",
    ]);
  });
});

describe("getHomeSections", () => {
  it("returns the site's three rows in order, from the three home endpoints", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const sections = await createSource(homeHost("en", calls)).getHomeSections();
    expect(sections.map((s) => [s.id, s.title])).toEqual([
      ["trending", "Trending"],
      ["editors-choice", "Editor's Choice"],
      ["latest-updates", "Latest Updates"],
    ]);
    expect(calls.map((c) => c.url).sort()).toEqual(
      [
        `${BASE_URL}/api/novels/editors-choice?limit=${PAGE_SIZE}`,
        `${BASE_URL}/api/novels/recently-updated?limit=${PAGE_SIZE}`,
        `${BASE_URL}/api/novels/trending?limit=${PAGE_SIZE}`,
      ],
    );
  });

  it("turns every row of each endpoint into a card, in order", async () => {
    const sections = await createSource(homeHost()).getHomeSections();
    const files = ["trending.json", "editors-choice.json", "recently-updated.json"];
    sections.forEach((section, i) => {
      const rows = json(files[i]).novels as NovelRow[];
      expect(section.cards).toEqual(rows.slice(0, PAGE_SIZE).map(cardFor));
      expect(section.cards.length).toBeGreaterThan(0);
    });
  });

  it("titles the rows in Arabic for an Arabic UI", async () => {
    const sections = await createSource(homeHost("ar")).getHomeSections();
    const t = strings("ar");
    expect(sections.map((s) => s.title)).toEqual([t("homeTrending"), t("homeEditorsChoice"), t("homeLatestUpdates")]);
  });

  it("keeps the rows that loaded when one endpoint fails", async () => {
    const logs: Logs = [];
    const host = createTestHost({
      responses: {
        "/novels/trending": fixture("trending.json"),
        "/novels/editors-choice": "<html>Internal Server Error</html>",
        "/novels/recently-updated": fixture("recently-updated.json"),
      },
      status: { "/novels/editors-choice": 500 },
      logs,
    });
    const sections = await settled(() => createSource(host).getHomeSections());
    expect(sections.map((s) => s.id)).toEqual(["trending", "latest-updates"]);
    expect(logs.some((l) => l.level === "warn" && l.message.includes("editors-choice"))).toBe(true);
  });

  it("throws, prefixed with the manifest id, when every row fails", async () => {
    const source = createSource(answering(503, "Service Unavailable"));
    await expect(settled(() => source.getHomeSections())).rejects.toThrow(PREFIX);
  });
});

describe("search", () => {
  const searchHost = (calls: Array<{ url: string; method: string }> = []) =>
    createTestHost({
      responses: {
        "search=shadow%20slave&fuzzy=1&page=1&": fixture("search-page1.json"),
        "search=shadow%20slave&fuzzy=1&page=2&": fixture("search-page2.json"),
        "search=shadow%20slave&fuzzy=1&page=99&": fixture("search-past-end.json"),
        "search=zzqqxxnotathing": fixture("search-no-results.json"),
      },
      calls,
    });

  it("returns a hollow result for an empty query without calling the site", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const result = await createSource(searchHost(calls)).search("   ", 3);
    expect(result).toEqual({ cards: [], hasMore: false, query: "", page: 3 });
    expect(calls).toEqual([]);
  });

  it("asks the API exactly what the site's library search asks", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    await createSource(searchHost(calls)).search(" shadow slave ");
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE_URL}/api/novels?search=shadow%20slave&fuzzy=1&page=1&per_page=${PAGE_SIZE}`,
    ]);
  });

  it("maps page 1 to cards, exact title match first, with hasMore from the pagination", async () => {
    const page1 = json("search-page1.json");
    const result = await createSource(searchHost()).search("shadow slave", 1);
    expect(result.query).toBe("shadow slave");
    expect(result.page).toBe(1);
    expect(result.cards).toEqual((page1.novels as NovelRow[]).map(cardFor));
    expect(result.cards[0].title).toBe("Shadow Slave");
    expect(result.hasMore).toBe(page1.pagination.has_next);
    expect(result.hasMore).toBe(true);
  });

  it("returns a different set of novels on page 2", async () => {
    const source = createSource(searchHost());
    const one = await source.search("shadow slave", 1);
    const two = await source.search("shadow slave", 2);
    expect(two.page).toBe(2);
    expect(two.cards).toEqual((json("search-page2.json").novels as NovelRow[]).map(cardFor));
    const firstUrls = new Set(one.cards.map((c) => c.url));
    expect(two.cards.some((c) => firstUrls.has(c.url))).toBe(false);
  });

  it("drops a novel the API repeats on the next page of the same query", async () => {
    // search-overlap-page{1,2}.json: "shadow", pages 1 and 2. The API sizes
    // each page's match set on its own (the two report different totals),
    // and one novel comes back on both pages.
    const page1 = json("search-overlap-page1.json");
    const page2 = json("search-overlap-page2.json");
    expect(page1.pagination.total).not.toBe(page2.pagination.total);
    const firstIds = new Set(page1.novels.map((n: NovelRow) => n.id));
    const repeated = (page2.novels as NovelRow[]).filter((n) => firstIds.has(n.id));
    expect(repeated.length).toBeGreaterThan(0);

    const source = createSource(
      createTestHost({
        responses: {
          "search=shadow&fuzzy=1&page=1&": fixture("search-overlap-page1.json"),
          "search=shadow&fuzzy=1&page=2&": fixture("search-overlap-page2.json"),
        },
      }),
    );
    const one = await source.search("shadow", 1);
    const two = await source.search("shadow", 2);
    expect(one.cards).toEqual((page1.novels as NovelRow[]).map(cardFor));
    expect(two.cards).toEqual((page2.novels as NovelRow[]).filter((n) => !firstIds.has(n.id)).map(cardFor));
    expect(two.hasMore).toBe(page2.pagination.has_next);

    // Searching again starts over: page 1 comes back whole.
    expect((await source.search("shadow", 1)).cards).toEqual(one.cards);
    // Without an earlier page there is nothing to drop.
    const alone = await createSource(
      createTestHost({ responses: { "search=shadow&fuzzy=1&page=2&": fixture("search-overlap-page2.json") } }),
    ).search("shadow", 2);
    expect(alone.cards).toHaveLength(page2.novels.length);
  });

  it("treats a page the API clamped (past the end) as the end, not a repeat", async () => {
    const pastEnd = json("search-past-end.json");
    expect(pastEnd.pagination.page).not.toBe(99); // the API clamped it
    expect(pastEnd.novels.length).toBeGreaterThan(0); // ...and served its last page again
    const result = await createSource(searchHost()).search("shadow slave", 99);
    expect(result).toEqual({ cards: [], hasMore: false, query: "shadow slave", page: 99 });
  });

  it("returns no cards and no next page when nothing matches", async () => {
    const result = await createSource(searchHost()).search("zzqqxxnotathing");
    expect(result).toEqual({ cards: [], hasMore: false, query: "zzqqxxnotathing", page: 1 });
  });

  it("reads a nonsensical page argument as page 1", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const result = await createSource(searchHost(calls)).search("shadow slave", 0);
    expect(result.page).toBe(1);
    expect(calls[0].url).toContain("&page=1&");
  });

  it("throws, prefixed with the manifest id, on a non-JSON or list-less response", async () => {
    const html = answering(200, "<!DOCTYPE html><title>Just a moment...</title>");
    await expect(createSource(html).search("x")).rejects.toThrow(`${PREFIX}/api/novels?search=x`);
    const shapeless = answering(200, JSON.stringify({ results: [] }));
    await expect(createSource(shapeless).search("x")).rejects.toThrow(`${PREFIX}/api/novels`);
  });
});

describe("getNovel", () => {
  const novelHost = (locale: "en" | "ar" = "en", calls: Array<{ url: string; method: string }> = []) =>
    createTestHost({
      responses: {
        [`${BASE_URL}/api/novels/${SHADOW_SLAVE_ID}`]: fixture("novel.json"),
        [`${BASE_URL}/api/novels/${LOTM_ID}`]: fixture("novel-lotm.json"),
      },
      locale,
      calls,
    });

  it("maps the novel's metadata", async () => {
    const row = json("novel.json").novel;
    const calls: Array<{ url: string; method: string }> = [];
    const novel = await createSource(novelHost("en", calls)).getNovel(NOVEL_URL);
    expect(calls.map((c) => c.url)).toEqual([`${BASE_URL}/api/novels/${SHADOW_SLAVE_ID}`]);
    expect(novel.title).toBe("Shadow Slave");
    expect(novel.author).toBe(row.author);
    expect(novel.language).toBe("en");
    expect(novel.direction).toBe("ltr");
    expect(novel.coverUrl).toBe(`${BASE_URL}${row.cover_url}`);
    expect(novel.description).toBe(row.description.trim());
    expect(novel.tags).toEqual(row.genres.split(",").map((g: string) => g.trim()));
    expect(novel.status).toBe("Ongoing");
  });

  it("lifts the useful extra fields into meta rows", async () => {
    const row = json("novel-lotm.json").novel;
    const novel = await createSource(novelHost()).getNovel(`${BASE_URL}/novel?id=${LOTM_ID}`);
    const meta = Object.fromEntries(novel.meta.map((m) => [m.label, m.value]));
    expect(meta["Also known as"]).toBe(row.associated_names.join(" · "));
    expect(meta["Chapters"]).toBe(String(row.chapter_names.length));
    expect(meta["Views"]).toBe(row.views_number.toLocaleString("en-US"));
    expect(meta["Rating"]).toBe(`${row.rating.toFixed(1)} / 5 (${row.rating_count} ratings)`);
    expect(meta["Latest release"]).toBe(row.latest_release);
    expect(meta["Updated"]).toBe(row.updated_at.slice(0, 10));
    expect(novel.status).toBe("Completed");
  });

  it("leaves out a release field the site only knows as Unknown", async () => {
    expect(json("novel.json").novel.latest_release).toBe("Unknown");
    const novel = await createSource(novelHost()).getNovel(NOVEL_URL);
    expect(novel.meta.map((m) => m.label)).not.toContain("Latest release");
  });

  it("lists every chapter in one fully-populated volume, numbered like the site", async () => {
    const names: string[] = json("novel.json").novel.chapter_names;
    const source = createSource(novelHost());
    expect(source.hasLazyVolumes).toBeUndefined();
    const novel = await source.getNovel(NOVEL_URL);
    expect(novel.volumes).toHaveLength(1);
    expect(novel.volumes[0].title).toBe("All Chapters");
    const chapters = novel.volumes[0].chapters;
    expect(chapters).toHaveLength(names.length);
    expect(chapters[0]).toEqual({
      id: 1,
      title: names[0],
      url: `${BASE_URL}/reader?novel=${SHADOW_SLAVE_ID}&chapter=1`,
      lines: [],
    });
    expect(chapters.at(-1)).toEqual({
      id: names.length,
      title: names.at(-1),
      url: `${BASE_URL}/reader?novel=${SHADOW_SLAVE_ID}&chapter=${names.length}`,
      lines: [],
    });
  });

  it("titles the volume and meta rows in Arabic for an Arabic UI", async () => {
    const t = strings("ar");
    const novel = await createSource(novelHost("ar")).getNovel(`${BASE_URL}/novel?id=${LOTM_ID}`);
    expect(novel.volumes[0].title).toBe(t("allChapters"));
    expect(novel.meta.map((m) => m.label)).toContain(t("metaChapters"));
  });

  it("accepts a reader or mirror URL for the same novel", async () => {
    const novel = await createSource(novelHost()).getNovel(
      `https://novelarchive.cc/reader?novel=${SHADOW_SLAVE_ID}&chapter=12`,
    );
    expect(novel.title).toBe("Shadow Slave");
  });

  it("throws the site's own reason on a 404, prefixed with the manifest id", async () => {
    const host = answering(404, fixture("novel-not-found.json"));
    await expect(
      createSource(host).getNovel(`${BASE_URL}/novel?id=000000000000000000000000`),
    ).rejects.toThrow(`${PREFIX}/api/novels/000000000000000000000000 answered HTTP 404: Novel not found.`);
  });

  it("throws on a response that is JSON but not a novel", async () => {
    const host = answering(200, "{}");
    await expect(createSource(host).getNovel(NOVEL_URL)).rejects.toThrow(`${PREFIX}/api/novels/${SHADOW_SLAVE_ID} did not return a novel.`);
  });

  it("rejects a URL that is not a novel URL before fetching", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const host = answering(200, "{}", { calls });
    await expect(createSource(host).getNovel(`${BASE_URL}/library`)).rejects.toThrow(SourceUrlError);
    expect(calls).toEqual([]);
  });
});

describe("searchChapters", () => {
  it("filters the chapter list the way the site's own chapter filter does, reusing getNovel's fetch", async () => {
    const names: string[] = json("novel.json").novel.chapter_names;
    const calls: Array<{ url: string; method: string }> = [];
    const source = createSource(
      createTestHost({ responses: { [`/api/novels/${SHADOW_SLAVE_ID}`]: fixture("novel.json") }, calls }),
    );
    await source.getNovel(NOVEL_URL);
    const results = await source.searchChapters!(NOVEL_URL, "  Nightmare ");
    expect(calls).toHaveLength(1);
    const expected = names
      .map((name, i) => ({ n: i + 1, name }))
      .filter(({ n, name }) => String(n).includes("nightmare") || name.toLowerCase().includes("nightmare"));
    expect(expected.length).toBeGreaterThan(0);
    expect(results.map((c) => [c.id, c.title])).toEqual(expected.map(({ n, name }) => [n, name]));
  });

  it("matches chapter numbers too, and fetches the novel itself when needed", async () => {
    const source = createSource(
      createTestHost({ responses: { [`/api/novels/${SHADOW_SLAVE_ID}`]: fixture("novel.json") } }),
    );
    const results = await source.searchChapters!(NOVEL_URL, "3227");
    expect(results.map((c) => c.id)).toContain(3227);
  });

  it("returns nothing for an empty query without calling the site", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const results = await createSource(createTestHost({ calls })).searchChapters!(NOVEL_URL, " ");
    expect(results).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("getChapterContent", () => {
  const chapterAt = (id: string, n: number) => ({
    id: n,
    title: `Chapter ${n}`,
    url: `${BASE_URL}/reader?novel=${id}&chapter=${n}`,
    lines: [],
  });

  const contentOf = async (fixtureName: string, id = SHADOW_SLAVE_ID, n = 1) => {
    const host = createTestHost({ responses: { [`/api/novels/${id}/chapters/${n}?prefetch=1`]: fixture(fixtureName) } });
    return (await createSource(host).getChapterContent(chapterAt(id, n))).map((l) => l.content);
  };

  it("reads the chapter through the reader's prefetch form and returns its paragraphs", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const host = createTestHost({ responses: { "/chapters/1?prefetch=1": fixture("chapter.json") }, calls });
    const lines = await createSource(host).getChapterContent(chapterAt(SHADOW_SLAVE_ID, 1));
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE_URL}/api/novels/${SHADOW_SLAVE_ID}/chapters/1?prefetch=1`,
    ]);
    // A clean chapter comes through paragraph for paragraph.
    expect(lines).toEqual(rawLines(chapterBody("chapter.json")).map((content) => ({ type: "text", content })));
    expect(lines.length).toBeGreaterThan(20);
  });

  it("splits single-newline paragraphs and drops the repeated 'Chapter N' heading", async () => {
    const raw = rawLines(chapterBody("chapter-heading.json"));
    expect(raw[0]).toMatch(/^Chapter 1\b/);
    const lines = await contentOf("chapter-heading.json");
    expect(lines).toEqual(raw.slice(1));
  });

  it("drops code fences and a disguised freewebnovel watermark line", async () => {
    const raw = rawLines(chapterBody("chapter-watermark.json"));
    const junk = ["```html", "Follow curr𝒆nt nov𝒆ls on fɾeeweɓnѳveɭ.com.", "```"];
    for (const line of junk) expect(raw).toContain(line);
    const lines = await contentOf("chapter-watermark.json");
    expect(lines).toEqual(raw.filter((l) => !junk.includes(l)));
  });

  it("drops the heading and the Translator / Editor credit block", async () => {
    const raw = rawLines(chapterBody("chapter-credits.json"));
    expect(raw.slice(0, 5)).toEqual([
      "Chapter 1: The Genetic Exam",
      "Translator:",
      "Nyoi-Bo Studio",
      "Editor:",
      "Nyoi-Bo Studio",
    ]);
    expect(await contentOf("chapter-credits.json")).toEqual(raw.slice(5));
  });

  it("cuts Novelight insertions out of story lines", async () => {
    const lines = await contentOf("chapter-novelight.json");
    const raw = rawLines(chapterBody("chapter-novelight.json"));
    const dirty = raw.find((l) => l.includes("Exclusive on"));
    expect(dirty).toBe(
      "\"...I ❖ Nоvеl𝚒ght ❖ (Exclusive on Nоvеl𝚒ght) informed the General at the banquet. Told him that you had a purpose,",
    );
    expect(lines).toContain("\"...I informed the General at the banquet. Told him that you had a purpose,");
    expect(lines.some((l) => /n\s?o\s?v\s?e\s?l\s?i\s?g\s?h\s?t/.test(fold(l).text))).toBe(false);
    expect(lines).toHaveLength(raw.length);
  });

  it("strips a small-caps 'please visit Nove1Fire.net' tail but keeps the system message", async () => {
    const lines = await contentOf("chapter-smallcaps.json");
    expect(lines).toContain(
      "|Additional Boon: Your Way of Mana has been confirmed to completely supersede all Light-based concepts.|",
    );
    expect(lines.some((l) => /nove1fire/.test(fold(l).text))).toBe(false);
  });

  it("removes a domain glued to the front of a story line", async () => {
    const raw = rawLines(chapterBody("chapter-inline-domain.json"));
    const dirty = raw.filter((l) => l.startsWith("auzw.com"));
    expect(dirty.length).toBeGreaterThan(0);
    const lines = await contentOf("chapter-inline-domain.json");
    for (const line of dirty) expect(lines).toContain(line.replace(/^auzw\.com\s*/, ""));
    expect(lines.some((l) => l.includes("auzw"))).toBe(false);
  });

  it("drops aggregator promo lines", async () => {
    const raw = rawLines(chapterBody("chapter-promo.json"));
    expect(raw[0]).toBe("Remember [www.wuxiaspot.com] for one second, update fast, no pop-up window, free to read!");
    expect(raw.filter((l) => l.includes("wuxiaspot"))).toHaveLength(1);
    expect(await contentOf("chapter-promo.json")).toEqual(raw.slice(1));
  });

  it("removes a bracketed watermark URL from inside a sentence", async () => {
    const lines = await contentOf("chapter-bracketed-url.json");
    expect(rawLines(chapterBody("chapter-bracketed-url.json"))).toContain(
      "The [Liancheng www.wsx5.cn] branch of the True Demon Gate Dragon City.",
    );
    expect(lines).toContain("The branch of the True Demon Gate Dragon City.");
  });

  it("repairs UTF-8 read as Latin-1 (em-space indents) and then drops the revealed heading", async () => {
    const body = chapterBody("chapter-mojibake.json");
    expect(body).toMatch(/â\u0080\u0083/);
    const lines = await contentOf("chapter-mojibake.json");
    expect(lines.some((l) => /[\u0080-\u009f]|â/.test(l))).toBe(false);
    expect(lines[0]).not.toMatch(/^Chapter 3028/);
    expect(lines).toContain("Three days later, it was the day when Murong Lingran got married.");
  });

  it("drops the Zhangyue publisher notice block", async () => {
    const raw = rawLines(chapterBody("chapter-publisher-notice.json"));
    expect(raw.slice(1, 5)).toEqual([
      "This book is produced and distributed electronically by Zhangyue Technology authorized by Hongshu.com (Dejian)",
      "all rights reserved",
      "·",
      "Infringement will be investigated",
    ]);
    const lines = await contentOf("chapter-publisher-notice.json");
    expect(lines).toEqual([raw[0], ...raw.slice(5)]);
  });

  it("keeps a translator's afterword that merely names a site", async () => {
    const raw = rawLines(chapterBody("chapter-afterword.json"));
    const mention = raw.find((l) => l.includes("on NovelFire."));
    expect(mention).toBeDefined();
    const lines = await contentOf("chapter-afterword.json");
    expect(lines).toContain(mention);
  });

  it("throws the site's reason for a chapter the list names but the archive lacks", async () => {
    const host = answering(404, fixture("chapter-not-found.json"));
    await expect(createSource(host).getChapterContent(chapterAt(LOTM_ID, 1435))).rejects.toThrow(
      `${PREFIX}/api/novels/${LOTM_ID}/chapters/1435?prefetch=1 answered HTTP 404: Chapter does not exist.`,
    );
  });

  it("throws on an empty chapter body or a response without one", async () => {
    const empty = answering(200, JSON.stringify({ chapter: { number: 1, name: "x", content: " \n\n " } }));
    await expect(createSource(empty).getChapterContent(chapterAt(SHADOW_SLAVE_ID, 1))).rejects.toThrow(
      `${PREFIX}chapter 1 of novel ${SHADOW_SLAVE_ID} has no text.`,
    );
    const shapeless = answering(200, JSON.stringify({ error: null }));
    await expect(createSource(shapeless).getChapterContent(chapterAt(SHADOW_SLAVE_ID, 1))).rejects.toThrow(
      `${PREFIX}/api/novels/${SHADOW_SLAVE_ID}/chapters/1?prefetch=1 did not return a chapter.`,
    );
  });

  it("rejects a chapter whose URL is not a reader URL", async () => {
    const source = createSource(createTestHost());
    await expect(source.getChapterContent({ ...chapterAt(SHADOW_SLAVE_ID, 1), url: NOVEL_URL })).rejects.toThrow(
      SourceUrlError,
    );
  });
});

describe("network resilience", () => {
  // The retry policy itself is the shared fetcher's (packages/extension-api
  // fetch.test.ts); these pin how this source configures and reports it.
  it("waits out a 429 for the advertised reset, then retries", async () => {
    vi.useFakeTimers();
    const logs: Logs = [];
    const host = failingOnce(createTestHost({ responses: { "/chapters/1": fixture("chapter.json") }, logs }), () => ({
      status: 429,
      text: '{"error":"Too many requests"}',
      headers: { "ratelimit-reset": "7" },
    }));
    const pending = createSource(host).getChapterContent({
      id: 1,
      title: "",
      url: `${BASE_URL}/reader?novel=${SHADOW_SLAVE_ID}&chapter=1`,
      lines: [],
    });
    await vi.advanceTimersByTimeAsync(6_999);
    expect(host.requests()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.not.toHaveLength(0);
    expect(host.requests()).toBe(2);
    expect(logs.some((l) => l.level === "warn" && l.message.startsWith(PREFIX) && l.message.includes("7s"))).toBe(true);
  });

  it("gives up after 4 requests and reports the 429 with the API's reason", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const host = createTestHost({
      responses: { [BASE_URL]: '{"error":"Too many requests"}' },
      status: { [BASE_URL]: 429 },
      headers: { [BASE_URL]: { "retry-after": "1" } },
      calls,
    });
    await expect(settled(() => createSource(host).search("x"))).rejects.toThrow(
      `${PREFIX}/api/novels?search=x&fuzzy=1&page=1&per_page=24 answered HTTP 429: Too many requests.`,
    );
    expect(calls).toHaveLength(4);
  });

  it("retries a request that failed outright (connection reset)", async () => {
    const host = failingOnce(createTestHost({ responses: { [BASE_URL]: fixture("search-no-results.json") } }), () => {
      throw new Error("Recv failure: Connection reset by peer");
    });
    await expect(settled(() => createSource(host).search("zzqqxxnotathing"))).resolves.toMatchObject({
      cards: [],
      hasMore: false,
    });
    expect(host.requests()).toBe(2);
  });

  it("reports a request that keeps failing, prefixed with the manifest id", async () => {
    let n = 0;
    const host: SourceHost = {
      ...createTestHost(),
      fetch: async () => {
        n++;
        throw new Error("Connection reset by peer");
      },
    };
    await expect(settled(() => createSource(host).search("x"))).rejects.toThrow(
      /^novelarchive: .* could not be fetched: Connection reset by peer$/,
    );
    expect(n).toBe(4);
  });
});

describe("clean.ts units", () => {
  it("repairs only Latin-1-read UTF-8 that contains a C1 control", () => {
    expect(repairMojibake("aâ\u0080\u0083b")).toBe("a b");
    expect(repairMojibake("â\u0080» Note")).toBe("※ Note");
    // "Ã©" could be genuine text — no C1 control, so it is left alone.
    expect(repairMojibake("CAFÃ©")).toBe("CAFÃ©");
    expect(repairMojibake("plain text — “quoted”")).toBe("plain text — “quoted”");
  });

  it("folds look-alike letters to ASCII one character at a time", () => {
    const folded = fold("fɾeeweɓnѳveɭ.𝐜𝐨𝐦");
    expect(folded.text).toBe("freewebnovel.com");
    expect(folded.starts).toHaveLength(folded.text.length);
    expect(fold("ᴘʟᴇᴀsᴇ ᴠɪsɪᴛ").text).toBe("please visit");
  });

  it("leaves story text alone", () => {
    for (const line of [
      "That's it. The Second Coming of Gluttony is officially over after about a year on NovelFire. This marks the third.",
      "https://en.m.wikipedia.org/wiki/Dano_(festival)",
      "He opened the novel bin and read on.",
      "“Tie Zhu, you have great talent! When you are successful in the future, don’t forget to come back and visit.”",
      "|Status: Bound| ~ Level 4 ~",
    ]) {
      expect(stripWatermarks(line)).toBe(line);
    }
  });

  it("keeps a speaker line that only looks like a credit", () => {
    expect(cleanLines(["Ed: [Hey, wait!]", "Story."])).toEqual(["Ed: [Hey, wait!]", "Story."]);
    expect(cleanLines(["TL: Hanguk", "Story."])).toEqual(["Story."]);
  });

  it("only looks for credits at the top of a chapter", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `Line ${i}`);
    expect(cleanLines([...lines, "Editor: Someone"])).toEqual([...lines, "Editor: Someone"]);
  });

  it("strips the watermark variants seen on the live site", () => {
    expect(stripWatermarks("The killing intent emanating °• N 𝑜 v 𝑒 l i g h t •° from them was intense.")).toBe(
      "The killing intent emanating from them was intense.",
    );
    expect(stripWatermarks("When Koi got ➤ NоvеⅠight ➤ (Read more on our source) home, he showered.")).toBe(
      "When Koi got home, he showered.",
    );
    expect(stripWatermarks("their ◈ Nоvеlіgһт ◈ (Continue reading) children.")).toBe("their children.");
    expect(stripWatermarks("Ryo ~Nоvеl𝕚ght~ showed the ‘Holy Seal’.")).toBe("Ryo showed the ‘Holy Seal’.");
    expect(stripWatermarks("This chapter is updat𝙚d by f(r)eew𝒆bn(o)vel.com")).toBe("");
    expect(stripWatermarks("New novel 𝓬hapters are published on freёwebnoѵel.com.")).toBe("");
    expect(stripWatermarks("Read lat𝙚st chapters at fɾeewebnoveℓ.co๓ Only.")).toBe("");
    expect(stripWatermarks("𝚏𝕣𝕖𝚎𝚠𝚎𝚋𝚗𝐨𝐯𝕖𝕝.𝕔𝐨𝕞")).toBe("");
    expect(stripWatermarks("# Nоvеlight #")).toBe("");
    expect(stripWatermarks('"Black belt?" 𝐛𝐞𝗱𝗻𝐨𝐯𝗲𝗹.𝐜𝐨𝐦')).toBe('"Black belt?"');
    expect(stripWatermarks("Biquge www.novelbuddy.com, update the latest chapter of Master Dan Dao as soon as possible!")).toBe("");
    expect(stripWatermarks("Table of Contents URL: https://1stkissnovel.org/novel/children-of-the-holy-emperor/")).toBe("");
    expect(stripWatermarks("READ MORE CHAPTERS HERE-https://beastnovels.com")).toBe("");
    expect(stripWatermarks("When the room leaks, it's even Fenglian [笔趣阁www.biqugeso.me] Ye Yu, and my girlfriend left.")).toBe(
      "When the room leaks, it's even Fenglian Ye Yu, and my girlfriend left.",
    );
  });

  it("contentToLines keeps a lone heading rather than returning nothing", () => {
    expect(contentToLines("Chapter 5")).toEqual([{ type: "text", content: "Chapter 5" }]);
  });
});
