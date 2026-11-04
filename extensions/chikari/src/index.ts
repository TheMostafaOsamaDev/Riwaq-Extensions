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
/** Chapter-list pages in flight at once after the first. A few at a time
 *  matters for a long novel (7 pages took 11 s at 4 wide); more would only
 *  invite the site's 429 challenge. */
const CHAPTER_PAGE_CONCURRENCY = 4;
/** Ceiling on the chapter-list pages asked for one novel (250,000
 *  chapters), so a corrupt `total` can't turn into thousands of requests. */
const MAX_CHAPTER_PAGES = 500;

/** The novel rows the site's home page knows, in its own order, keyed by the
 *  slug `/api/home` returns. `sort` is the site's own "view all" link for
 *  the row. Rows with a slug missing here are skipped — the site's client
 *  does exactly the same with slugs its table doesn't list. */
const HOME_ROWS = new Map<string, { title: StringKey; sort: string }>([
  ["trending", { title: "homeTrending", sort: "trending" }],
  ["popular", { title: "homePopular", sort: "popular" }],
  ["top-rated", { title: "homeTopRated", sort: "top_rated" }],
  ["bingeable", { title: "homeBingeable", sort: "bingeable" }],
  ["recently-updated", { title: "homeRecentlyUpdated", sort: "updated" }],
  ["recently-added", { title: "homeRecentlyAdded", sort: "added" }],
]);

/** The site's `status` values. Anything else is shown as sent, capitalised. */
const STATUS_LABELS = new Map<string, StringKey>([
  ["releasing", "statusOngoing"],
  ["completed", "statusCompleted"],
  ["hiatus", "statusHiatus"],
  ["cancelled", "statusCancelled"],
  ["upcoming", "statusUpcoming"],
]);

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

/** One row of `GET /api/novels/<slug>/chapters`. */
export interface ChapterRow {
  number: number | null;
  title?: string;
}

/** A chapter row reduced to what a SourceChapter is built from. Plain data,
 *  so getNovel can keep it between calls (see createSource). */
interface Row {
  number: number;
  title: string;
}

interface Page<T> {
  items: T[];
  total: number;
}

/** `GET /api/novels/<slug>/chapters/<number>/read`. */
export interface ChapterRead {
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
/** A novel's API path; its chapter endpoints hang off it. */
const novelPath = (slug: string) => `/api/novels/${encodeURIComponent(slug)}`;

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

/** The parsed JSON, or undefined when `text` isn't JSON. */
function tryJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const shapeError = (path: string, missing: string) =>
  new Error(`chikari: ${path} returned an unexpected shape (${missing}).`);

/** Turn a response into parsed JSON, or a branded error naming `path`.
 *  `what` describes the thing asked for, for the 404 message. */
function readJson(resp: FetchResponse, path: string, what: string): unknown {
  if (resp.status === 429) {
    // The site's own client recognises exactly this shape, pops a
    // human-verification dialog and retries. A plain HTTP client cannot
    // pass that, so the best it can do is back off (the fetcher's
    // "challenge" mode: see createSource).
    const body = tryJson(resp.text);
    const challenge = isObject(body) && body.code === "challenge_required";
    throw new Error(
      challenge
        ? `chikari: chikari.moe wants a human-verification check before serving more (HTTP 429 challenge_required on ${path}). Too many requests in a short time — wait a few minutes, then try again.`
        : `chikari: chikari.moe is rate-limiting requests (HTTP 429 on ${path}). Wait a few minutes, then try again.`,
    );
  }
  if (resp.status === 404) {
    throw new Error(`chikari: ${what} was not found (HTTP 404 from ${path}).`);
  }
  if (resp.status !== 200) {
    throw new Error(`chikari: ${path} answered HTTP ${resp.status}.`);
  }
  const parsed = tryJson(resp.text);
  if (parsed === undefined) {
    throw new Error(`chikari: ${path} did not return JSON (status ${resp.status}).`);
  }
  return parsed;
}

function asPage<T>(data: unknown, path: string): Page<T> {
  if (!isObject(data) || !Array.isArray(data.items)) throw shapeError(path, "no items list");
  const total = typeof data.total === "number" ? data.total : data.items.length;
  return { items: data.items as T[], total };
}

/** Run `fn` over `items` with at most `limit` in flight, keeping order.
 *  Once `stop` is aborted — by the first `fn` that fails, or by the caller
 *  — no further item starts and this rejects. Calls already in flight can't
 *  be recalled, but nothing new is asked of a site that is failing. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  stop: AbortController,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stop.signal.aborted) {
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch (err) {
        stop.abort(err);
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (stop.signal.aborted) throw stop.signal.reason;
  return out;
}

// ── parsing ─────────────────────────────────────────────────────────────────

type Translate = ReturnType<typeof strings>;

const isNovel = (item: SeriesItem) => item.medium === "novel" && typeof item.slug === "string";

function cardFor(item: SeriesItem, t: Translate): NovelCard {
  const latest = item.latest_chapter;
  return {
    url: novelUrl(item.slug),
    title: sanitizeText(item.title) || item.slug,
    coverUrl: item.cover_url || undefined,
    subtitle: typeof latest === "number" ? t("cardLatest", { n: latest }) : undefined,
  };
}

/** Chapter-list rows → Rows, in order. A row with no usable number is
 *  skipped: the read endpoint is addressed by number, so such a chapter
 *  could never be fetched. A repeated number is dropped: pages are fetched
 *  by offset, and a chapter released between two page requests can shift
 *  one row onto the next page as well. */
function rowsFrom(slug: string, items: ChapterRow[], host: SourceHost): Row[] {
  const seen = new Set<number>();
  const rows: Row[] = [];
  for (const item of items) {
    if (!isObject(item) || typeof item.number !== "number" || !Number.isFinite(item.number)) {
      host.log("warn", `chikari: skipping a chapter row of ${slug} with no number: ${JSON.stringify(item)}`);
      continue;
    }
    if (seen.has(item.number)) continue;
    seen.add(item.number);
    rows.push({ number: item.number, title: sanitizeText(item.title) });
  }
  return rows;
}

function chapterFor(slug: string, row: Row, t: Translate): SourceChapter {
  return {
    // The site's own chapter number. Unique within a novel, stable when the
    // site inserts or removes other chapters, and the same value the reader
    // URL carries — so getNovel and searchChapters agree on it without any
    // shared state. Numbers have gaps (a novel with 3124 chapters runs to
    // 3131), so this is not a 1..n index.
    id: row.number,
    title: row.title || t("chapterFallback", { n: row.number }),
    url: chapterUrl(slug, row.number),
    lines: [],
  };
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
  /\b(?:(?:join|in)\s+the|our)\s+discord\b|^discord\s*[:：]|\bdiscord\s+(?:server|link|channel)\b/i,
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

/** The plain-text `description`, split on newlines the way the reader splits
 *  a chapter, each paragraph's whitespace collapsed, joined by blank lines. */
function descriptionFrom(text: string | null | undefined): string | undefined {
  const paragraphs = (text ?? "").split(PARAGRAPH_SPLIT_RE).map(sanitizeText).filter(Boolean);
  return paragraphs.length ? paragraphs.join("\n\n") : undefined;
}

function statusFrom(status: string | undefined, t: Translate): string | undefined {
  const raw = sanitizeText(status);
  const key = STATUS_LABELS.get(raw.toLowerCase());
  return key ? t(key) : raw ? raw[0].toUpperCase() + raw.slice(1) : undefined;
}

function parseNovel(detail: NovelDetail, chapters: SourceChapter[], t: Translate): SourceNovel {
  const meta: SourceNovelMeta[] = [];
  const alts = (detail.alt_titles ?? [])
    .filter((a): a is string => typeof a === "string")
    .map(sanitizeText)
    .filter(Boolean);
  if (alts.length) meta.push({ label: t("metaAltTitles"), value: alts.join(" · ") });
  if (typeof detail.chapter_count === "number") {
    meta.push({ label: t("metaChapters"), value: String(detail.chapter_count) });
  }
  if (typeof detail.rating === "number") {
    meta.push({
      label: t("metaRating"),
      value: t("ratingValue", { score: detail.rating, max: 10, count: detail.rating_count ?? 0 }),
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
    .map((a) => sanitizeText(a.name))
    .filter(Boolean)
    .join(", ");

  return {
    title: sanitizeText(detail.title) || detail.slug,
    // Never a literal "Unknown" — the host localises the empty case.
    author,
    language: "en",
    direction: "ltr",
    coverUrl: detail.cover_url || undefined,
    description: descriptionFrom(detail.description),
    // Genres only. The site's separate `tags` list is NovelUpdates-style —
    // 35 to 100+ per novel, alphabetical, some flagged as spoilers — far too
    // many for chips.
    tags: (detail.genres ?? []).map((g) => sanitizeText(g.name)).filter(Boolean),
    status: statusFrom(detail.status, t),
    meta,
    // The site has no volumes (every row's `volume` is ""), so this is one
    // fully-populated pseudo-volume. Not lazy: the app's importer flattens
    // getNovel's volumes as returned and never calls getVolumeChapters.
    volumes: [{ id: 1, title: t("allChapters"), chapters }],
  };
}

/** What says a novel's chapter list hasn't changed: the detail's chapter
 *  count and the time of its newest chapter. None without a count, so
 *  nothing is cached on a detail that doesn't carry one. */
function listKey(detail: NovelDetail): string | undefined {
  return typeof detail.chapter_count === "number"
    ? `${detail.chapter_count} ${detail.last_chapter_at ?? ""}`
    : undefined;
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

  /** The app calls getNovel for the same novel again right after opening it
   *  (detail view, then importer). This keeps the last novel's chapter rows
   *  and the listKey they were fetched under, so that second call costs the
   *  detail request alone. Rows only, never the SourceChapter objects handed
   *  out: the importer writes every chapter's text onto those. */
  let lastList: { slug: string; key: string; rows: Row[] } | null = null;
  /** getNovel loads in flight, by slug, so concurrent calls share one. */
  const loading = new Map<string, Promise<{ detail: NovelDetail; rows: Row[] }>>();

  /** GET `${BASE_URL}${path}` and parse its JSON; `path` names the endpoint
   *  in every error. */
  async function getJson(path: string, what: string): Promise<unknown> {
    return readJson(await get(`${BASE_URL}${path}`), path, what);
  }

  /** Every page of a novel's chapter list (optionally filtered by `q`), in
   *  ascending order. The first page's `total` gives the page count; the
   *  rest go out a few at a time, and none after `stop` is aborted. */
  async function fetchChapterRows(slug: string, q?: string, stop = new AbortController()): Promise<Row[]> {
    const fetchPage = async (offset: number) => {
      host.log("debug", `chapter list ${slug} offset ${offset}${q ? ` q=${q}` : ""}`);
      const path =
        `${novelPath(slug)}/chapters?${q ? `q=${encodeURIComponent(q)}&` : ""}` +
        `order=asc&limit=${CHAPTER_PAGE_SIZE}&offset=${offset}`;
      return asPage<ChapterRow>(await getJson(path, `novel "${slug}"`), path);
    };

    const first = await fetchPage(0);
    const pages = Math.min(Math.ceil(first.total / CHAPTER_PAGE_SIZE), MAX_CHAPTER_PAGES);
    const offsets = Array.from({ length: Math.max(0, pages - 1) }, (_, i) => (i + 1) * CHAPTER_PAGE_SIZE);
    const rest = await mapLimit(offsets, CHAPTER_PAGE_CONCURRENCY, stop, fetchPage);
    const rows = rowsFrom(slug, [first, ...rest].flatMap((p) => p.items), host);
    if (rows.length !== first.total) {
      // Warn rather than throw: the chapters that did come back are still
      // a readable book.
      host.log("warn", `chikari: ${slug} lists ${first.total} chapters but ${rows.length} were collected.`);
    }
    return rows;
  }

  async function fetchDetail(slug: string): Promise<NovelDetail> {
    const path = novelPath(slug);
    const detail = await getJson(path, `novel "${slug}"`);
    if (!isObject(detail) || typeof detail.slug !== "string") throw shapeError(path, "no novel object");
    return detail as unknown as NovelDetail;
  }

  /** A novel's detail and chapter rows. The detail is fetched every time:
   *  it is what says whether `lastList` is still current. With nothing
   *  cached for this novel, the list goes out alongside the detail, and
   *  stops asking for pages if the detail fails. */
  async function loadNovel(slug: string): Promise<{ detail: NovelDetail; rows: Row[] }> {
    const cached = lastList?.slug === slug ? lastList : null;
    const stop = new AbortController();
    const detail = fetchDetail(slug).catch((err: unknown) => {
      stop.abort(err);
      throw err;
    });
    const list = cached
      ? detail.then((d) => (listKey(d) === cached.key ? cached.rows : fetchChapterRows(slug, undefined, stop)))
      : fetchChapterRows(slug, undefined, stop);
    const [d, rows] = await Promise.all([detail, list]);
    const key = listKey(d);
    lastList = key === undefined ? null : { slug, key, rows };
    return { detail: d, rows };
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
      const path = "/api/home?type=novel";
      const data = await getJson(path, "the home page");
      if (!isObject(data) || !Array.isArray(data.rows)) throw shapeError(path, "no rows list");
      const sections: SourceSection[] = [];
      for (const row of data.rows as unknown[]) {
        if (!isObject(row) || typeof row.slug !== "string" || !Array.isArray(row.items)) continue;
        const known = HOME_ROWS.get(row.slug);
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
        throw new Error(`chikari: ${path} returned no novel rows. The site's API may have changed.`);
      }
      return sections;
    },

    async search(query: string, page = 1): Promise<SourceSearchResult> {
      const trimmed = query.trim();
      const p = Number.isInteger(page) && page > 0 ? page : 1;
      // An empty query is a hollow result, not a request: the endpoint would
      // answer it with the whole novel catalogue.
      if (!trimmed) {
        return { cards: [], hasMore: false, query: trimmed, page: p };
      }
      host.log("info", `search(${trimmed}) page ${p}`);
      const offset = (p - 1) * SEARCH_PAGE_SIZE;
      // No `sort`: the endpoint's default ranks by relevance (an exact title
      // match first), and its ordering is stable across offsets.
      const path =
        `/api/series?q=${encodeURIComponent(trimmed)}&type=novel` +
        `&limit=${SEARCH_PAGE_SIZE}&offset=${offset}`;
      const { items, total } = asPage<SeriesItem>(await getJson(path, "search"), path);
      return {
        cards: items.filter(isNovel).map((item) => cardFor(item, t)),
        hasMore: items.length > 0 && offset + items.length < total,
        query: trimmed,
        page: p,
      };
    },

    async getNovel(url: string): Promise<SourceNovel> {
      const slug = slugFromUrl(url);
      host.log("info", `getNovel(${slug})`);
      let load = loading.get(slug);
      if (!load) {
        load = loadNovel(slug).finally(() => loading.delete(slug));
        loading.set(slug, load);
      }
      const { detail, rows } = await load;
      // Fresh SourceChapter objects on every call (see lastList).
      return parseNovel(detail, rows.map((row) => chapterFor(slug, row, t)), t);
    },

    async searchChapters(novelUrlArg: string, query: string): Promise<SourceChapter[]> {
      const trimmed = query.trim();
      if (!trimmed) return [];
      const slug = slugFromUrl(novelUrlArg);
      host.log("info", `searchChapters(${slug}, ${trimmed})`);
      const rows = await fetchChapterRows(slug, trimmed);
      return rows.map((row) => chapterFor(slug, row, t));
    },

    async getChapterContent(chapter: SourceChapter): Promise<SourceLine[]> {
      // debug, not info: importing a 1,500-chapter novel calls this 1,500 times.
      host.log("debug", `getChapterContent(${chapter.id}) ${chapter.url}`);
      const { slug, number } = chapterRefFromUrl(chapter.url);
      const path = `${novelPath(slug)}/chapters/${number}/read`;
      const data = await getJson(path, `chapter ${number} of "${slug}"`);
      if (!isObject(data)) throw shapeError(path, "no chapter object");
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
      if (typeof read.body !== "string") throw shapeError(path, "no body text");
      const lines = parseChapterBody(read.body);
      if (lines.length === 0) {
        throw new Error(`chikari: chapter ${number} of "${slug}" parsed to zero lines.`);
      }
      return lines;
    },
  };
}
