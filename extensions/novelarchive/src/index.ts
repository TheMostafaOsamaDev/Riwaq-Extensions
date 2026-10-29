// Novel Archive — novelarchive.st (same site, same API on novelarchive.cc).
// A large English archive (270k+ novels) "archiving from multiple sources".
// Its pages are thin shells that fill themselves from a public JSON API
// under /api (see the site's own assets/js/api.js), and every method here
// reads that API directly — no HTML is parsed anywhere:
//
//   home rows          GET /api/novels/trending | editors-choice | recently-updated ?limit=N
//   search             GET /api/novels?search=<q>&fuzzy=1&page=<n>&per_page=24
//   novel + chapters   GET /api/novels/<id>          (every chapter name in one response)
//   chapter text       GET /api/novels/<id>/chapters/<n>?prefetch=1
//
// Novel ids are 24-hex MongoDB ObjectIds. Chapter n is position n in the
// novel's `chapter_names` array (1-based), exactly as the site's own novel
// page numbers them. The URLs this source hands out are the site's own page
// URLs (/novel?id=<id>, /reader?novel=<id>&chapter=<n>), so each one opens
// the same thing in a browser.
//
// The API rate-limits per client: `ratelimit-policy: 900;w=300` (900
// requests per 5 minutes). One chapter is one request, so importing a long
// novel can cross that whenever the site answers quickly; a 429 is waited
// out by the shared fetcher (see `get`) instead of failing every remaining
// chapter.
//
// Chapter text is the archive's plain text, scrubbed of the watermarks and
// leftovers it picked up from the sites it was gathered from (the shared
// rules in @riwaq/extension-api, plus this archive's own in clean.ts).
// See README.md for the endpoints, field mapping and quirks.
import {
  createFetcher,
  isLeadingHeading,
  sanitizeText,
  SourceUrlError,
  type NovelCard,
  type Source,
  type SourceChapter,
  type SourceHost,
  type SourceLine,
  type SourceNovel,
  type SourceNovelMeta,
  type SourceSearchResult,
  type SourceSection,
} from "@riwaq/extension-api";
import { cleanLines, repairMojibake } from "./clean";
import { strings } from "./strings";

export const BASE_URL = "https://novelarchive.st";

/** Every hostname serving this site. novelarchive.cc is listed next to
 *  novelarchive.st on EverythingMoe and serves the same pages and the same
 *  API; the status page also lives under .cc. */
export const HOSTS = new Set([
  "novelarchive.st",
  "www.novelarchive.st",
  "novelarchive.cc",
  "www.novelarchive.cc",
]);

/** Cards per home row and per search page — the site's own library page
 *  size (`PER_PAGE = 24` in assets/js/libary-page.js). */
export const PAGE_SIZE = 24;

const NOVEL_ID_RE = /^[0-9a-f]{24}$/i;

/** The leading "Chapter 12" / "Chapter 2 - 2" line many chapters open with
 *  only repeats the chapter title. The site's reader drops it when it is
 *  shorter than this (trimLeadingHeading in reader-page.js) — plain text has
 *  nothing else to tell a heading from a paragraph by — and so does this. */
const LEADING_HEADING_MAX_LENGTH = 80;

/** Site categories that ride along in `genres` but are not genres. Copied
 *  from NON_GENRE_TAGS in the site's assets/js/novel-page.js, plus
 *  "unknown" (the site's placeholder for a novel with no genres). */
const NON_GENRE_TAGS = new Set([
  "browse",
  "completed novel",
  "completed novels",
  "latest novels",
  "latest novel",
  "anime & comics",
  "anime and comics",
  "unknown",
]);

/** One novel as the API returns it — the same shape in list endpoints
 *  (where `chapter_names` is always `[]`) and in `GET /api/novels/<id>`
 *  (where it carries every chapter name). Fields this source does not read
 *  are omitted. Everything is optional because it is unvalidated JSON. */
export interface NovelRow {
  id: string;
  title?: string;
  author?: string;
  /** Comma-separated: "Action, Fantasy, Mystery". */
  genres?: string;
  description?: string;
  cover_url?: string;
  novel_image?: string;
  image_url?: string;
  associated_names?: string[];
  chapter_names?: string[];
  /** A string in the API ("3227"). */
  total_chapters?: string | number;
  views_number?: number;
  views?: string;
  rating?: number;
  rating_count?: number;
  /** "Every 12.6 Day(s)", "15 hours ago", "Chapter 2352: …" or "Unknown". */
  latest_release?: string;
  /** "ongoing" | "completed" | "hiatus". */
  release_status?: string;
  ongoing?: string;
  updated_at?: string;
  created_at?: string;
}

export const novelUrl = (id: string) => `${BASE_URL}/novel?id=${id}`;
export const chapterUrl = (id: string, n: number) => `${BASE_URL}/reader?novel=${id}&chapter=${n}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value when it is a string, else "" — the API is unvalidated JSON. */
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** Parses `url` and returns it only when it is on one of this site's hosts. */
function ownUrl(url: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return HOSTS.has(parsed.hostname.toLowerCase()) ? parsed : null;
}

/** The novel id out of a novel page (`/novel?id=<id>`) or reader
 *  (`/reader?novel=<id>&chapter=<n>`) URL — the same two parameters the
 *  site's novel page itself reads (`params.get("id") || params.get("novel")`). */
export function novelIdFromUrl(url: string): string {
  const parsed = ownUrl(url);
  const id = parsed?.searchParams.get("id") || parsed?.searchParams.get("novel") || "";
  if (!NOVEL_ID_RE.test(id)) {
    throw new SourceUrlError(`novelarchive: ${url} is not a Novel Archive novel URL.`);
  }
  return id;
}

/** Novel id and chapter number out of a reader URL. */
export function chapterRefFromUrl(url: string): { novelId: string; number: number } {
  const parsed = ownUrl(url);
  const novelId = parsed?.searchParams.get("novel") ?? "";
  const rawNumber = parsed?.searchParams.get("chapter") ?? "";
  const number = /^\d+$/.test(rawNumber) ? Number(rawNumber) : 0;
  if (!NOVEL_ID_RE.test(novelId) || number < 1) {
    throw new SourceUrlError(`novelarchive: ${url} is not a Novel Archive chapter URL.`);
  }
  return { novelId, number };
}

export function genresOf(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const genre = sanitizeText(part);
    const key = genre.toLowerCase();
    if (!genre || NON_GENRE_TAGS.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(genre);
  }
  return out;
}

/** "" when the API has no author — never a literal "Unknown" (see the
 *  `author` doc comment on SourceNovel). */
function authorOf(row: NovelRow): string {
  const author = sanitizeText(str(row.author));
  return author.toLowerCase() === "unknown" ? "" : author;
}

/** Absolute cover URL. The API gives a site-relative
 *  `/api/novels/<id>/cover?w=640&q=72&format=webp` for every novel; an
 *  absolute URL is kept as is, and anything else (the site's renderer also
 *  copes with inline base64) falls back to the plain cover endpoint. */
export function coverUrlFor(row: NovelRow): string {
  const raw = [row.cover_url, row.novel_image, row.image_url]
    .find((v): v is string => typeof v === "string" && v.trim() !== "")
    ?.trim();
  if (raw && /^https?:\/\//i.test(raw)) return raw;
  if (raw?.startsWith("//")) return `https:${raw}`;
  if (raw?.startsWith("/")) return `${BASE_URL}${raw}`;
  return `${BASE_URL}/api/novels/${row.id}/cover`;
}

function statusOf(row: NovelRow): string | undefined {
  const raw = sanitizeText(str(row.release_status) || str(row.ongoing));
  if (!raw || raw.toLowerCase() === "unknown") return undefined;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export function cardFor(row: NovelRow): NovelCard {
  const genres = genresOf(row.genres);
  return {
    url: novelUrl(row.id),
    title: sanitizeText(str(row.title)) || row.id,
    coverUrl: coverUrlFor(row),
    subtitle: authorOf(row) || undefined,
    badges: genres.length > 0 ? genres.slice(0, 3) : undefined,
  };
}

/** Every chapter of a novel, numbered the way the site numbers them:
 *  position n (1-based) in `chapter_names`. With no names at all the site
 *  falls back to `total_chapters` placeholders, and so does this. */
export function chaptersFor(
  row: NovelRow,
  fallbackTitle: (n: number) => string,
): SourceChapter[] {
  const names = Array.isArray(row.chapter_names) ? row.chapter_names : [];
  const total = names.length > 0 ? names.length : Number.parseInt(String(row.total_chapters ?? 0), 10) || 0;
  const chapters: SourceChapter[] = [];
  for (let n = 1; n <= total; n++) {
    const name = names[n - 1];
    chapters.push({
      id: n,
      title: sanitizeText(str(name)) || fallbackTitle(n),
      url: chapterUrl(row.id, n),
      lines: [],
    });
  }
  return chapters;
}

/** Splits the API's plain-text chapter body into paragraph lines. The
 *  archive stores text only, paragraphs separated by blank lines in most
 *  novels and by single newlines in others (the site renders the latter as
 *  <br>), so every non-empty line is a paragraph. Aggregator watermarks,
 *  credits and other leftovers are removed (see clean.ts), and a short
 *  leading "Chapter N…" heading is dropped, as the site's reader drops it. */
export function contentToLines(content: string): SourceLine[] {
  const paragraphs = cleanLines(
    repairMojibake(content)
      .split(/\r?\n|\r/)
      .map((line) => sanitizeText(line))
      .filter((line) => line !== ""),
  );
  if (
    paragraphs.length > 1 &&
    paragraphs[0].length < LEADING_HEADING_MAX_LENGTH &&
    isLeadingHeading(paragraphs[0])
  ) {
    paragraphs.shift();
  }
  return paragraphs.map((text) => ({ type: "text", content: text }));
}

/** The home rows, in the site's own order: the trending carousel at the
 *  top, then Editor's Choice, then Latest Updates (index-home.js loads the
 *  same three endpoints). */
const HOME_ROWS = [
  { id: "trending", endpoint: "/novels/trending", title: "homeTrending" },
  { id: "editors-choice", endpoint: "/novels/editors-choice", title: "homeEditorsChoice" },
  { id: "latest-updates", endpoint: "/novels/recently-updated", title: "homeLatestUpdates" },
] as const;

export default function createSource(host: SourceHost): Source {
  const t = strings(host.locale);

  /** The last novel getNovel/searchChapters fetched, so a chapter search
   *  right after opening a novel does not refetch its (up to ~100 KB)
   *  chapter list. Per instance, never module scope. */
  let lastNovel: NovelRow | null = null;

  /** Card URLs already returned for the current search query (see search). */
  let searchSeen: { query: string; urls: Set<string> } | null = null;

  /** host.fetch with the shared retry policy. A dropped request (a reset
   *  during the TLS handshake shows up on roughly one request in twenty) or
   *  a 5xx is retried with a backoff; a 429 holds every request of this
   *  Source back for the API's `Retry-After` / `RateLimit-Reset` (capped at
   *  its whole 300 s window), so the importer's workers wait together. One
   *  budget of 4 requests covers all of it. */
  const get = createFetcher(host, { id: "novelarchive", attempts: 4 });

  /** GET `${BASE_URL}/api${path}` and parse the JSON body. A non-2xx throws
   *  with the API's own `error` message when it sent one
   *  ({"error":"Chapter does not exist"}). */
  async function getJson(path: string): Promise<unknown> {
    const endpoint = `/api${path}`;
    const resp = await get(`${BASE_URL}${endpoint}`);

    let body: unknown;
    let isJson = true;
    try {
      body = JSON.parse(resp.text);
    } catch {
      isJson = false;
    }
    if (resp.status < 200 || resp.status >= 300) {
      const siteError = isJson && isRecord(body) && typeof body.error === "string" ? `: ${body.error}` : "";
      throw new Error(`novelarchive: ${endpoint} answered HTTP ${resp.status}${siteError}.`);
    }
    if (!isJson) {
      throw new Error(`novelarchive: ${endpoint} did not return JSON (status ${resp.status}).`);
    }
    return body;
  }

  /** The `novels` array of a list response, keeping only rows with a real id. */
  async function getNovelList(path: string): Promise<{ body: Record<string, unknown>; rows: NovelRow[] }> {
    const body = await getJson(path);
    if (!isRecord(body) || !Array.isArray(body.novels)) {
      throw new Error(`novelarchive: /api${path} did not return a novel list.`);
    }
    const rows = body.novels.filter(
      (row): row is NovelRow => isRecord(row) && typeof row.id === "string" && NOVEL_ID_RE.test(row.id),
    );
    return { body, rows };
  }

  async function fetchNovel(id: string): Promise<NovelRow> {
    const body = await getJson(`/novels/${id}`);
    if (!isRecord(body) || !isRecord(body.novel) || typeof body.novel.id !== "string") {
      throw new Error(`novelarchive: /api/novels/${id} did not return a novel.`);
    }
    lastNovel = body.novel as unknown as NovelRow;
    return lastNovel;
  }

  const chapterFallback = (n: number) => t("chapterFallback", { n });

  return {
    canHandle(url: string): boolean {
      return ownUrl(url) !== null;
    },

    async getHomeSections(): Promise<SourceSection[]> {
      host.log("info", "getHomeSections");
      // allSettled, like the site's own home page: one failing row should
      // not take the other two down with it.
      const settled = await Promise.allSettled(
        HOME_ROWS.map((row) => getNovelList(`${row.endpoint}?limit=${PAGE_SIZE}`)),
      );
      const sections: SourceSection[] = [];
      const errors: unknown[] = [];
      settled.forEach((result, i) => {
        const row = HOME_ROWS[i];
        if (result.status === "rejected") {
          errors.push(result.reason);
          const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
          host.log("warn", `novelarchive: home row "${row.id}" failed: ${message}`);
          return;
        }
        if (result.value.rows.length === 0) return;
        sections.push({
          id: row.id,
          title: t(row.title),
          cards: result.value.rows.slice(0, PAGE_SIZE).map(cardFor),
        });
      });
      if (sections.length === 0 && errors.length > 0) throw errors[0];
      return sections;
    },

    async search(query: string, page = 1): Promise<SourceSearchResult> {
      const trimmed = query.trim();
      const pageNo = Number.isInteger(page) && page > 0 ? page : 1;
      if (!trimmed) {
        return { cards: [], hasMore: false, query: trimmed, page: pageNo };
      }
      host.log("info", `search(${trimmed}) page ${pageNo}`);
      // The same request the site's library page makes for a typed search
      // (NA.api.novels.browse with fuzzy on and its 24-per-page size). The
      // server ranks by relevance — an exact title match comes first.
      const { body, rows } = await getNovelList(
        `/novels?search=${encodeURIComponent(trimmed)}&fuzzy=1&page=${pageNo}&per_page=${PAGE_SIZE}`,
      );
      const pagination = isRecord(body.pagination) ? body.pagination : {};
      // A page past the end is not an empty page here: the API clamps it to
      // its last page and serves that again. Returning those cards would
      // repeat the previous page, so a clamped page reads as the end.
      if (typeof pagination.page === "number" && pagination.page !== pageNo) {
        return { cards: [], hasMore: false, query: trimmed, page: pageNo };
      }
      // The API builds each page's match set on its own (page 1 of "shadow"
      // reports 172 matches, page 2 reports 196), so a novel near a page
      // boundary can come back on two pages. Drop what earlier pages of the
      // same query already returned; page 1 starts afresh.
      if (pageNo === 1 || searchSeen?.query !== trimmed) {
        searchSeen = { query: trimmed, urls: new Set() };
      }
      const cards: NovelCard[] = [];
      for (const card of rows.map(cardFor)) {
        if (searchSeen.urls.has(card.url)) continue;
        searchSeen.urls.add(card.url);
        cards.push(card);
      }
      return {
        cards,
        hasMore: pagination.has_next === true,
        query: trimmed,
        page: pageNo,
      };
    },

    async getNovel(url: string): Promise<SourceNovel> {
      const id = novelIdFromUrl(url);
      host.log("info", `getNovel(${id})`);
      const row = await fetchNovel(id);
      const chapters = chaptersFor(row, chapterFallback);

      const meta: SourceNovelMeta[] = [];
      const altNames = (Array.isArray(row.associated_names) ? row.associated_names : [])
        .map((name) => sanitizeText(str(name)))
        .filter((name) => name !== "");
      if (altNames.length > 0) meta.push({ label: t("metaAltNames"), value: altNames.join(" · ") });
      meta.push({ label: t("metaChapters"), value: String(chapters.length) });
      const views = typeof row.views_number === "number" ? row.views_number : Number.parseInt(String(row.views ?? ""), 10);
      if (Number.isFinite(views) && views > 0) {
        meta.push({ label: t("metaViews"), value: String(views).replace(/\B(?=(\d{3})+(?!\d))/g, ",") });
      }
      if (typeof row.rating === "number" && row.rating > 0 && typeof row.rating_count === "number" && row.rating_count > 0) {
        meta.push({
          label: t("metaRating"),
          value: t("ratingValue", { score: row.rating.toFixed(1), count: row.rating_count }),
        });
      }
      const latestRelease = sanitizeText(str(row.latest_release));
      if (latestRelease && latestRelease.toLowerCase() !== "unknown") {
        meta.push({ label: t("metaLatestRelease"), value: latestRelease });
      }
      const updated = (str(row.updated_at) || str(row.created_at)).slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(updated)) meta.push({ label: t("metaUpdated"), value: updated });

      const description = str(row.description).trim();
      return {
        title: sanitizeText(str(row.title)) || id,
        author: authorOf(row),
        language: "en",
        direction: "ltr",
        coverUrl: coverUrlFor(row),
        description: description || undefined,
        tags: genresOf(row.genres),
        status: statusOf(row),
        meta,
        // GET /api/novels/<id> carries every chapter name in one response
        // (8,754 of them, ~100 KB, for the longest novel checked), so there
        // is nothing to load lazily: one fully-populated pseudo-volume.
        volumes: [{ id: 1, title: t("allChapters"), chapters }],
      };
    },

    async searchChapters(novelUrlArg: string, query: string): Promise<SourceChapter[]> {
      const id = novelIdFromUrl(novelUrlArg);
      const q = query.trim().toLowerCase();
      if (!q) return [];
      host.log("info", `searchChapters(${id}, ${q})`);
      const row = lastNovel?.id === id ? lastNovel : await fetchNovel(id);
      // The site's own chapter filter: the number or the name contains it.
      return chaptersFor(row, chapterFallback).filter(
        (chapter) => String(chapter.id).includes(q) || chapter.title.toLowerCase().includes(q),
      );
    },

    async getChapterContent(chapter: SourceChapter): Promise<SourceLine[]> {
      const { novelId, number } = chapterRefFromUrl(chapter.url);
      host.log("debug", `getChapterContent(${novelId} #${number})`);
      // prefetch=1 is the site reader's own read-ahead form: the server
      // skips counting a view and leaves out the novel's whole chapter-name
      // list (27 KB of the 37 KB response for a 3,000-chapter novel).
      const path = `/novels/${novelId}/chapters/${number}?prefetch=1`;
      const body = await getJson(path);
      if (!isRecord(body) || !isRecord(body.chapter) || typeof body.chapter.content !== "string") {
        throw new Error(`novelarchive: /api${path} did not return a chapter.`);
      }
      const lines = contentToLines(body.chapter.content);
      if (lines.length === 0) {
        throw new Error(`novelarchive: chapter ${number} of novel ${novelId} has no text.`);
      }
      return lines;
    },
  };
}
