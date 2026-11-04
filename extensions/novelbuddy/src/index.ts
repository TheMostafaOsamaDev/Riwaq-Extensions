// NovelBuddy source — novelbuddy.me. English translations of Chinese, Korean
// and Japanese web novels plus English originals. The site is a Next.js
// pages-router app: every page it serves carries its full server-side data
// as JSON in `<script id="__NEXT_DATA__">`, so this extension reads that JSON
// instead of scraping rendered markup wherever it can.
//
// What each method fetches (all plain GETs, no JS, no tokens, no cookies
// required — see the README for the evidence):
//
//   getHomeSections   https://novelbuddy.me/home
//                     pageProps.trendingItems / popularItems / latest.items,
//                     one row each (see HOME_ROWS).
//   search            https://novelbuddy.me/search?q=<q>&page=<n>
//                     pageProps.ssrItems + pageProps.ssrPagination.has_next.
//   getNovel          https://novelbuddy.me/<slug>  (pageProps.initialManga)
//                     then https://api.novelbuddy.me/titles/<id>/chapters?cv=<cv>
//                     for the chapter list. The novel page only inlines the
//                     newest 50 chapters; the API call is the one the site's
//                     own client makes, and returns every chapter in one
//                     response (6,107 for Martial Peak) — no pagination. The
//                     list request is skipped when the last list fetched is
//                     this novel's at the same `cv` (see createSource's `last`).
//   getChapterContent https://novelbuddy.me/<slug>/<chapter-slug>
//                     pageProps.initialChapter.content, an HTML fragment.
//   searchChapters    no request of its own when getNovel already ran: it
//                     filters the chapter list getNovel fetched.
//
// URL shapes: a novel is `/<slug>` and a chapter `/<slug>/<chapter-slug>` —
// there is NO `/novel/` prefix on the current site (`/novel/<slug>` 404s).
// The old NovelBuddy (novelbuddy.io / novelbuddy.com) did use `/novel/<slug>`,
// and both of those domains now 301 to novelbuddy.me, so links saved from
// them are accepted and rewritten (see slugFromUrl). `www.novelbuddy.me` is a
// 301 to ITSELF (an infinite redirect loop, verified with curl -L), so every
// request goes to the bare `novelbuddy.me` host no matter which host the
// caller's URL used.
import {
  absoluteUrl,
  createFetcher,
  findCreditLines,
  isLeadingHeading,
  parseHtml,
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

type T = ReturnType<typeof strings>;

export const BASE_URL = "https://novelbuddy.me";
export const API_URL = "https://api.novelbuddy.me";

/** Every host that serves (or redirects to) this catalogue. novelbuddy.io
 *  and novelbuddy.com are the older domains; both answer 301 to
 *  novelbuddy.me today. Exact membership, never a suffix match — see the
 *  canHandle tests. */
const HOSTS = new Set([
  "novelbuddy.me",
  "www.novelbuddy.me",
  "novelbuddy.io",
  "www.novelbuddy.io",
  "novelbuddy.com",
  "www.novelbuddy.com",
]);

/** Path prefixes older or alternate URL forms put in front of the novel
 *  slug: `/novel/<slug>` was the old novelbuddy.io/.com shape, and the
 *  current site still routes `/read/<slug>[/<chapter>]` to the same title. */
const LEGACY_PREFIXES = new Set(["novel", "read"]);

// ── URLs ────────────────────────────────────────────────────────────────

/** The novel slug of any accepted NovelBuddy novel or chapter URL (mirror
 *  host, `www.`, legacy `/novel/` or `/read/` prefix). Throws a
 *  SourceUrlError for a URL that isn't a NovelBuddy page or has no path. */
export function slugFromUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SourceUrlError(`novelbuddy: "${url}" is not a valid URL.`);
  }
  if (!HOSTS.has(parsed.hostname)) {
    throw new SourceUrlError(`novelbuddy: ${url} is not a NovelBuddy URL.`);
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  // Only skip a legacy prefix when something follows it, so a (so far
  // hypothetical) novel whose own slug is "novel" or "read" still resolves.
  const slug = segments.length >= 2 && LEGACY_PREFIXES.has(segments[0]) ? segments[1] : segments[0];
  if (!slug) {
    throw new SourceUrlError(`novelbuddy: ${url} is not a novel or chapter URL.`);
  }
  return decodeURIComponent(slug);
}

export function novelUrl(slug: string): string {
  return `${BASE_URL}/${encodeURIComponent(slug)}`;
}

export function searchUrl(query: string, page: number): string {
  const params = new URLSearchParams({ q: query });
  if (page > 1) params.set("page", String(page));
  return `${BASE_URL}/search?${params}`;
}

/** A title's `cv` (cache version) as a string, "" when the page has none. */
const cvOf = (cv: unknown): string => (typeof cv === "number" || typeof cv === "string" ? String(cv) : "");

/** `cv` is the title's cache version. The site's own client appends it to
 *  this call; without it the CDN can serve a stale list (measured: 3,227
 *  chapters without `cv` against 3,229 with it, on the same minute). */
export function chapterListUrl(titleId: string, cv: unknown): string {
  const base = `${API_URL}/titles/${encodeURIComponent(titleId)}/chapters`;
  const v = cvOf(cv);
  return v ? `${base}?cv=${encodeURIComponent(v)}` : base;
}

// ── __NEXT_DATA__ ───────────────────────────────────────────────────────

export type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const named = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => sanitizeText(isObject(x) ? str(x.name) : "")).filter(Boolean) : [];

/** `JSON.parse`, or undefined for text that isn't JSON. */
function tryJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const NEXT_DATA_RE = /<script[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i;

/** Status check + `__NEXT_DATA__` extraction for one fetched page. Every
 *  page this extension reads goes through here, so a non-2xx answer, a
 *  Cloudflare interstitial, or a layout change that drops the Next.js
 *  payload all fail with a message naming the page, not a TypeError from
 *  deep inside a parser. */
export function readPageProps(resp: FetchResponse, pageUrl: string): Json {
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`novelbuddy: ${pageUrl} answered HTTP ${resp.status}.`);
  }
  const m = NEXT_DATA_RE.exec(resp.text);
  if (!m) {
    throw new Error(
      `novelbuddy: ${pageUrl} has no __NEXT_DATA__ payload — the site may have changed, or this was a challenge/error page served with HTTP ${resp.status}.`,
    );
  }
  const data = tryJson(m[1]);
  if (data === undefined) {
    throw new Error(`novelbuddy: ${pageUrl} has a __NEXT_DATA__ payload that is not valid JSON.`);
  }
  const pageProps = isObject(data) && isObject(data.props) ? data.props.pageProps : undefined;
  if (!isObject(pageProps)) {
    throw new Error(`novelbuddy: ${pageUrl} has no props.pageProps in its __NEXT_DATA__ payload.`);
  }
  return pageProps;
}

/** The site's own error text for a page whose data didn't load, if any. */
function pageError(props: Json): string {
  for (const key of ["httpError", "initialError", "chapterError"]) {
    const v = props[key];
    if (typeof v === "string" && v) return v;
    if (isObject(v)) return str(v.message) || str(v.statusCode) || JSON.stringify(v);
  }
  return "";
}

// ── cards ───────────────────────────────────────────────────────────────

/** A listing entry (home rows, search results) → a card, or null if it
 *  can't name a novel. The card URL is rebuilt from the slug on the
 *  canonical host, never trusted from `url`, so a mirror-relative or
 *  absolute `url` can't leak in. */
export function cardFor(item: unknown): NovelCard | null {
  if (!isObject(item)) return null;
  const slug = str(item.slug) || str(item.url).replace(/^\/+/, "");
  const title = sanitizeText(str(item.name));
  if (!slug || slug.includes("/") || !title) return null;
  const cover = str(item.cover);
  const latest = Array.isArray(item.latestChapters) && isObject(item.latestChapters[0])
    ? sanitizeText(str(item.latestChapters[0].name))
    : "";
  const badges = named(item.genres).slice(0, 3);
  return {
    url: novelUrl(slug),
    title,
    coverUrl: cover ? absoluteUrl(cover, BASE_URL) : undefined,
    subtitle: latest || sanitizeText(str(item.displayChapters)) || undefined,
    badges: badges.length > 0 ? badges : undefined,
  };
}

const cardsFrom = (items: unknown[]): NovelCard[] =>
  items.map(cardFor).filter((c): c is NovelCard => c !== null);

// ── home ────────────────────────────────────────────────────────────────

/** The home page's novel rows, in page order, each read straight from one
 *  `pageProps` array (`latest` wraps its array as `{ items, pagination }`).
 *  `count` is how many cards the site renders — Trending shows the first 12
 *  of the payload's 50 `trendingItems` — and `more` is the row's own "See
 *  all" link (Latest Updates has none). The page's other `<h2>` rows, XP
 *  Leaderboard and Latest Lists, hold no novels; the "Top read" sidebar is
 *  a re-cut of Popular Updates. */
const HOME_ROWS: ReadonlyArray<{ id: string; key: string; title: StringKey; count: number; more?: string }> = [
  { id: "trending", key: "trendingItems", title: "homeTrending", count: 12, more: "/trending/manga" },
  { id: "popular", key: "popularItems", title: "homePopularUpdates", count: 10, more: "/search?sort=views_today" },
  { id: "latest", key: "latest", title: "homeLatestUpdates", count: 24 },
];

// ── HTML fragments → lines ──────────────────────────────────────────────

/** Elements that start a new line of text. */
const BLOCK_TAGS = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "ASIDE", "NAV",
  "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "CENTER", "FIGURE",
  "FIGCAPTION", "UL", "OL", "LI", "DL", "DT", "DD", "TABLE", "TR", "TD", "TH", "HR",
]);
/** Elements whose content is never reading text (ad slots, embeds). */
const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "INS", "SVG", "BUTTON",
  "FORM", "INPUT", "SELECT", "TEXTAREA", "OBJECT", "EMBED", "VIDEO", "AUDIO",
]);

export interface RawLine {
  type: "text" | "image";
  content: string;
  /** Whether the line's text sits inside a `<p>` — see chapterLinesFrom. */
  inParagraph: boolean;
}

/** Flattens an HTML fragment into lines: a new line at every block element
 *  and every `<br>`, inline elements (`<strong>`, `<em>`, `<span>`) merged
 *  into the text around them, `<img>` emitted as its own image line.
 *
 *  This is deliberately a walk of the whole fragment rather than a
 *  `querySelectorAll("p")`: chapter bodies on this site come in three
 *  shapes (measured over 73 chapters from 54 novels) —
 *  `<p>` paragraphs; a `<div>` holding a bare heading text node and then
 *  `<p>`s; and, on machine-translated titles, bare text nodes separated by
 *  `<br /><br />` with no `<p>` at all. A `<p>`-only reader returns zero
 *  lines for that third shape. */
export function htmlToRawLines(html: string, baseUrl: string): RawLine[] {
  const body = parseHtml(html).body;
  const out: RawLine[] = [];
  let buf = "";
  let bufInParagraph = false;

  const flush = () => {
    // Zero-width characters (U+200B-U+200D, U+2060, U+FEFF) are not `\s`,
    // so sanitizeText keeps them; Reverend Insanity's later chapters put a
    // U+200C after nearly every word. Private-Use-Area code points
    // (U+E000-U+F8FF) are the source site's font-obfuscation glyphs (whole
    // lines of U+E5E5 in MTL chapters) and render as tofu without that font.
    const text = sanitizeText(buf.replace(/[\u200b-\u200d\u2060\ufeff\ue000-\uf8ff]/g, ""));
    if (text) out.push({ type: "text", content: text, inParagraph: bufInParagraph });
    buf = "";
    bufInParagraph = false;
  };

  const walk = (node: Node, inParagraph: boolean) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const text = child.textContent ?? "";
        if (!buf.trim() && text.trim()) bufInParagraph = inParagraph;
        buf += text;
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      const tag = el.tagName.toUpperCase();
      if (SKIP_TAGS.has(tag)) continue;
      if (tag === "BR") {
        flush();
      } else if (tag === "IMG") {
        flush();
        const src = (el.getAttribute("data-src") || el.getAttribute("src") || "").trim();
        if (src && !src.startsWith("data:")) {
          try {
            out.push({ type: "image", content: absoluteUrl(src, baseUrl), inParagraph });
          } catch {
            // An unparseable src is not worth failing a chapter over.
          }
        }
      } else if (BLOCK_TAGS.has(tag)) {
        flush();
        walk(el, inParagraph || tag === "P");
        flush();
      } else {
        walk(el, inParagraph);
      }
    }
  };

  if (body) walk(body, false);
  flush();
  return out;
}

/** Site furniture baked into chapter bodies, dropped wherever it appears.
 *  Both are distinctive whole sentences, never story text:
 *  - the site's own UI notice, a bare `<div>` at the end of some chapters:
 *    "A new text-to-speech function has been added. You can try clicking
 *    on the settings!"
 *  - the footer older, scraped chapters carry from the site they were
 *    copied from: "If you find any errors ( Ads popup, ads redirect,
 *    broken links, non-standard content, etc.. ), Please let us know
 *    < report chapter > so we can fix it as soon as possible." */
const SITE_NOTICE_RES = [
  /^a new text-to-speech function has been added\b/i,
  /^if you find any errors\b.*\blet us know\b/i,
];

/** A chapter-navigation link scraped in as text: "Previous Chapter",
 *  "Next Chapter", "Previous Chapter | Next Chapter", "Table of Contents"
 *  (seen as the last `<p>` of Against the Gods' prologue). Whole line only,
 *  and only among a chapter's first and last NAV_EDGE text lines. */
const NAV_PART = "(?:(?:previous|prev|next)\\s+chapter|table\\s+of\\s+contents)";
const NAV_RE = new RegExp(`^${NAV_PART}(?:\\s*[|/·•–—-]\\s*${NAV_PART})*$`, "i");
const NAV_EDGE = 4;

/** The trailer machine-translated chapters end on — the source site's
 *  "本章完" rendered as a line of its own. Exact whole-line match only. */
const END_MARKER_RE = /^\(\s*end of (?:this )?chapter\s*\)$/i;

/** Raw lines of one chapter body → the lines a reader should see. With
 *  the shared rules from @riwaq/extension-api: aggregator watermarks are cut
 *  out of every line (freewebnovel's look-alike-spelled domain, on a line
 *  of its own or glued onto a story paragraph — the line goes only if
 *  nothing else was on it); translation-team credits go (bracketed ones
 *  anywhere, bare ones near the chapter's edges); and so does a leading
 *  heading — the first text line, when it repeats the chapter's own title
 *  ignoring case and punctuation ("Chapter 6081, Disciplinary Hall"), or
 *  sits outside a `<p>` and reads "Chapter N…" (the wrapper heading or MTL
 *  first line). Any other "Chapter N" paragraph a translator wrote is left
 *  alone. This site's own: notices anywhere, the MTL end marker anywhere,
 *  and navigation remnants among the first/last NAV_EDGE text lines. */
export function chapterLinesFrom(raw: RawLine[], chapterTitle = ""): SourceLine[] {
  const textAt = raw.flatMap((l, i) => (l.type === "text" ? [i] : []));
  const edges = new Set([...textAt.slice(0, NAV_EDGE), ...textAt.slice(-NAV_EDGE)]);
  const credits = new Set(Array.from(findCreditLines(textAt.map((i) => raw[i].content)), (k) => textAt[k]));
  const lines: SourceLine[] = [];
  raw.forEach((line, i) => {
    if (line.type === "image") {
      lines.push({ type: "image", content: line.content });
      return;
    }
    const text = stripWatermarks(line.content);
    if (!text) return;
    if (i === textAt[0] && isLeadingHeading(text, { title: chapterTitle, numbered: !line.inParagraph })) return;
    if (SITE_NOTICE_RES.some((re) => re.test(text))) return;
    if (credits.has(i)) return;
    if (edges.has(i) && NAV_RE.test(text)) return;
    if (END_MARKER_RE.test(text)) return;
    lines.push({ type: "text", content: text });
  });
  return lines;
}

/** The novel summary is HTML (`<p>…<br />…</p>`); the host renders the
 *  description as plain text, so paragraphs are joined with blank lines. */
export function descriptionFrom(summary: unknown): string | undefined {
  const html = str(summary);
  if (!html.trim()) return undefined;
  const text = htmlToRawLines(html, BASE_URL)
    .filter((l) => l.type === "text")
    .map((l) => l.content)
    .join("\n\n");
  return text || undefined;
}

// ── novel ───────────────────────────────────────────────────────────────

/** The site's status values (its search filter's options). The novel page
 *  spells one "OnGoing" where listings say "ongoing", hence the lower-casing
 *  lookup. A Map, not an object, so "constructor" is not a status. */
const STATUS_KEYS = new Map<string, StringKey>([
  ["ongoing", "statusOngoing"],
  ["completed", "statusCompleted"],
  ["hiatus", "statusHiatus"],
  ["cancelled", "statusCancelled"],
]);

/** The novel's status in the host's locale; a value the site has not been
 *  seen to send passes through with its first letter capitalised. */
function statusLabel(status: unknown, t: T): string | undefined {
  const s = sanitizeText(str(status));
  const key = STATUS_KEYS.get(s.toLowerCase());
  if (key) return t(key);
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : undefined;
}

/** One chapter of a novel's list as this extension keeps it between calls:
 *  plain strings, never a SourceChapter handed to the app (see `last` in
 *  createSource). `title` is "" when the API sent none. */
export interface ChapterRow {
  title: string;
  url: string;
}

/** The API's chapter list → rows in reading order. The API sends newest
 *  first; reversed here. Direction is checked rather than assumed where the
 *  rows carry numbers: if the first row's number is already the smaller
 *  one, the list is left as is. A chapter's id is its 1-based position in
 *  these rows, not the site's `number` — that is 0 for Martial Peak's first
 *  chapter and can repeat or skip, which an id must never do. */
export function parseChapterList(resp: FetchResponse, listUrl: string): ChapterRow[] {
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`novelbuddy: chapter list ${listUrl} answered HTTP ${resp.status}.`);
  }
  const json = tryJson(resp.text);
  if (json === undefined) {
    throw new Error(`novelbuddy: chapter list ${listUrl} did not return JSON (HTTP ${resp.status}).`);
  }
  const rows = isObject(json) && json.success !== false && isObject(json.data) ? json.data.chapters : undefined;
  if (!Array.isArray(rows)) {
    const msg = isObject(json) ? str(json.message) : "";
    throw new Error(
      `novelbuddy: chapter list ${listUrl} did not contain data.chapters${msg ? ` (${msg})` : ""}.`,
    );
  }

  const valid = rows.filter((r): r is Json => isObject(r) && str(r.url).startsWith("/"));
  const firstNum = valid[0]?.number;
  const lastNum = valid[valid.length - 1]?.number;
  const ascending = typeof firstNum === "number" && typeof lastNum === "number" && firstNum < lastNum;
  const ordered = ascending ? valid : [...valid].reverse();

  const seen = new Set<string>();
  const out: ChapterRow[] = [];
  for (const row of ordered) {
    const url = absoluteUrl(str(row.url), BASE_URL);
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ title: sanitizeText(str(row.name)), url });
  }
  return out;
}

/** A novel page's `pageProps.initialManga` plus its chapter list → a
 *  SourceNovel. Pure: every request has already been made by the caller.
 *
 *  - `tags` is the novel's genres followed by its finer-grained tags, with
 *    case-insensitive duplicates dropped (Shadow Slave lists "Action",
 *    "Adventure" and "Romance" as both).
 *  - `originalTitle` is the site's alt name when it differs from the title
 *    (Korean `그림자 서약` for Shadow's Oath; Shadow Slave's alt name is
 *    just "Shadow Slave" again, so it gets none).
 *  - `meta` rows are only emitted for values the page actually has; the
 *    rating only with its count (`ratingsCount`), on the site's 5-point
 *    scale. */
export function buildNovel(manga: Json, chapters: SourceChapter[], t: T): SourceNovel {
  const title = sanitizeText(str(manga.name));
  const alt = sanitizeText(str(manga.displayAltName) || str(manga.altName));
  const cover = str(manga.cover);

  const tags: string[] = [];
  const seenTags = new Set<string>();
  for (const name of [...named(manga.genres), ...named(manga.tags)]) {
    const key = name.toLowerCase();
    if (seenTags.has(key)) continue;
    seenTags.add(key);
    tags.push(name);
  }

  const meta: SourceNovelMeta[] = [];
  const type = isObject(manga.type) ? sanitizeText(str(manga.type.name)) : "";
  if (type) meta.push({ label: t("metaType"), value: type });
  meta.push({ label: t("metaChapters"), value: String(chapters.length) });
  const rating = sanitizeText(str(manga.displayRating));
  const count = manga.ratingsCount;
  if (rating && typeof count === "number" && count > 0) {
    meta.push({ label: t("metaRating"), value: t("ratingValue", { score: rating, max: 5, count }) });
  }
  const views = sanitizeText(str(manga.displayViews));
  if (views) meta.push({ label: t("metaViews"), value: views });
  const bookmarks = sanitizeText(str(manga.displayBookmarks));
  if (bookmarks) meta.push({ label: t("metaBookmarks"), value: bookmarks });
  const released = sanitizeText(str(manga.releaseDate));
  if (released) meta.push({ label: t("metaReleased"), value: released.slice(0, 10) });
  const updated = str(manga.updatedAt);
  if (/^\d{4}-\d{2}-\d{2}/.test(updated)) {
    meta.push({ label: t("metaUpdated"), value: updated.slice(0, 10) });
  }

  return {
    title,
    // "" (never "Unknown") when the site lists no author — the host
    // localises the empty case at display time.
    author: named(manga.authors).join(", "),
    originalTitle: alt && alt.toLowerCase() !== title.toLowerCase() ? alt : undefined,
    language: "en",
    direction: "ltr",
    coverUrl: cover ? absoluteUrl(cover, BASE_URL) : undefined,
    description: descriptionFrom(manga.summary),
    tags,
    status: statusLabel(manga.status, t),
    meta,
    volumes: [{ id: 1, title: t("allChapters"), chapters, chapterCount: chapters.length }],
  };
}

export default function createSource(host: SourceHost): Source {
  const t = strings(host.locale);

  /** host.fetch with the shared retry policy: a request that throws or
   *  answers 5xx is retried with a backoff. The site is slow and flaky under
   *  plain load — measured 1–21 s per page, an occasional 60 s stall, and the
   *  odd TLS "connection reset by peer" — and one dropped request would
   *  otherwise fail a chapter in the middle of a long import. A 4xx is the
   *  site's real answer and is not retried. */
  const get = createFetcher(host, { id: "novelbuddy" });

  /** The last chapter list this Source fetched, as plain rows — never the
   *  SourceChapter objects handed to the app. The importer writes each
   *  chapter's text onto those objects, so caching them would pin every
   *  imported chapter's text in memory (~100 MB for a 6,000-chapter novel).
   *  Every getNovel/searchChapters call builds fresh chapters from the rows.
   *
   *  Keyed by slug and the title's `cv` (cache version, from the novel
   *  page). getNovel still fetches the page — fresh metadata and the current
   *  `cv` — but skips the ~800 KB list while `cv` hasn't moved. The entry
   *  holds the promise, so concurrent calls for one list share one request;
   *  a failed request is dropped so the next call tries again. Closure
   *  state, not module state: two Source instances never share it. */
  let last: { slug: string; cv: string; rows: Promise<ChapterRow[]> } | null = null;

  async function loadNovelPage(slug: string): Promise<Json> {
    const pageUrl = novelUrl(slug);
    const props = readPageProps(await get(pageUrl), pageUrl);
    const manga = props.initialManga;
    if (!isObject(manga) || !sanitizeText(str(manga.name))) {
      const why = pageError(props);
      throw new Error(
        `novelbuddy: ${pageUrl} carried no novel data (pageProps.initialManga)${why ? `: ${why}` : ""}.`,
      );
    }
    return { ...manga, id: str(manga.id) || str(props.mangaHsid) };
  }

  async function fetchChapterRows(slug: string, manga: Json): Promise<ChapterRow[]> {
    const titleId = str(manga.id);
    if (!/^[A-Za-z0-9]+$/.test(titleId)) {
      throw new Error(`novelbuddy: ${novelUrl(slug)} carried no usable title id (got "${titleId}").`);
    }
    const listUrl = chapterListUrl(titleId, manga.cv);
    const rows = parseChapterList(await get(listUrl), listUrl);

    const expected = isObject(manga.stats) ? manga.stats.chaptersCount : undefined;
    if (typeof expected === "number" && expected !== rows.length) {
      host.log(
        "warn",
        `novelbuddy: ${novelUrl(slug)} reports ${expected} chapters but the chapter list returned ${rows.length}.`,
      );
    }
    return rows;
  }

  /** The novel's chapter rows: `last`'s when slug and `cv` match, else a
   *  new request that becomes `last`. */
  function chapterRows(slug: string, manga: Json): Promise<ChapterRow[]> {
    const cv = cvOf(manga.cv);
    if (cv && last?.slug === slug && last.cv === cv) return last.rows;
    const entry = { slug, cv, rows: fetchChapterRows(slug, manga) };
    entry.rows.catch(() => {
      if (last === entry) last = null;
    });
    last = entry;
    return entry.rows;
  }

  const chaptersFrom = (rows: ChapterRow[]): SourceChapter[] =>
    rows.map((row, i) => ({
      id: i + 1,
      title: row.title || t("chapterFallback", { n: i + 1 }),
      url: row.url,
      lines: [],
    }));

  return {
    canHandle(url: string): boolean {
      try {
        return HOSTS.has(new URL(url).hostname);
      } catch {
        return false;
      }
    },

    async getHomeSections(): Promise<SourceSection[]> {
      const pageUrl = `${BASE_URL}/home`;
      host.log("info", "getHomeSections");
      const props = readPageProps(await get(pageUrl), pageUrl);
      const sections: SourceSection[] = [];
      for (const row of HOME_ROWS) {
        const v = props[row.key];
        const items = Array.isArray(v) ? v : isObject(v) && Array.isArray(v.items) ? v.items : [];
        const cards = cardsFrom(items).slice(0, row.count);
        if (cards.length === 0) continue;
        sections.push({
          id: row.id,
          title: t(row.title),
          cards,
          viewMoreUrl: row.more ? `${BASE_URL}${row.more}` : undefined,
        });
      }
      // No row at all is a layout change or an error page, never a real
      // empty homepage.
      if (sections.length === 0) {
        throw new Error(`novelbuddy: found no novel rows on ${pageUrl} — the home page layout may have changed.`);
      }
      return sections;
    },

    async search(query: string, page = 1): Promise<SourceSearchResult> {
      const trimmed = query.trim();
      const p = Number.isInteger(page) && page > 0 ? page : 1;
      if (!trimmed) return { cards: [], hasMore: false, query: trimmed, page: p };

      const url = searchUrl(trimmed, p);
      host.log("info", `search(${trimmed}) page ${p} -> ${url}`);
      const props = readPageProps(await get(url), url);
      if (!Array.isArray(props.ssrItems)) {
        throw new Error(`novelbuddy: search page ${url} carried no results list (pageProps.ssrItems).`);
      }
      const cards = cardsFrom(props.ssrItems);
      const hasNext = isObject(props.ssrPagination) && props.ssrPagination.has_next === true;
      return { cards, hasMore: hasNext && cards.length > 0, query: trimmed, page: p };
    },

    async getNovel(url: string): Promise<SourceNovel> {
      const slug = slugFromUrl(url);
      host.log("info", `getNovel(${novelUrl(slug)})`);
      const manga = await loadNovelPage(slug);
      return buildNovel(manga, chaptersFrom(await chapterRows(slug, manga)), t);
    },

    /** In-novel chapter search. The site has no chapter-search endpoint,
     *  but getNovel already fetched the whole list (one API response), so
     *  this filters it by case-insensitive substring of the title. For a
     *  novel other than the last one getNovel opened, the page and list
     *  are fetched again the same way. */
    async searchChapters(url: string, query: string): Promise<SourceChapter[]> {
      const needle = sanitizeText(query).toLowerCase();
      if (!needle) return [];
      const slug = slugFromUrl(url);
      host.log("info", `searchChapters(${novelUrl(slug)}, ${needle})`);
      const rows = await (last?.slug === slug ? last.rows : chapterRows(slug, await loadNovelPage(slug)));
      return chaptersFrom(rows).filter((c) => c.title.toLowerCase().includes(needle));
    },

    async getChapterContent(chapter: SourceChapter): Promise<SourceLine[]> {
      // Chapter URLs only ever come from parseChapterList, on BASE_URL.
      const { url } = chapter;
      // debug, not info: one call per chapter of an import.
      host.log("debug", `getChapterContent(${url})`);
      const props = readPageProps(await get(url), url);
      const data = props.initialChapter;
      const content = isObject(data) ? data.content : undefined;
      if (typeof content !== "string") {
        const why = pageError(props);
        throw new Error(
          `novelbuddy: ${url} carried no chapter text (pageProps.initialChapter.content)${why ? `: ${why}` : ""}.`,
        );
      }
      const lines = chapterLinesFrom(htmlToRawLines(content, url), chapter.title);
      if (!lines.some((l) => l.type === "text")) {
        throw new Error(`novelbuddy: chapter body at ${url} parsed to zero lines of text.`);
      }
      return lines;
    },
  };
}
