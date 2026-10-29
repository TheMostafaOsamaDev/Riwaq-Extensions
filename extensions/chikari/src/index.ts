// chikari.moe — English web novels. The site is a SvelteKit SPA whose HTML
// is an empty shell (no server-side rendering of any content), but every
// page is filled from a public JSON API under /api that answers plain,
// cookie-less GETs with no token, signature or JS challenge. This extension
// talks to that API only; it never parses HTML.
//
// The site also hosts manga/manhwa/manhua under /series/<slug>. This
// extension is novels-only: every listing call passes `type=novel` (which
// the API honours), cards are additionally filtered to `medium: "novel"`,
// and canHandle only accepts /novels/... URLs.
//
//   home      GET /api/home?type=novel                      → { rows: [{ slug, items }] }
//   search    GET /api/series?q=&type=novel&limit=&offset=  → { items, total, limit, offset }
//   novel     GET /api/novels/<slug>                        → detail object
//   chapters  GET /api/novels/<slug>/chapters?order=asc&limit=500&offset=
//                                                           → { items, total, ... } (500 max per page)
//   in-novel  GET /api/novels/<slug>/chapters?q=&order=asc&limit=500&offset=
//   chapter   GET /api/novels/<slug>/chapters/<number>/read → { body, locked, ... }
//
// See README.md for the response shapes, the reader's body format and the
// rate limiter.
import {
  createFetcher,
  findCreditLines,
  sanitizeText,
  SourceUrlError,
  stripWatermarks,
  type FetchResponse,
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
import { strings, type StringKey } from "./strings";

const BASE_URL = "https://chikari.moe";
const API_URL = `${BASE_URL}/api`;
// Exact hostname membership, never a substring/suffix test (see canHandle).
// www. 301s to the apex, but a user can still paste a www. link.
const { hostname: BASE_HOSTNAME } = new URL(BASE_URL);
const HOSTS = new Set([BASE_HOSTNAME, `www.${BASE_HOSTNAME}`]);

/** Results per search page. The site's own /search page asks the same
 *  endpoint for 36 at a time. */
export const SEARCH_PAGE_SIZE = 36;
/** The chapter-list endpoint caps `limit` at 500 — asking for more still
 *  returns 500 (verified with limit=1000 and limit=5000). */
export const CHAPTER_PAGE_SIZE = 500;
/** How many chapter-list pages getNovel fetches at once after the first. */
const CHAPTER_PAGE_CONCURRENCY = 4;
/** Ceiling on chapter-list pages for one novel (250,000 chapters), so a
 *  corrupt `total` can't send getNovel into an unbounded loop. */
const MAX_CHAPTER_PAGES = 500;

/** The novel rows the site's home page knows, in its own order, keyed by the
 *  slug `/api/home` returns. `sort` is the site's own "view all" link for
 *  the row. Rows with a slug missing here are skipped — the site's client
 *  does exactly the same with slugs its table doesn't list. */
const HOME_ROWS: Record<string, { title: StringKey; sort: string }> = {
  trending: { title: "homeTrending", sort: "trending" },
  popular: { title: "homePopular", sort: "popular" },
  "top-rated": { title: "homeTopRated", sort: "top_rated" },
  bingeable: { title: "homeBingeable", sort: "bingeable" },
  "recently-updated": { title: "homeRecentlyUpdated", sort: "updated" },
  "recently-added": { title: "homeRecentlyAdded", sort: "added" },
};

const STATUS_LABELS: Record<string, StringKey> = {
  releasing: "statusReleasing",
  completed: "statusCompleted",
  hiatus: "statusHiatus",
  cancelled: "statusCancelled",
  upcoming: "statusUpcoming",
};

// ── response shapes (only the fields this extension reads) ─────────────────

/** One card-sized row, as `/api/home`, `/api/series` and friends return it. */
export interface SeriesItem {
  slug: string;
  title?: string;
  status?: string;
  medium?: string;
  cover_url?: string | null;
  latest_chapter?: number | null;
  chapter_count?: number;
}

interface NamedRef {
  name?: string;
  slug?: string;
  role?: string;
}

/** `GET /api/novels/<slug>`. Its `chapters_head`/`chapters_tail` (ten rows
 *  each) are ignored — the paginated chapters endpoint is the full list. */
export interface NovelDetail extends SeriesItem {
  description?: string | null;
  year?: number | null;
  rating?: number | null;
  rating_count?: number;
  views?: number;
  last_chapter_at?: string | null;
  genres?: NamedRef[];
  authors?: NamedRef[];
  alt_titles?: unknown[];
}

export interface ChapterRow {
  number: number | null;
  title?: string;
  volume?: string;
}

interface Page<T> {
  items: T[];
  total: number;
}

/** `GET /api/novels/<slug>/chapters/<number>/read`. */
export interface ChapterRead {
  number?: number;
  title?: string;
  body?: string;
  locked?: boolean;
  lock_reason?: string;
  club_block?: unknown;
  protected_window?: number;
}

// ── URLs ────────────────────────────────────────────────────────────────────

const novelUrl = (slug: string) => `${BASE_URL}/novels/${encodeURIComponent(slug)}`;
/** The site's own reader URL. A chapter number goes into the path exactly as
 *  the site's client formats it — `String(number)`, so 12 → "12" and a
 *  half-chapter 12.5 → "12.5". */
const chapterUrl = (slug: string, number: number) => `${novelUrl(slug)}/${String(number)}`;
const novelApi = (slug: string) => `${API_URL}/novels/${encodeURIComponent(slug)}`;

function parseUrl(url: string): URL | null {
  try {
    const u = new URL(url);
    return HOSTS.has(u.hostname) ? u : null;
  } catch {
    return null;
  }
}

/** `/novels/<slug>` and everything under it (`/novels/<slug>/<n>`,
 *  `/novels/<slug>/reviews/<id>`) yield <slug>. */
export function slugFromUrl(url: string): string {
  const m = parseUrl(url)?.pathname.match(/^\/novels\/([^/]+)/);
  if (!m) {
    throw new SourceUrlError(`chikari: ${url} is not a chikari.moe novel URL.`);
  }
  return decodeURIComponent(m[1]);
}

/** `/novels/<slug>/<number>` → { slug, number }. */
export function chapterRefFromUrl(url: string): { slug: string; number: number } {
  const m = parseUrl(url)?.pathname.match(/^\/novels\/([^/]+)\/([^/]+)\/?$/);
  const number = m ? Number(decodeURIComponent(m[2])) : NaN;
  if (!m || !Number.isFinite(number)) {
    throw new SourceUrlError(`chikari: ${url} is not a chikari.moe chapter URL.`);
  }
  return { slug: decodeURIComponent(m[1]), number };
}

// ── transport ───────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Turn a response into parsed JSON, or a branded error naming the endpoint.
 *  `what` describes the thing asked for, for the 404 message. */
export function readJson(resp: FetchResponse, endpoint: string, what: string): unknown {
  let parsed: unknown;
  let parseFailed = false;
  try {
    parsed = JSON.parse(resp.text);
  } catch {
    parseFailed = true;
  }
  if (resp.status === 429) {
    // The site's own client recognises exactly this shape, pops a
    // human-verification dialog and retries. A plain HTTP client cannot
    // pass that, so the best it can do is back off (the fetcher's
    // "challenge" mode: see createSource).
    const challenge = isObject(parsed) && parsed.code === "challenge_required";
    throw new Error(
      challenge
        ? `chikari: chikari.moe wants a human-verification check before serving more (HTTP 429 challenge_required on ${endpoint}). Too many requests in a short time — wait a few minutes, then try again.`
        : `chikari: chikari.moe is rate-limiting requests (HTTP 429 on ${endpoint}). Wait a few minutes, then try again.`,
    );
  }
  if (resp.status === 404) {
    throw new Error(`chikari: ${what} was not found (HTTP 404 from ${endpoint}).`);
  }
  if (resp.status !== 200) {
    throw new Error(`chikari: ${endpoint} answered HTTP ${resp.status}.`);
  }
  if (parseFailed) {
    throw new Error(`chikari: ${endpoint} did not return JSON (status ${resp.status}).`);
  }
  return parsed;
}

function asPage<T>(data: unknown, endpoint: string): Page<T> {
  if (!isObject(data) || !Array.isArray(data.items)) {
    throw new Error(`chikari: ${endpoint} returned an unexpected shape (no items list).`);
  }
  const total = typeof data.total === "number" ? data.total : data.items.length;
  return { items: data.items as T[], total };
}

/** Run `fn` over `items` with at most `limit` in flight, keeping order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ── parsing ─────────────────────────────────────────────────────────────────

type Translate = ReturnType<typeof strings>;

const isNovel = (item: SeriesItem) => item.medium === "novel" && typeof item.slug === "string";

export function cardFor(item: SeriesItem, t: Translate): NovelCard {
  const latest = item.latest_chapter;
  return {
    url: novelUrl(item.slug),
    title: item.title?.trim() || item.slug,
    coverUrl: item.cover_url || undefined,
    subtitle: typeof latest === "number" ? t("cardLatest", { n: latest }) : undefined,
  };
}

function chapterFor(slug: string, row: ChapterRow, t: Translate): SourceChapter {
  const number = row.number as number;
  return {
    // The site's own chapter number. Unique within a novel, stable when the
    // site inserts or removes other chapters, and the same value the reader
    // URL carries — so getNovel and searchChapters agree on it without any
    // shared state. Numbers have gaps (a novel with 3124 chapters runs to
    // 3131), so this is not a 1..n index.
    id: number,
    title: row.title?.trim() || t("chapterFallback", { n: number }),
    url: chapterUrl(slug, number),
    lines: [],
  };
}

/** Rows with no usable number are skipped: the read endpoint is addressed by
 *  number, so such a chapter could never be fetched. */
function chaptersFrom(slug: string, rows: ChapterRow[], t: Translate, host: SourceHost): SourceChapter[] {
  const seen = new Set<number>();
  const out: SourceChapter[] = [];
  for (const row of rows) {
    if (!isObject(row) || typeof row.number !== "number" || !Number.isFinite(row.number)) {
      host.log("warn", `chikari: skipping a chapter row of ${slug} with no number: ${JSON.stringify(row)}`);
      continue;
    }
    // Pages are fetched by offset; a chapter released between two page
    // requests can shift one row onto the next page as well.
    if (seen.has(row.number)) continue;
    seen.add(row.number);
    out.push(chapterFor(slug, row, t));
  }
  return out;
}

// The reader passes exactly these inline tags through as HTML and shows
// every other `<...>` literally (the site HTML-escapes the body first). So
// only these are stripped here — `<Dark Exploration Records>` in a body is
// story text, not markup.
const INLINE_TAG_RE = /<\/?(?:em|strong|i|b|u|s|sup|sub)>/gi;
const BR_RE = /<br\s*\/?>/gi;
// The reader's own paragraph split.
const PARAGRAPH_SPLIT_RE = /\n\s*\n|\n/;

/** Lines that are never story text: links and donation/promo plugs.
 *  Calibrated against ~85 chapters across ~75 novels; each pattern names a
 *  shape actually seen. Ordinary prose that merely mentions coffee,
 *  comments or translating survives — see the tests. Aggregator watermarks
 *  and credit lines are the shared rules (see parseChapterBody). */
const JUNK_LINE_RES = [
  // Any link: "Discord: https://dsc.gg/…", "…my Patreon here –> https://…".
  /https?:\/\/|\bwww\.[a-z0-9-]+\.[a-z]/i,
  // A bare domain is a link too ("Support me at mysite.com"); a known
  // aggregator's watermark has already been cut out of the line by then.
  // TLD kept lower-case and short-listed so a missing space after a full
  // stop ("time.Me") can't hit.
  /\b[A-Za-z0-9-]{2,}\.(?:com|net|org|moe)\b/,
  // "… thanks to … on Ko-fi!", and "<strong>KO-FI</strong><strong>BUY ME A
  // COFEE</strong>", which loses its space once the tags go — hence no
  // word boundaries. The hyphen is required so the name "Kofi" survives.
  /\bko-fi/i,
  /buy\s*me\s*a\s*cof+e+/i,
  /\bpatreon\b/i,
  // "Please join the discord …", "Join our discord …", "Link to donations in
  // the discord!" — not the plain noun ("sowing discord").
  /\b(?:join|in)\s+(?:our|the)\s+discord\b|\bour\s+discord\b|^discord\s*[:：]|\bdiscord\s+(?:server|link|channel)\b/i,
  // "subscribe to advanced chapters …", "Adv4nc3 Ch4pt3r".
  /\badvanced?\s+chapters?\b|\badv4nc3\b/i,
  // "Translator's Comments", "Translator Notes: …".
  /^(?:translator'?s?|tl|t\/n)\s*(?:notes?|comments?)\b/i,
];
export function isJunkLine(line: string): boolean {
  return JUNK_LINE_RES.some((re) => re.test(line));
}

/** A chapter `body` → text lines, the way the site's reader splits it,
 *  without what isn't story text: translator credit lines
 *  ("Translator: AtlasStudios Editor: AtlasStudios") near the chapter's
 *  edges, aggregator watermarks cut out of any line (both shared rules from
 *  @riwaq/extension-api), then this site's link and plug lines. */
export function parseChapterBody(body: string): SourceLine[] {
  const pieces: string[] = [];
  for (const para of body.split(PARAGRAPH_SPLIT_RE)) {
    for (const piece of para.split(BR_RE)) {
      const content = sanitizeText(piece.replace(INLINE_TAG_RE, ""));
      if (content) pieces.push(content);
    }
  }
  const credits = findCreditLines(pieces);
  const lines: SourceLine[] = [];
  pieces.forEach((piece, i) => {
    const content = credits.has(i) ? "" : stripWatermarks(piece);
    if (content && !isJunkLine(content)) lines.push({ type: "text", content });
  });
  return lines;
}

function isoDay(stamp: string | null | undefined): string | undefined {
  const m = stamp?.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : undefined;
}

export function parseNovel(detail: NovelDetail, chapters: SourceChapter[], t: Translate): SourceNovel {
  const meta: SourceNovelMeta[] = [];
  const alts = (detail.alt_titles ?? [])
    .filter((a): a is string => typeof a === "string")
    .map((a) => a.trim())
    .filter(Boolean);
  if (alts.length) meta.push({ label: t("metaAltTitles"), value: alts.join(" · ") });
  if (typeof detail.chapter_count === "number") {
    meta.push({ label: t("metaChapters"), value: String(detail.chapter_count) });
  }
  if (typeof detail.rating === "number") {
    meta.push({
      label: t("metaRating"),
      value: t("metaRatingValue", { score: detail.rating, count: detail.rating_count ?? 0 }),
    });
  }
  if (typeof detail.views === "number") {
    meta.push({ label: t("metaViews"), value: String(detail.views) });
  }
  if (typeof detail.year === "number") {
    meta.push({ label: t("metaYear"), value: String(detail.year) });
  }
  const updated = isoDay(detail.last_chapter_at);
  if (updated) meta.push({ label: t("metaUpdated"), value: updated });

  const authors = detail.authors ?? [];
  const writers = authors.filter((a) => !a.role || a.role === "author");
  const author = (writers.length ? writers : authors)
    .map((a) => a.name?.trim())
    .filter(Boolean)
    .join(", ");

  const statusKey = detail.status ? STATUS_LABELS[detail.status] : undefined;

  return {
    title: detail.title?.trim() || detail.slug,
    // Never a literal "Unknown" — the host localises the empty case.
    author,
    language: "en",
    direction: "ltr",
    coverUrl: detail.cover_url || undefined,
    description: detail.description?.trim() || undefined,
    // Genres only. The site's separate `tags` list is NovelUpdates-style —
    // 35 to 100+ per novel, alphabetical, some flagged as spoilers — far too
    // many for chips.
    tags: (detail.genres ?? []).map((g) => g.name?.trim() ?? "").filter(Boolean),
    status: statusKey ? t(statusKey) : detail.status || undefined,
    meta,
    // The site has no volumes (every row's `volume` is ""), so this is one
    // fully-populated pseudo-volume. Not lazy: the app's importer flattens
    // getNovel's volumes as returned and never calls getVolumeChapters.
    volumes: [{ id: 1, title: t("volumeFallback"), chapters }],
  };
}

// ── the source ──────────────────────────────────────────────────────────────

export default function createSource(host: SourceHost): Source {
  const t = strings(host.locale);

  /** host.fetch with the shared retry policy: a dropped request or a 5xx is
   *  retried with a backoff. A 429 here is the human-verification challenge
   *  (see readJson), which retrying can't pass and would only prolong, so it
   *  comes straight back and every request for the next while (its
   *  Retry-After, else a minute) fails fast without being sent. */
  const get = createFetcher(host, { id: "chikari", on429: "challenge" });

  async function getJson(url: string, what: string): Promise<unknown> {
    const endpoint = url.slice(BASE_URL.length);
    return readJson(await get(url), endpoint, what);
  }

  /** Every page of a novel's chapter list (optionally filtered by `q`), in
   *  ascending order. One request for the first page tells us `total`; the
   *  rest go out a few at a time. */
  async function fetchChapterRows(slug: string, q?: string): Promise<{ rows: ChapterRow[]; total: number }> {
    const pageUrl = (offset: number) =>
      `${novelApi(slug)}/chapters?${q ? `q=${encodeURIComponent(q)}&` : ""}order=asc&limit=${CHAPTER_PAGE_SIZE}&offset=${offset}`;
    const fetchPage = async (offset: number) => {
      host.log("debug", `chapter list ${slug} offset ${offset}${q ? ` q=${q}` : ""}`);
      const url = pageUrl(offset);
      return asPage<ChapterRow>(await getJson(url, `novel "${slug}"`), url.slice(BASE_URL.length));
    };

    const first = await fetchPage(0);
    const pages = Math.min(Math.ceil(first.total / CHAPTER_PAGE_SIZE), MAX_CHAPTER_PAGES);
    const offsets = Array.from({ length: Math.max(0, pages - 1) }, (_, i) => (i + 1) * CHAPTER_PAGE_SIZE);
    const rest = await mapLimit(offsets, CHAPTER_PAGE_CONCURRENCY, fetchPage);
    return { rows: [first, ...rest].flatMap((p) => p.items), total: first.total };
  }

  return {
    canHandle(url: string): boolean {
      // Cheap and synchronous. Novel pages and anything under them only —
      // not the home page, search, or /series/... (the site's manga).
      const u = parseUrl(url);
      return !!u && /^\/novels\/[^/]+(?:\/|$)/.test(u.pathname);
    },

    async getHomeSections(): Promise<SourceSection[]> {
      host.log("info", "getHomeSections");
      const endpoint = "/api/home?type=novel";
      const data = await getJson(`${BASE_URL}${endpoint}`, "the home page");
      if (!isObject(data) || !Array.isArray(data.rows)) {
        throw new Error(`chikari: ${endpoint} returned an unexpected shape (no rows list).`);
      }
      const sections: SourceSection[] = [];
      for (const row of data.rows as unknown[]) {
        if (!isObject(row) || typeof row.slug !== "string" || !Array.isArray(row.items)) continue;
        const known = HOME_ROWS[row.slug];
        if (!known) continue;
        const cards = (row.items as SeriesItem[]).filter(isNovel).map((item) => cardFor(item, t));
        if (cards.length === 0) continue;
        sections.push({
          id: row.slug,
          title: t(known.title),
          cards,
          viewMoreUrl: `${BASE_URL}/search?sort=${known.sort}&type=novel`,
        });
      }
      if (sections.length === 0) {
        throw new Error(`chikari: ${endpoint} returned no novel rows. The site's API may have changed.`);
      }
      return sections;
    },

    async search(query: string, page = 1): Promise<SourceSearchResult> {
      const trimmed = query.trim();
      const pageNum = Math.max(1, Math.trunc(page) || 1);
      // An empty query is a hollow result, not a request: the endpoint would
      // answer it with the whole novel catalogue.
      if (!trimmed) {
        return { cards: [], hasMore: false, query: trimmed, page: pageNum };
      }
      host.log("info", `search(${trimmed}) page ${pageNum}`);
      const offset = (pageNum - 1) * SEARCH_PAGE_SIZE;
      // No `sort`: the endpoint's default ranks by relevance (an exact title
      // match first), and its ordering is stable across offsets.
      const endpoint =
        `/api/series?q=${encodeURIComponent(trimmed)}&type=novel` +
        `&limit=${SEARCH_PAGE_SIZE}&offset=${offset}`;
      const { items, total } = asPage<SeriesItem>(await getJson(`${BASE_URL}${endpoint}`, "search"), endpoint);
      return {
        cards: items.filter(isNovel).map((item) => cardFor(item, t)),
        hasMore: items.length > 0 && offset + items.length < total,
        query: trimmed,
        page: pageNum,
      };
    },

    async getNovel(url: string): Promise<SourceNovel> {
      const slug = slugFromUrl(url);
      host.log("info", `getNovel(${slug})`);
      const [detail, list] = await Promise.all([
        getJson(novelApi(slug), `novel "${slug}"`),
        fetchChapterRows(slug),
      ]);
      if (!isObject(detail) || typeof detail.slug !== "string") {
        throw new Error(`chikari: /api/novels/${slug} returned an unexpected shape (no novel object).`);
      }
      const chapters = chaptersFrom(slug, list.rows, t, host);
      if (chapters.length !== list.total) {
        // Warn rather than throw: the chapters that did come back are still
        // a readable book.
        host.log("warn", `chikari: ${slug} lists ${list.total} chapters but ${chapters.length} were collected.`);
      }
      return parseNovel(detail as unknown as NovelDetail, chapters, t);
    },

    async searchChapters(novelUrlArg: string, query: string): Promise<SourceChapter[]> {
      const trimmed = query.trim();
      if (!trimmed) return [];
      const slug = slugFromUrl(novelUrlArg);
      host.log("info", `searchChapters(${slug}, ${trimmed})`);
      const { rows } = await fetchChapterRows(slug, trimmed);
      return chaptersFrom(slug, rows, t, host);
    },

    async getChapterContent(chapter: SourceChapter): Promise<SourceLine[]> {
      // debug, not info: importing a 1,500-chapter novel calls this 1,500 times.
      host.log("debug", `getChapterContent(${chapter.id}) ${chapter.url}`);
      const { slug, number } = chapterRefFromUrl(chapter.url);
      const endpoint = `/api/novels/${encodeURIComponent(slug)}/chapters/${String(number)}/read`;
      const data = await getJson(`${BASE_URL}${endpoint}`, `chapter ${number} of "${slug}"`);
      if (!isObject(data)) {
        throw new Error(`chikari: ${endpoint} returned an unexpected shape (no chapter object).`);
      }
      const read = data as ChapterRead;
      if (read.club_block) {
        throw new Error(
          `chikari: chapter ${number} of "${slug}" is restricted to a reading club on chikari.moe and cannot be read without joining it.`,
        );
      }
      if (read.locked) {
        const why =
          read.lock_reason === "early_access"
            ? `early access for supporters${read.protected_window ? ` (the newest ${read.protected_window} chapters)` : ""}`
            : read.lock_reason || "locked";
        throw new Error(
          `chikari: chapter ${number} of "${slug}" is locked on chikari.moe — ${why}. It becomes readable once the site unlocks it.`,
        );
      }
      if (typeof read.body !== "string") {
        throw new Error(`chikari: ${endpoint} returned an unexpected shape (no body text).`);
      }
      const lines = parseChapterBody(read.body);
      if (lines.length === 0) {
        throw new Error(`chikari: chapter ${number} of "${slug}" parsed to zero lines.`);
      }
      return lines;
    },
  };
}
