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
//                     Row headings, row order and row membership come from
//                     the rendered `<section><header><h2>` blocks; each
//                     card's data comes from that same page's __NEXT_DATA__
//                     (see parseHomeSections).
//   search            https://novelbuddy.me/search?q=<q>&page=<n>
//                     pageProps.ssrItems + pageProps.ssrPagination.has_next.
//   getNovel          https://novelbuddy.me/<slug>  (pageProps.initialManga)
//                     then https://api.novelbuddy.me/titles/<id>/chapters?cv=<cv>
//                     for the chapter list. The novel page only inlines the
//                     newest 50 chapters; the API call is the one the site's
//                     own client makes, and returns every chapter in one
//                     response (6,107 for Martial Peak) — no pagination.
//   getChapterContent https://novelbuddy.me/<slug>/<chapter-slug>
//                     pageProps.initialChapter.content, an HTML fragment.
//   searchChapters    no request of its own when getNovel already ran: it
//                     filters the chapter list getNovel fetched.
//
// URL shapes: a novel is `/<slug>` and a chapter `/<slug>/<chapter-slug>` —
// there is NO `/novel/` prefix on the current site (`/novel/<slug>` 404s).
// The old NovelBuddy (novelbuddy.io / novelbuddy.com) did use `/novel/<slug>`,
// and both of those domains now 301 to novelbuddy.me, so links saved from
// them are accepted and rewritten (see novelPath). `www.novelbuddy.me` is a
// 301 to ITSELF (an infinite redirect loop, verified with curl -L), so every
// request goes to the bare `novelbuddy.me` host no matter which host the
// caller's URL used.
import {
  absoluteUrl,
  parseHtml,
  sanitizeText,
  SourceUrlError,
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
import { strings } from "./strings";

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

/** How many novels' chapter lists `searchChapters` keeps in memory. */
const CHAPTER_CACHE_SIZE = 4;

// ── URLs ────────────────────────────────────────────────────────────────

/** The novel-relative path segments of a NovelBuddy URL: `[slug]` for a
 *  novel page, `[slug, chapterSlug]` for a chapter. Throws a SourceUrlError
 *  for a URL that isn't a NovelBuddy page or has no path at all. */
export function novelPath(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SourceUrlError(`novelbuddy: "${url}" is not a valid URL.`);
  }
  if (!HOSTS.has(parsed.hostname)) {
    throw new SourceUrlError(`novelbuddy: ${url} is not a NovelBuddy URL.`);
  }
  const segments = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((s) => decodeURIComponent(s));
  // Only strip a legacy prefix when something follows it, so a (so far
  // hypothetical) novel whose own slug is "novel" or "read" still resolves.
  if (segments.length >= 2 && LEGACY_PREFIXES.has(segments[0])) segments.shift();
  if (segments.length === 0) {
    throw new SourceUrlError(`novelbuddy: ${url} is not a novel or chapter URL.`);
  }
  return segments;
}

export function slugFromUrl(url: string): string {
  return novelPath(url)[0];
}

export function novelUrl(slug: string): string {
  return `${BASE_URL}/${encodeURIComponent(slug)}`;
}

/** Rewrites any accepted chapter URL (mirror host, `www.`, legacy
 *  `/novel/` prefix) onto `https://novelbuddy.me/<slug>/<chapter-slug>`. */
export function canonicalChapterUrl(url: string): string {
  const [slug, chapterSlug] = novelPath(url);
  if (!chapterSlug) {
    throw new SourceUrlError(`novelbuddy: ${url} is a novel URL, not a chapter URL.`);
  }
  return `${novelUrl(slug)}/${encodeURIComponent(chapterSlug)}`;
}

export function searchUrl(query: string, page: number): string {
  const params = new URLSearchParams({ q: query });
  if (page > 1) params.set("page", String(page));
  return `${BASE_URL}/search?${params}`;
}

/** `cv` is the title's cache version. The site's own client appends it to
 *  this call; without it the CDN can serve a stale list (measured: 3,227
 *  chapters without `cv` against 3,229 with it, on the same minute). */
export function chapterListUrl(titleId: string, cv: unknown): string {
  const base = `${API_URL}/titles/${encodeURIComponent(titleId)}/chapters`;
  return typeof cv === "number" || (typeof cv === "string" && cv)
    ? `${base}?cv=${encodeURIComponent(String(cv))}`
    : base;
}

// ── __NEXT_DATA__ ───────────────────────────────────────────────────────

export type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const named = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => sanitizeText(isObject(x) ? str(x.name) : "")).filter(Boolean) : [];

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
  let data: unknown;
  try {
    data = JSON.parse(m[1]);
  } catch {
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

/** One title object as the site's listing payloads carry it (home rows,
 *  search results). Only the fields read here are typed. */
export interface TitleItem {
  id?: string;
  url?: string;
  slug?: string;
  name?: string;
  cover?: string;
  latestChapters?: Array<{ name?: string }>;
  displayChapters?: string | null;
  genres?: Array<{ name?: string }>;
}

/** A listing entry → a card, or null if it can't name a novel. The card
 *  URL is rebuilt from the slug on the canonical host, never trusted from
 *  `url`, so a mirror-relative or absolute `url` can't leak in. */
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

/** Walks a pageProps object and indexes every title-shaped object in it
 *  by slug: anything with a string `name`, a string `slug`, and a `url`
 *  that is exactly `/<slug>`. That last check is what keeps chapters
 *  (`/<slug>/<chapter>`), genres (`/genres/<x>`) and authors
 *  (`/authors/<x>`) — which also carry name/slug/url — out of the index.
 *
 *  The home page repeats one title across several arrays with different
 *  amounts of detail (trendingItems ships `latestChapters: []`,
 *  popularItems ships three), so a later occurrence fills in fields an
 *  earlier one left empty rather than being dropped. */
export function indexTitleItems(props: Json): Map<string, Json> {
  const index = new Map<string, Json>();
  const visit = (v: unknown, depth: number) => {
    if (depth > 8) return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    if (!isObject(v)) return;
    const slug = str(v.slug);
    if (slug && str(v.name) && str(v.url) === `/${slug}`) {
      const prev = index.get(slug);
      if (!prev) {
        index.set(slug, v);
      } else {
        const merged: Json = { ...prev };
        for (const [k, val] of Object.entries(v)) {
          const old = merged[k];
          const empty = old == null || old === "" || (Array.isArray(old) && old.length === 0);
          if (empty) merged[k] = val;
        }
        index.set(slug, merged);
      }
    }
    for (const [k, val] of Object.entries(v)) {
      if (k === "siteConfig") continue;
      if (typeof val === "object" && val !== null) visit(val, depth + 1);
    }
  };
  visit(props, 0);
  return index;
}

// ── home ────────────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/** The slug a home-page anchor points at, if it points at a novel page:
 *  a site-relative href with exactly one path segment. */
function anchorSlug(a: Element): string | null {
  const href = a.getAttribute("href") ?? "";
  if (!href.startsWith("/") || href.startsWith("//")) return null;
  const segments = href.split(/[?#]/)[0].split("/").filter(Boolean);
  return segments.length === 1 ? decodeURIComponent(segments[0]) : null;
}

/** One SourceSection per `<section>` under `<main>` whose `<header>` has an
 *  `<h2>`, in page order — today "Trending", "Popular Updates" and "Latest
 *  Updates". The heading text is the site's own; the section id is a slug
 *  of it ("trending", "popular-updates", "latest-updates"), so it stays the
 *  same however many rows render on a given day.
 *
 *  Which novels a row holds, and in what order, is read from the row's own
 *  anchors; what each card says (clean title, cover, latest chapter,
 *  genres) comes from the page's __NEXT_DATA__, indexed by slug. Reading
 *  card text off the markup instead would mean un-mixing the "1", "2", …
 *  rank digits the Trending row renders inside its <h3> titles. An anchor
 *  whose slug isn't a title in the payload (`/hall-of-fame` in the XP
 *  Leaderboard, `/lists`, footer links) contributes nothing, which is what
 *  drops the two non-novel rows ("XP Leaderboard", "Latest Lists").
 *  Anchors inside the row's <header> ("See all") or an <aside> are skipped
 *  defensively: today no header link is a title slug, and the "Top read"
 *  <aside> (a re-cut of Popular Updates) is a sibling of the Latest Updates
 *  <section>, not inside it — but either moving would silently splice
 *  another row's novels into this one.
 *
 *  A page that yields no section at all is refused loudly: that's a layout
 *  change or an error page, never a real empty homepage. */
export function parseHomeSections(html: string, props: Json, pageUrl: string): SourceSection[] {
  const titles = indexTitleItems(props);
  const doc = parseHtml(html);
  const sections: SourceSection[] = [];
  const usedIds = new Set<string>();

  for (const section of Array.from(doc.querySelectorAll("main section"))) {
    const heading = section.querySelector("header h2");
    const title = sanitizeText(heading?.textContent);
    if (!title) continue;

    const seen = new Set<string>();
    const cards: NovelCard[] = [];
    for (const a of Array.from(section.querySelectorAll("a[href]"))) {
      if (a.closest("header, aside")) continue;
      const slug = anchorSlug(a);
      if (!slug || seen.has(slug)) continue;
      const item = titles.get(slug);
      const card = item ? cardFor(item) : null;
      if (!card) continue;
      seen.add(slug);
      cards.push(card);
    }
    if (cards.length === 0) continue;

    let id = slugify(title) || "section";
    for (let n = 2; usedIds.has(id); n++) id = `${slugify(title) || "section"}-${n}`;
    usedIds.add(id);

    const more = section.querySelector("header a.section-see")?.getAttribute("href");
    sections.push({
      id,
      title,
      cards,
      viewMoreUrl: more ? absoluteUrl(more, BASE_URL) : undefined,
    });
  }

  if (sections.length === 0) {
    throw new Error(
      `novelbuddy: found no novel rows on ${pageUrl} — the home page layout may have changed.`,
    );
  }
  return sections;
}

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

/** Translation-team credit lines (all four shapes seen live): a role word,
 *  a separator, and a short name — nothing else on the line.
 *
 *  - Bracketed, `[Translator - Night]` / `[Proofreader - Gun]`: dropped
 *    wherever they appear. Shadow's Oath chapters are two source chapters
 *    glued together, so the pair shows up mid-body as well as at both
 *    ends, and a whole line in brackets with a role word is unambiguous.
 *  - Bare, `Editor: Henyee Translations` / `Author: Silavin`: dropped only
 *    among a chapter's first and last CREDIT_EDGE text lines, where credits
 *    sit, so a system panel reading "Author: Unknown" mid-chapter stays. */
const CREDIT_ROLE = "(?:author|translator|translated by|editor|edited by|proofreader|proofread by)";
const BRACKETED_CREDIT_RE = new RegExp(`^\\[\\s*${CREDIT_ROLE}\\s*[:：\\-–—]\\s*[^\\]]{1,60}\\]$`, "i");
const BARE_CREDIT_RE = new RegExp(`^${CREDIT_ROLE}\\s*[:：\\-–—]\\s*[^\\[\\]]{1,60}$`, "i");
const CREDIT_EDGE = 4;

/** A chapter-navigation link scraped in as text: "Previous Chapter",
 *  "Next Chapter", "Previous Chapter | Next Chapter", "Table of Contents"
 *  (seen as the last `<p>` of Against the Gods' prologue). Whole line only,
 *  and only among the edge lines, like the bare credits. */
const NAV_PART = "(?:(?:previous|prev|next)\\s+chapter|table\\s+of\\s+contents)";
const NAV_RE = new RegExp(`^${NAV_PART}(?:\\s*[|/·•–—-]\\s*${NAV_PART})*$`, "i");

// ── aggregator watermarks ───────────────────────────────────────────────
//
// Many chapters were copied from freewebnovel.com and still carry its
// watermark, spelled with look-alike characters so a plain string match
// misses it. All seen live, on four different novels:
//
//   Foll𝑜w current novℯls on ƒrēewebnoѵёl.cσm.                (own <p>)
//   Updat𝓮d fr𝙤m ƒгeeweɓn૦vel.com.                            (own <p>)
//   The 𝘮ost uptodat𝑒 novels are pub𝙡ished on freeweɓnovēl.coɱ. (own <p>)
//   Visit frёewebnoѵel.ƈo๓ for the b𝘦st novel reading experience.
//   The 𝘮ost uptodat𝑒 novels are pub𝙡ished on fre(e)webno(v)el.𝒸𝑜𝘮
//   …Not until today at least.𝕗𝗿𝕖𝐞𝐰𝗲𝕓𝐧𝕠𝕧𝗲𝐥.𝚌𝐨𝚖                (glued onto story text)
//
// `foldForMatch` undoes what it can — NFKD turns the mathematical letters
// (𝓮, 𝕗, 𝚌, 𝒸) and accented ones (ē) back into ASCII — and turns every
// other non-ASCII letter or digit (ƒ г ɓ ૦ ѵ σ ƈ ๓ ɱ) into a wildcard, so
// no confusables table has to be complete. A domain then matches when it
// is one of the aggregator names below plus a TLD — one bracket or
// punctuation character of noise allowed between letters, "fre(e)webno(v)el"
// — with at most half of its letters wildcards. Requiring the TLD keeps a
// story that merely mentions a "web novel" safe.

const WATERMARK_SITES = ["freewebnovel", "novelbin", "lightnovelpub", "lightnovelworld", "novelfire", "novelfull"];
const WATERMARK_TLDS = ["com", "net", "org", "me", "co"];
const WILD = "\u0001";
const NOISE = "()\\[\\]{}*_'\\-";
const wildWord = (w: string) => Array.from(w, (c) => `[${c}${WILD}]`).join(`[${NOISE}]?`);
const WATERMARK_RE = new RegExp(
  `(?:${WATERMARK_SITES.map(wildWord).join("|")})\\s*[.·${WILD}]\\s*(?:${WATERMARK_TLDS.map(wildWord).join("|")})`,
  "g",
);
const SENTENCE_END = /[.!?。！？…]/;
const CLOSERS = /["'”’)\]\s]/;

/** Lower-cased, ASCII-folded copy of `text` (one entry per output char)
 *  and, for each folded char, the index of the code point it came from. */
function foldForMatch(chars: string[]): { folded: string; origin: number[] } {
  let folded = "";
  const origin: number[] = [];
  chars.forEach((ch, i) => {
    const base = ch.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
    for (const c of Array.from(base)) {
      folded += c.charCodeAt(0) < 128 ? c : /[\p{L}\p{N}]/u.test(c) ? WILD : c;
      origin.push(i);
    }
  });
  return { folded, origin };
}

/** Removes every aggregator watermark sentence from one line. The cut
 *  runs from the start of the sentence holding the domain to that
 *  sentence's end — unless the domain is glued straight onto the next
 *  word, where only the domain itself goes. Returns "" when nothing but
 *  watermark was on the line. */
export function stripWatermarks(text: string): string {
  // Fast path: a plain-ASCII line that never says "novel" can't hold one.
  if (!/[^\x00-\x7f]/.test(text) && !/novel/i.test(text)) return text;
  let chars = Array.from(text);
  for (let guard = 0; guard < 5; guard++) {
    const { folded, origin } = foldForMatch(chars);
    let hit: { start: number; end: number } | null = null;
    for (const m of folded.matchAll(WATERMARK_RE)) {
      const letters = m[0].replace(/[\s.·()[\]{}*_'-]/g, "");
      const wild = letters.split(WILD).length - 1;
      if (wild * 2 <= letters.length) {
        hit = { start: origin[m.index!], end: origin[m.index! + m[0].length - 1] + 1 };
        break;
      }
    }
    if (!hit) break;

    let start = hit.start;
    while (start > 0 && !SENTENCE_END.test(chars[start - 1])) start--;
    while (start < hit.start && CLOSERS.test(chars[start])) start++;

    let end = hit.end;
    if (end < chars.length && !/[\p{L}\p{N}]/u.test(chars[end])) {
      while (end < chars.length && !SENTENCE_END.test(chars[end])) end++;
      while (end < chars.length && SENTENCE_END.test(chars[end])) end++;
      while (end < chars.length && CLOSERS.test(chars[end]) && chars[end] !== " ") end++;
    }
    chars = [...chars.slice(0, start), ...chars.slice(end)];
  }
  return sanitizeText(chars.join(""));
}

/** The trailer machine-translated chapters end on — the source site's
 *  "本章完" rendered as a line of its own. Exact whole-line match only. */
const END_MARKER_RE = /^\(\s*end of (?:this )?chapter\s*\)$/i;

/** The heading many chapter bodies open with as a bare text node — inside
 *  their wrapper `<div>` ("Chapter 4566: One Too Many (Part 2)"), or at the
 *  top of a `<br>`-separated machine translation ("Chapter 1") — a copy of
 *  the chapter title the reader already shows. */
const LEADING_HEADING_RE = /^chapter\s*\d+/i;

/** Case- and punctuation-blind form of a heading, for comparing a body's
 *  first line with the chapter title. */
const headingKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Raw lines of one chapter body → the lines a reader should see. Cuts
 *  aggregator watermark sentences out of every line (dropping the line if
 *  nothing else was on it); drops site notices, bracketed credits and the
 *  MTL end marker anywhere; bare credit lines and navigation remnants among
 *  the first/last CREDIT_EDGE text lines; and a leading heading — the first text line,
 *  when it either sits outside a `<p>` and reads "Chapter N…" (the wrapper
 *  heading described above) or, in a `<p>`, is the chapter's own title
 *  again ignoring case and punctuation ("Chapter 6081, Disciplinary Hall").
 *  Any other "Chapter N" paragraph a translator wrote is left alone. */
export function chapterLinesFrom(raw: RawLine[], chapterTitle = ""): SourceLine[] {
  const titleKey = headingKey(chapterTitle);
  const textAt = raw.flatMap((l, i) => (l.type === "text" ? [i] : []));
  const edges = new Set([...textAt.slice(0, CREDIT_EDGE), ...textAt.slice(-CREDIT_EDGE)]);
  const lines: SourceLine[] = [];
  raw.forEach((line, i) => {
    if (line.type === "image") {
      lines.push({ type: "image", content: line.content });
      return;
    }
    const text = stripWatermarks(line.content);
    if (!text) return;
    if (i === textAt[0]) {
      if (!line.inParagraph && LEADING_HEADING_RE.test(text)) return;
      if (titleKey && headingKey(text) === titleKey) return;
    }
    if (SITE_NOTICE_RES.some((re) => re.test(text))) return;
    if (BRACKETED_CREDIT_RE.test(text)) return;
    if (edges.has(i) && (BARE_CREDIT_RE.test(text) || NAV_RE.test(text))) return;
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

/** "OnGoing" (novel page) and "ongoing" (listings) are the same status;
 *  render both as "Ongoing". Unknown values pass through capitalised. */
export function normalizeStatus(status: unknown): string | undefined {
  const s = sanitizeText(str(status)).toLowerCase();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : undefined;
}

/** The API's chapter list → reading-order SourceChapters. The API sends
 *  newest first; reversed here. Direction is checked rather than assumed
 *  where the rows carry numbers: if the first row's number is already the
 *  smaller one, the list is left as is. Ids are 1-based positions, not
 *  the site's `number` — that is 0 for Martial Peak's first chapter and
 *  can repeat or skip, which an id must never do. */
export function parseChapterList(
  body: string,
  listUrl: string,
  status: number,
  fallbackTitle: (n: number) => string,
): SourceChapter[] {
  if (status < 200 || status >= 300) {
    throw new Error(`novelbuddy: chapter list ${listUrl} answered HTTP ${status}.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`novelbuddy: chapter list ${listUrl} did not return JSON (HTTP ${status}).`);
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
  const chapters: SourceChapter[] = [];
  for (const row of ordered) {
    const url = absoluteUrl(str(row.url), BASE_URL);
    if (seen.has(url)) continue;
    seen.add(url);
    const n = chapters.length + 1;
    chapters.push({ id: n, title: sanitizeText(str(row.name)) || fallbackTitle(n), url, lines: [] });
  }
  return chapters;
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
 *  - `meta` rows are only emitted for values the page actually has. */
export function buildNovel(
  manga: Json,
  chapters: SourceChapter[],
  t: ReturnType<typeof strings>,
): SourceNovel {
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
  if (rating) {
    const count = manga.ratingsCount;
    meta.push({
      label: t("metaRating"),
      value: typeof count === "number" && count > 0 ? `${rating} (${count})` : rating,
    });
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
    status: normalizeStatus(manga.status),
    meta,
    volumes: [{ id: 1, title: t("allChapters"), chapters, chapterCount: chapters.length }],
  };
}

export default function createSource(host: SourceHost): Source {
  const t = strings(host.locale);
  const fallbackTitle = (n: number) => t("chapterFallback", { n });

  /** Chapter lists by slug, most recent last, for searchChapters. Closure
   *  state, not module state: two Source instances never share it. */
  const chapterCache = new Map<string, SourceChapter[]>();
  const remember = (slug: string, chapters: SourceChapter[]) => {
    chapterCache.delete(slug);
    chapterCache.set(slug, chapters);
    while (chapterCache.size > CHAPTER_CACHE_SIZE) {
      chapterCache.delete(chapterCache.keys().next().value as string);
    }
  };

  /** host.fetch with ONE immediate retry when the request throws (network
   *  error) or answers 5xx. The site is slow and flaky under plain load —
   *  measured 1–21 s per page, an occasional 60 s stall, and the odd TLS
   *  "connection reset by peer" — and one dropped request would otherwise
   *  fail a chapter in the middle of a long import. 4xx answers are not
   *  retried: they are the site's real answer. No back-off delay: timers
   *  are not something an extension can count on having. */
  async function get(url: string): Promise<FetchResponse> {
    try {
      const resp = await host.fetch(url);
      if (resp.status < 500) return resp;
      host.log("debug", `novelbuddy: ${url} answered HTTP ${resp.status}; retrying once.`);
    } catch (err) {
      host.log(
        "debug",
        `novelbuddy: ${url} failed (${err instanceof Error ? err.message : String(err)}); retrying once.`,
      );
    }
    return host.fetch(url);
  }

  async function loadNovelPage(slug: string): Promise<Json> {
    const pageUrl = novelUrl(slug);
    const resp = await get(pageUrl);
    const props = readPageProps(resp, pageUrl);
    const manga = props.initialManga;
    if (!isObject(manga) || !sanitizeText(str(manga.name))) {
      const why = pageError(props);
      throw new Error(
        `novelbuddy: ${pageUrl} carried no novel data (pageProps.initialManga)${why ? `: ${why}` : ""}.`,
      );
    }
    return { ...manga, id: str(manga.id) || str(props.mangaHsid) };
  }

  async function loadChapters(slug: string, manga: Json): Promise<SourceChapter[]> {
    const titleId = str(manga.id);
    if (!/^[A-Za-z0-9]+$/.test(titleId)) {
      throw new Error(`novelbuddy: ${novelUrl(slug)} carried no usable title id (got "${titleId}").`);
    }
    const listUrl = chapterListUrl(titleId, manga.cv);
    const resp = await get(listUrl);
    const chapters = parseChapterList(resp.text, listUrl, resp.status, fallbackTitle);

    const stats = isObject(manga.stats) ? manga.stats : {};
    const expected = stats.chaptersCount;
    if (typeof expected === "number" && expected !== chapters.length) {
      host.log(
        "warn",
        `novelbuddy: ${novelUrl(slug)} reports ${expected} chapters but the chapter list returned ${chapters.length}.`,
      );
    }
    remember(slug, chapters);
    return chapters;
  }

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
      const resp = await get(pageUrl);
      const props = readPageProps(resp, pageUrl);
      return parseHomeSections(resp.text, props, pageUrl);
    },

    async search(query: string, page = 1): Promise<SourceSearchResult> {
      const trimmed = query.trim();
      const pageNo = Number.isInteger(page) && page >= 1 ? page : 1;
      if (!trimmed) return { cards: [], hasMore: false, query: trimmed, page: pageNo };

      const url = searchUrl(trimmed, pageNo);
      host.log("info", `search(${trimmed}) page ${pageNo} -> ${url}`);
      const resp = await get(url);
      const props = readPageProps(resp, url);
      const items = props.ssrItems;
      if (!Array.isArray(items)) {
        throw new Error(`novelbuddy: search page ${url} carried no results list (pageProps.ssrItems).`);
      }
      const cards = items.map(cardFor).filter((c): c is NovelCard => c !== null);
      const pagination = isObject(props.ssrPagination) ? props.ssrPagination : {};
      const hasMore =
        typeof pagination.has_next === "boolean"
          ? pagination.has_next
          : typeof pagination.total_pages === "number" && pageNo < pagination.total_pages;
      return { cards, hasMore: hasMore && cards.length > 0, query: trimmed, page: pageNo };
    },

    async getNovel(url: string): Promise<SourceNovel> {
      const slug = slugFromUrl(url);
      host.log("info", `getNovel(${novelUrl(slug)})`);
      const manga = await loadNovelPage(slug);
      const chapters = await loadChapters(slug, manga);
      return buildNovel(manga, chapters, t);
    },

    /** In-novel chapter search. The site has no chapter-search endpoint,
     *  but getNovel already holds the whole list (one API response), so
     *  this filters that list by case-insensitive substring of the title.
     *  If getNovel hasn't run for this novel in this session (or its list
     *  was evicted), the list is fetched again the same way. */
    async searchChapters(url: string, query: string): Promise<SourceChapter[]> {
      const needle = sanitizeText(query).toLowerCase();
      if (!needle) return [];
      const slug = slugFromUrl(url);
      host.log("info", `searchChapters(${novelUrl(slug)}, ${needle})`);
      let chapters = chapterCache.get(slug);
      if (!chapters) chapters = await loadChapters(slug, await loadNovelPage(slug));
      return chapters
        .filter((c) => c.title.toLowerCase().includes(needle))
        .map((c) => ({ ...c, lines: [] }));
    },

    async getChapterContent(chapter: SourceChapter): Promise<SourceLine[]> {
      const url = canonicalChapterUrl(chapter.url);
      // debug, not info: one call per chapter of an import.
      host.log("debug", `getChapterContent(${url})`);
      const resp = await get(url);
      const props = readPageProps(resp, url);
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
