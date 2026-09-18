// Sun Novels (شمس الروايات) source — sunovels.com. An Arabic site hosting
// translated and original web novels.
//
// Unlike its sibling extensions/cenele or extensions/kolnovel, this site
// has no JSON API to speak of: every `/api/*` path 404s and its `/dev`
// route is a changelog, not documentation. Everything here is scraped
// from server-rendered HTML.
//
// A trap worth recording before anyone reaches for `document.querySelector`
// on this site: a novel page's FIRST `<h1>` is the site name, not the
// novel's title (`h1 -> ["شمس الروايات", "Shadow Slave"]`, `h3 ->
// ["عبد الظل"]`). An unscoped `querySelector("h1")` would title every card
// after the website. Selectors that reach for the novel's own headings
// scope to `.main-head h1` / `.main-head h3` for exactly this reason — and
// on THIS site `h1` is the original-language title and `h3` is the Arabic
// one, the inverse of extensions/seanovel. Do not carry that assumption
// across.
//
// `canHandle`, `slugFromUrl`, `getNovel`, `getVolumeChapters`,
// `getChapterContent`, `getHomeSections` and `search` are all implemented.
//
// `getHomeSections` reads the homepage (`/`) — NOT `/library` — because
// `/` is the page that actually carries titled `section.home-section`
// blocks (e.g. "أشهر الروايات", "روايات كورية", "أحدث الفصول"); `/library`
// itself is one flat, paginated grid with no section concept at all. See
// parseHomeSections below and the README.
//
// `search` hits the site's own `/search` page with `?title=<query>` — the
// one param shape (of five tried, driving the live search FORM rather than
// guessing at names) that actually renders results server-side. It's a
// single request: the results page has no pagination of its own (no
// numeric pager, `&page=` has no effect), so `hasMore` is always `false`,
// the same convention extensions/kolnovel uses for the identical shape.
// See searchUrl/parseSearchResults below and the README for the other four
// params tried and what each one returned.
//
// Every card grid this site renders — home sections, /library, search
// results alike — serves its cover images lazy-loaded: the STATIC markup
// `host.fetch` sees always carries `src="/placeholder.gif"` for a card's
// `<img>`. The real `/uploads/...` path IS present, per card, in the
// page's inline Next.js RSC payload (confirmed live: 111/111 homepage
// hrefs paired with a payload entry, 54 of them carrying a real cover
// path; 4/4 on a search result) — `parseCoverMap` below reads it straight
// out of the raw response text with a bounded regex (the same technique
// `parseChaptersCount` already uses on this same payload), rather than
// doing a real JSON.parse of the Flight wire format — and `getHomeSections`/
// `search` apply it to every card they return, keyed by the card's own
// href. See parseCoverMap's own comment and the README's "cover gap"
// section for the exact evidence this was built from.
import {
  absoluteUrl,
  parseHtml,
  sanitizeText,
  SourceUrlError,
  type NovelCard,
  type Source,
  type SourceChapter,
  type SourceHost,
  type SourceLine,
  type SourceNovel,
  type SourceSearchResult,
  type SourceSection,
  type SourceVolume,
} from "@riwaq/extension-api";
import { strings } from "./strings";

/** The chapter-list tab serves exactly 50 rows per page — measured
 *  directly against the live site, scoped to `.chaptersList`. */
const PER_PAGE = 50;

// Exported so the later tasks that build getHomeSections/search/getNovel/
// getChapterContent against this manifest's baseUrl (all landing in this
// same file) have one source of truth for it, matching how it's used here.
export const BASE_URL = "https://sunovels.com";
const HOSTS = new Set(["sunovels.com", "www.sunovels.com"]);

/** Both `/novel/<slug>` and `/novel/<slug>/<n>` yield <slug>. */
export function slugFromUrl(url: string): string {
  const m = new URL(url).pathname.match(/^\/novel\/([^/]+)/);
  if (!m) throw new SourceUrlError(`sunovels: ${url} is not a novel page URL.`);
  return decodeURIComponent(m[1]);
}

/** The site streams a Next.js RSC payload inline (a `self.__next_f.push(...)`
 *  script whose argument is itself a JSON-escaped string), and that payload
 *  — not the rendered markup anywhere on the page — carries the novel's
 *  authoritative chapter count. Regexing the raw HTML for it is cheaper and
 *  more robust than trying to locate and JSON.parse the right push() call.
 *
 *  Critically, this is NOT the same number as the highest chapter number
 *  the novel has: chapter numbering is sparse (this extension's example
 *  novel reports 1582 chapters whose newest is numbered 1611), so nothing
 *  downstream may assume `chaptersCount` chapters means chapters `1..count`
 *  exist, or that this count equals the last chapter's number.
 *
 *  Residual assumption: this takes the FIRST `chaptersCount` match
 *  anywhere in the raw HTML, unscoped to this novel's own RSC payload
 *  chunk. Every fixture captured so far has exactly one occurrence, so
 *  this hasn't been shown wrong — but if a future page ever streams a
 *  second novel's data alongside this one (a "related novels" rail with
 *  its own count, say), this would need to scope to the chunk that also
 *  contains this novel's own slug/title instead of matching blindly. */
export function parseChaptersCount(html: string): number {
  const m = html.match(/chaptersCount\\?":\s*(\d+)/);
  return m ? Number.parseInt(m[1], 10) : 0;
}

interface ParsedNovelPage {
  title: string;
  originalTitle?: string;
  coverUrl?: string;
  tags: string[];
}

/** Scoped to `.main-head h1` / `.main-head h3` rather than a bare
 *  `h1`/`h3` — a novel page's FIRST `<h1>` is the site's own name
 *  ("شمس الروايات" — rendered in the header's nav, outside `.main-head`
 *  entirely), not the novel's title. An unscoped `querySelector("h1")`
 *  would title every card after the website instead of the novel. Do NOT
 *  "simplify" these back to bare `h1`/`h3` selectors.
 *
 *  On THIS site `h1` is the ORIGINAL-language title and `h3` is the
 *  Arabic one — the inverse of extensions/seanovel, where `h1` is Arabic.
 *  Getting this backwards produces a plausible-looking card that is
 *  simply wrong: both fields are real title strings, so nothing type-checks
 *  or throws to catch the swap.
 *
 *  `pageUrl` is used only to name the offending page in the error below —
 *  it plays no part in parsing. */
export function parseNovelPage(doc: Document, pageUrl: string): ParsedNovelPage {
  const originalTitle = sanitizeText(doc.querySelector(".main-head h1")?.textContent) || undefined;
  const arabicTitle = sanitizeText(doc.querySelector(".main-head h3")?.textContent);
  // The Arabic title is the primary `title` field; fall back to the
  // original when a novel's page has no h3 at all (an Arabic-original
  // novel with nothing to translate FROM, going by this site's own
  // pairing convention above).
  const title = arabicTitle || originalTitle || "";

  // A missing `.main-head` — a layout change, an anti-bot interstitial or
  // an error page served with HTTP 200, a redirect that lands somewhere
  // else entirely — must not silently produce a structurally valid but
  // empty SourceNovel: that's indistinguishable from a real novel that
  // legitimately has no title, which never happens on this site. Refuse
  // loudly instead, the same way slugFromUrl refuses a non-novel URL.
  // Checking the derived `title` (rather than re-querying `.main-head`
  // separately) also catches the rarer case where the container exists
  // but both `h1` and `h3` are themselves empty.
  if (!title) {
    throw new Error(
      `sunovels: couldn't find a novel title on ${pageUrl} (.main-head is missing or empty) — the layout may have changed, or this wasn't a real novel page.`,
    );
  }

  const coverSrc = doc.querySelector("figure.cover img")?.getAttribute("src") || undefined;
  const coverUrl = coverSrc ? absoluteUrl(coverSrc, BASE_URL) : undefined;

  const tags = Array.from(doc.querySelectorAll("a.tag"))
    .map((a) => sanitizeText(a.textContent))
    .filter((s) => s.length > 0);

  return { title, originalTitle, coverUrl, tags };
}

/** `page` is 0-indexed — the site's own pagination starts at 0, and a
 *  1-indexed guess would silently skip the first fifty chapters of every
 *  novel. Measured directly against the live site, scoped to
 *  `.chaptersList`: `page=0` returns chapters 1-50, `page=1` returns
 *  51-100. */
export function chapterPageUrl(slug: string, page: number): string {
  return `${BASE_URL}/novel/${slug}?activeTab=chapters&page=${page}`;
}

/** Rows are read from `.chaptersList` ONLY. The page header links the
 *  first and newest chapters on EVERY page (a `nav.header-links` pair
 *  plus a `.intro` "last chapter you read" link) — collecting anchors
 *  from the whole document instead of this container would duplicate
 *  those into all ~32 pages of a long novel. `seen` also de-duplicates
 *  within this one page's rows, defensively, though the site has not
 *  been observed to repeat a row inside `.chaptersList` itself.
 *
 *  A MISSING container and an EMPTY one are deliberately told apart:
 *
 *  - `.chaptersList` present but with no matching rows means this page
 *    genuinely has no more chapters (the real end of the list) — return
 *    `[]`, and `getVolumeChapters`'s loop stops there, as intended.
 *  - `.chaptersList` absent entirely means this response is not a
 *    chapter-listing page at all — the same 200-status "blocked" shape
 *    `getNovel`'s own tests exercise for `.main-head`. Returning `[]`
 *    here would be indistinguishable from a real end-of-list to
 *    `getVolumeChapters`, silently truncating the chapter list at
 *    whichever page happened to be blocked (a transient anti-bot
 *    response or CDN hiccup on page 12 of 32 would quietly cut a
 *    1500+-chapter novel down to ~550, with nothing anywhere saying so).
 *    Throw instead, naming the offending page URL — the same principle
 *    as `parseNovelPage`'s guard on a missing `.main-head`. */
export function parseChapterRows(doc: Document, slug: string, pageUrl: string): SourceChapter[] {
  const list = doc.querySelector(".chaptersList");
  if (!list) {
    throw new Error(
      `sunovels: couldn't find the chapter list on ${pageUrl} (.chaptersList is missing) — the layout may have changed, or this page was blocked/errored despite an HTTP 200.`,
    );
  }
  const out: SourceChapter[] = [];
  const seen = new Set<string>();
  for (const a of Array.from(list.querySelectorAll(`a[href^="/novel/${slug}/"]`))) {
    const href = a.getAttribute("href");
    if (!href || seen.has(href)) continue;
    const num = Number.parseInt(href.split("/").pop() ?? "", 10);
    if (!Number.isFinite(num)) continue;
    const title = sanitizeText(a.querySelector(".chapter-title")?.textContent ?? a.textContent);
    if (!title) continue;
    seen.add(href);
    out.push({ id: num, title, url: absoluteUrl(href, BASE_URL), lines: [] });
  }
  return out;
}

/** Scoped to `.chapter-content` — the chapter body container on a chapter
 *  page.
 *
 *  The site salts every real paragraph in `.chapter-content` with a
 *  matching decoy sibling, `<p class="d-none">` — a scraper trap, not
 *  real content, invisible on the rendered page (`d-none` is a
 *  `display: none` utility class) but sitting right in the markup a
 *  naive `querySelectorAll("p")` would collect right along with the real
 *  text. In the fixture captured for this task the split was close to
 *  1:1 (94 real paragraphs to 95 decoys): an implementation that didn't
 *  filter these out wouldn't just add a little noise, it would roughly
 *  double the chapter's line count and interleave garbage into every
 *  other line. Every real paragraph observed on this site so far is a
 *  bare `<p>` with no attributes at all, so `classList.contains("d-none")`
 *  cleanly tells the two apart without needing to inspect content.
 *
 *  A handful of real (non-decoy) paragraphs are themselves genuinely
 *  empty (`<p></p>`, a blank-line spacer between scenes) — sanitizeText
 *  plus the `if (content)` check below drops those the same way a
 *  missing textContent would, so they never surface as blank lines the
 *  reader would render as visible gaps.
 *
 *  `chapterUrl` names the offending page in both error messages below;
 *  it plays no part in parsing. */
export function parseChapterLines(doc: Document, chapterUrl: string): SourceLine[] {
  const root = doc.querySelector(".chapter-content");
  if (!root) {
    throw new Error(
      `sunovels: couldn't find the chapter body (.chapter-content) on ${chapterUrl} — the layout may have changed, or this page was blocked/errored despite an HTTP 200.`,
    );
  }

  const lines: SourceLine[] = [];
  for (const p of Array.from(root.querySelectorAll("p"))) {
    if (p.classList.contains("d-none")) continue; // decoy paragraph — see above
    const content = sanitizeText(p.textContent);
    if (content) lines.push({ type: "text", content });
  }

  // A container that's present but yields no real text lines (every
  // paragraph was a decoy, or the real ones were all empty) is the same
  // failure mode as a missing container entirely: the reader would
  // silently render a blank chapter, indistinguishable from the site
  // legitimately having nothing here. Refuse loudly instead, the same
  // way parseNovelPage and parseChapterRows already do for their own
  // containers.
  if (lines.length === 0) {
    throw new Error(
      `sunovels: chapter body (.chapter-content) at ${chapterUrl} parsed to zero lines of real text.`,
    );
  }

  return lines;
}

// ── home sections + search: shared card extraction ─────────────────────

/** Placeholder `src` every lazy-loaded cover image on this site's card
 *  grids carries in the server-rendered HTML, before client JS swaps in
 *  the real image. It is NOT a real cover — see the comment on
 *  `parseCardAnchor` below for why nothing here can do better than this
 *  without executing JS. */
const LAZY_PLACEHOLDER_SRC = "/placeholder.gif";

/** Builds one `NovelCard` from a single `a[href^="/novel/"]` anchor, or
 *  returns null if this anchor cannot contribute a card on its own.
 *
 *  Two facts drive this, both measured against the live homepage:
 *
 *  - A **chapter** link (`/novel/<slug>/<n>`) has three path segments,
 *    not two; `href` is checked for exactly two so chapter anchors (the
 *    homepage's "أحدث الفصول"/"latest chapters" rail links each novel's
 *    newest chapter alongside the novel itself) are never mistaken for a
 *    card.
 *  - Some cards are split across TWO anchors sharing the same href: that
 *    same "أحدث الفصول" rail wraps its cover image in one bare
 *    `<a class="cover" href="...">` with no heading at all, and the
 *    title in a SEPARATE `<a href="...">` immediately after it. An
 *    anchor with no heading inside it cannot name a card — returning
 *    null here (rather than a card with an empty title) lets the caller
 *    skip it and pick up the sibling anchor that DOES carry the heading
 *    instead, rather than emitting a title-less card.
 *
 *  Cover images on every card grid this site renders are lazy-loaded:
 *  the static HTML `host.fetch` sees always carries
 *  `src="/placeholder.gif"` (confirmed against the live homepage and
 *  /library — none of their card images resolve to a real `/uploads/...`
 *  path without running client JS), unlike a novel's own detail page
 *  whose hero cover is not lazy. Treating the placeholder as "no cover"
 *  (`undefined`, same as a card whose anchor has no `<img>` at all) is
 *  deliberate: NovelCard.coverUrl documents that some layouts don't
 *  surface a cover, and a real image is worth waiting for over shipping
 *  every card with the literal placeholder gif. */
export function parseCardAnchor(a: Element): NovelCard | null {
  const href = a.getAttribute("href");
  if (!href) return null;
  const segments = href.split(/[?#]/)[0].split("/").filter(Boolean);
  if (segments.length !== 2 || segments[0] !== "novel") return null;

  const title = sanitizeText(a.querySelector("h2, h3, h4")?.textContent);
  if (!title) return null;

  const coverSrc = a.querySelector("img")?.getAttribute("src") || undefined;
  const coverUrl =
    coverSrc && coverSrc !== LAZY_PLACEHOLDER_SRC ? absoluteUrl(coverSrc, BASE_URL) : undefined;

  return { url: absoluteUrl(href, BASE_URL), title, coverUrl };
}

/** Collects one `NovelCard` per distinct novel `href` under `root`, in
 *  document order. `seen` is keyed by the card's own (absolutised) URL,
 *  not the raw `href`, and is only marked once `parseCardAnchor` actually
 *  produces a card — an anchor that returns null (see above) never
 *  blocks its sibling anchor for the same novel from contributing the
 *  card afterwards. */
export function collectNovelCards(root: ParentNode): NovelCard[] {
  const seen = new Set<string>();
  const cards: NovelCard[] = [];
  for (const a of Array.from(root.querySelectorAll('a[href^="/novel/"]'))) {
    const card = parseCardAnchor(a);
    if (!card || seen.has(card.url)) continue;
    seen.add(card.url);
    cards.push(card);
  }
  return cards;
}

// ── cover extraction from the inline RSC payload ────────────────────────

/** Matches one `\"href\":\"/novel/<slug>\"` occurrence exactly as it sits
 *  in the raw response text — i.e. still JSON-string-escaped, because
 *  this text is itself the argument of a `self.__next_f.push(...)` call,
 *  not something already unescaped. Confirmed against home.html: every
 *  occurrence of this shape is escaped this way; there is no unescaped
 *  `"href":"/novel/` anywhere on the page (the rendered DOM anchors use
 *  `href="/novel/..."`, a completely different, non-JSON shape, so the
 *  two can never be confused). */
const PAYLOAD_HREF_RE = /\\"href\\":\\"(\/novel\/[^"\\]*)\\"/g;

/** Matches the FIRST real cover path inside whatever window it's given —
 *  see parseCoverMap below for how that window is chosen per href. */
const PAYLOAD_SRC_RE = /\\"src\\":\\"(\/uploads\/[^"\\]*)\\"/;

/** Reads every card's cover straight out of the page's inline Next.js RSC
 *  payload, keyed by the card's own (absolutized) URL — the one thing the
 *  static, lazy-loaded DOM markup can never supply (see the file header
 *  and `parseCardAnchor`'s own comment on `LAZY_PLACEHOLDER_SRC`).
 *
 *  How a cover is associated with its card, established directly against
 *  home.html and search.html rather than assumed: every occurrence of
 *  `\"href\":\"/novel/<slug>\"` in the payload owns, at most, ONE nearby
 *  `\"src\":\"/uploads/...\"` — and that `src`, when it exists, is always
 *  emitted strictly BETWEEN this href occurrence and whichever `href`
 *  token comes textually NEXT in the payload, never further out. Two
 *  shapes were observed to produce this:
 *
 *   - An ordinary grid card: one `href` object whose own `children` opens
 *     with the `$L25` image element carrying `src`, immediately followed
 *     by the title. The `src` sits a few dozen characters after `href`.
 *   - The homepage's "أحدث الفصول" rail, which — exactly like the DOM it
 *     renders (see `parseCardAnchor`) — splits ONE novel across TWO
 *     separate payload objects sharing the identical `href`: a
 *     `"className":"cover"` object carrying only the image (with `src`),
 *     immediately followed by a second, plain object carrying only the
 *     title (no `src` at all). Whichever of the pair
 *     is scanned first, this function's own per-occurrence loop (below)
 *     keeps looking at LATER occurrences of the same href until one
 *     actually yields a `src`, rather than latching onto the first
 *     occurrence regardless of whether it had one — so it doesn't matter
 *     which of the two anchors the payload happens to emit first.
 *
 *  This is a bounded regex walk over the raw text, not a real parse of
 *  the Flight wire format — `parseChaptersCount` already established
 *  that as an acceptable technique against this exact payload, for the
 *  same reason: a real parse would mean reimplementing enough of
 *  Next.js's `self.__next_f.push` chunk-reassembly and `$L<n>` reference
 *  resolution to walk a full parsed tree, for a value (a cosmetic cover
 *  image) that this extension can safely ship as `undefined` on any
 *  format drift. The bounded window — never look past the next `href`
 *  token — is what keeps this from degrading into "nearest src anywhere
 *  on the page", which would risk stitching a totally unrelated card's
 *  image onto this one; verified exhaustively (not sampled) against both
 *  real fixtures: every slug this resolves a cover for is also a slug
 *  `collectNovelCards` actually renders as a card, and vice versa (52/52
 *  distinct cards on the homepage, 4/4 on a search result — see the test
 *  suite's own fixture-derived counts, not a hardcoded figure here).
 *
 *  A three-segment href (`/novel/<slug>/<n>`, a chapter link — the same
 *  shape `parseCardAnchor` itself excludes) never becomes a map key, even
 *  if a `src` happens to sit in its own window: chapter-rail entries are
 *  not cards, and letting one in could only ever shadow — never help —
 *  the novel's own real card entry.
 *
 *  A slug with no `src` anywhere in ANY of its occurrences' windows keeps
 *  no entry in the returned map at all. Callers must treat "no entry" the
 *  same way `parseCardAnchor` treats a placeholder or missing `<img>`:
 *  `coverUrl: undefined`, never a thrown error and never a dropped card —
 *  a cover is decorative, a card is not. */
export function parseCoverMap(html: string): Map<string, string> {
  const matches = Array.from(html.matchAll(PAYLOAD_HREF_RE));
  const map = new Map<string, string>();
  for (let i = 0; i < matches.length; i++) {
    const href = matches[i][1];
    const segments = href.split("/").filter(Boolean);
    if (segments.length !== 2) continue; // a chapter href, not a card

    // Keyed by the card's own ABSOLUTE url — same shape as NovelCard.url
    // — rather than the raw relative `href`, so callers (`withCover`) can
    // look this up with the exact value a card already carries instead
    // of re-deriving a relative path from it. Checked (and compared
    // against below) in this same absolute form — comparing the MAP's
    // own keys against the raw relative `href` here would make this
    // guard a no-op, since the map never holds a relative key.
    const absHref = absoluteUrl(href, BASE_URL);
    if (map.has(absHref)) continue; // an earlier occurrence already resolved a src

    const windowStart = matches[i].index! + matches[i][0].length;
    const windowEnd = i + 1 < matches.length ? matches[i + 1].index! : html.length;
    const srcMatch = PAYLOAD_SRC_RE.exec(html.slice(windowStart, windowEnd));
    if (srcMatch) {
      map.set(absHref, absoluteUrl(srcMatch[1], BASE_URL));
    }
  }
  return map;
}

/** Applies `coverMap` to a card that doesn't already have a `coverUrl` of
 *  its own (defensive — every card `collectNovelCards` produces today has
 *  none, see `LAZY_PLACEHOLDER_SRC`, but this never overwrites a real one
 *  if that ever changes). A miss is not an error: it leaves `coverUrl`
 *  exactly as it was (`undefined`), never drops the card. */
function withCover(card: NovelCard, coverMap: Map<string, string>): NovelCard {
  return card.coverUrl ? card : { ...card, coverUrl: coverMap.get(card.url) };
}

/** Ruling: a cover is decorative, a card is not — the one place in this
 *  extension where "refuse loudly" does NOT apply. `parseCoverMap` is a
 *  bounded regex over plain text and cannot itself throw on any string
 *  input, but this still wraps it in `try`/`catch` as defense-in-depth
 *  against a payload shape change breaking that assumption; either way,
 *  the caller gets back a plain (possibly empty) map, never a rejection.
 *
 *  An empty map — the payload carried no image at all, whether because
 *  the page was blocked/errored despite an HTTP 200, or a future layout
 *  change moved the `src`/`href` pairing this depends on — is logged
 *  once via `host.log("warn", ...)`, naming the page, so silently
 *  cover-less cards show up somewhere instead of just being a quieter
 *  homepage with nothing anywhere saying so. Callers only reach for this
 *  when there is at least one card to decorate; an empty results page
 *  (a genuine "nothing matched" search) has nothing to warn about and
 *  skips this entirely — see `search` below. */
function coverMapOrWarn(html: string, pageUrl: string, host: SourceHost): Map<string, string> {
  try {
    const coverMap = parseCoverMap(html);
    if (coverMap.size === 0) {
      host.log(
        "warn",
        `sunovels: found no cover images in the RSC payload on ${pageUrl} — every card here will have coverUrl: undefined.`,
      );
    }
    return coverMap;
  } catch (err) {
    host.log(
      "warn",
      `sunovels: failed to read covers out of the RSC payload on ${pageUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return new Map();
  }
}

/** Collapse a heading into a stable, printable id fragment: keep letters
 *  and digits of ANY script (these headings are Arabic) and turn every run
 *  of anything else into one dash. */
function slugify(text: string): string {
  return text
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

/** A section's `id`, derived from WHAT THE SECTION IS rather than from
 *  where it happened to land in the list.
 *
 *  `SourceSection.id` is contracted to be a stable identifier useful for
 *  caching (see @riwaq/extension-api). A document-order `home-${idx}` —
 *  which this used to emit, computed AFTER empty sections were filtered
 *  out — is not: it reindexes every section below any row that happened to
 *  render zero cards on a given run, so yesterday's `home-2` is today's
 *  `home-1` and every cache keyed on it is silently wrong. extensions/
 *  cenele abandoned exactly this scheme for exactly this reason.
 *
 *  Preferred key is the `category` param of the section's own "المزيد"
 *  link (`/library?category=كوري`), which is the site's own name for what
 *  the row contains. Sections with no category link (the "most popular"
 *  rail links a bare `/library`; the "latest chapters" rail links nothing
 *  at all) fall back to a slug of their heading — still tied to the
 *  section's identity rather than to its position. */
export function sectionIdFor(title: string, viewMoreHref: string | null | undefined): string {
  if (viewMoreHref) {
    try {
      const category = new URL(viewMoreHref, BASE_URL).searchParams.get("category");
      if (category) return `category-${slugify(category)}`;
    } catch {
      // A malformed href is not worth failing a homepage over — fall
      // through to the title slug below.
    }
  }
  return slugify(title) || "section";
}

/** Two sections could in principle derive the same key (two rails with the
 *  same heading, or the same category linked twice). Ids must stay
 *  distinct within one response, so a collision gets a numeric suffix —
 *  deterministic, and only ever affecting the duplicate. */
function uniqueSectionId(base: string, used: Set<string>): string {
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
}

/** Scoped to `section.home-section` — the homepage renders each themed
 *  row ("أشهر الروايات", "روايات إثارة", "روايات يابانية", "روايات كورية",
 *  "أحدث الفصول" as of this task) as one of these, in document order.
 *  `/library` (the page a naive reading of "browse novels" might reach
 *  for) is a DIFFERENT page entirely: one flat, paginated grid with no
 *  section headings of its own — see the file header and README. Each
 *  section's own title comes from `.section-header h3`, deliberately
 *  scoped rather than a bare `h3`: a card inside "أحدث الفصول" also uses
 *  `<h3>` for its own title (see parseCardAnchor), and an unscoped
 *  `sec.querySelector("h3")` would happen to still find the section's own
 *  heading first by document order today, but only by luck — a future
 *  markup change that moved the section header after its body would
 *  silently retitle every "أحدث الفصول" section after its first card.
 *  `viewMoreUrl` reads the section header's own "المزيد" (more) link,
 *  when the section has one (e.g. "أحدث الفصول" doesn't).
 *
 *  A page with NO recognizable sections at all — a layout change, an
 *  anti-bot interstitial, or an error page served with HTTP 200 — must
 *  not silently produce `[]`: that's indistinguishable from every
 *  section legitimately having no cards, which the live site has never
 *  been observed to do. Refuse loudly instead, naming the offending
 *  page, the same principle `parseNovelPage`/`parseChapterRows`/
 *  `parseChapterLines` already apply to their own containers.
 *
 *  A single BAD section — present, but with no title or that parsed to
 *  zero cards — is a different, more survivable failure: dropping it
 *  keeps the rest of the homepage usable instead of taking down every
 *  other row over one markup change to a single rail. It is NOT silent,
 *  though — `host.log("warn", ...)` names which section was skipped and
 *  why, so a layout drift shows up in logs instead of just quietly
 *  shrinking the homepage with nothing anywhere saying so. `host` is
 *  threaded in for exactly this (this function is otherwise a pure DOM
 *  reader) — the same shape `extensions/kolnovel`'s own
 *  `parseHomeSections(doc, baseUrl, host)` already takes. */
export function parseHomeSections(doc: Document, pageUrl: string, host: SourceHost): SourceSection[] {
  const sections: SourceSection[] = [];
  const usedIds = new Set<string>();
  for (const sec of Array.from(doc.querySelectorAll("section.home-section"))) {
    const title = sanitizeText(sec.querySelector(".section-header h3")?.textContent);
    if (!title) {
      host.log(
        "warn",
        `sunovels: skipped a home section on ${pageUrl} with no title (.section-header h3 missing or empty).`,
      );
      continue;
    }
    const body = sec.querySelector(".section-body");
    const cards = body ? collectNovelCards(body) : [];
    if (cards.length === 0) {
      host.log("warn", `sunovels: skipped home section "${title}" on ${pageUrl} — parsed to zero cards.`);
      continue;
    }
    const viewMoreHref = sec
      .querySelector('.section-header a[href^="/library"]')
      ?.getAttribute("href");
    sections.push({
      id: uniqueSectionId(sectionIdFor(title, viewMoreHref), usedIds),
      title,
      cards,
      viewMoreUrl: viewMoreHref ? absoluteUrl(viewMoreHref, BASE_URL) : undefined,
    });
  }

  if (sections.length === 0) {
    throw new Error(
      `sunovels: no home sections found on ${pageUrl} (section.home-section is missing, or every section had no title or no cards) — the layout may have changed, or this page was blocked/errored despite an HTTP 200.`,
    );
  }
  return sections;
}

// ── search ───────────────────────────────────────────────────────────────

/** The site's own search form posts here as `?title=<query>` — found by
 *  driving the live search input directly (`fill` + `Enter`) and reading
 *  the URL it produced, not by guessing at a param name. `q`/`query`/`s`/
 *  `term` (the brief's own candidate list) were all tried first and each
 *  rendered the identical empty `<ul class="grid-list"></ul>` shell
 *  server-side regardless of value — see the README for that evidence.
 *  `title` is the one that actually returns matching novel cards from a
 *  plain `host.fetch`, no client JS required. */
export function searchUrl(query: string): string {
  return `${BASE_URL}/search?${new URLSearchParams({ title: query })}`;
}

/** Rows are read from `.searchSection ul.grid-list` — scoped past the bare
 *  `ul.grid-list` selector `/library` also uses, since a page that failed
 *  to render the search section at all should still be told apart from
 *  one that rendered it empty, the same distinction every other
 *  container in this file draws (see `parseChapterRows`, whose own
 *  comment describes this exact failure mode almost word for word): a
 *  MISSING grid means this response isn't really a search-results page
 *  (blocked/errored despite an HTTP 200) and must throw, naming the URL.
 *  A grid that's PRESENT but empty is the real, correct "nothing on the
 *  site matched this query" result (confirmed live: a query with no
 *  matches renders exactly this) and must return `[]`, never throw —
 *  that distinction is the whole reason `search()` below can return
 *  `cards: []` instead of rejecting when a query genuinely matches
 *  nothing. */
export function parseSearchResults(doc: Document, pageUrl: string): NovelCard[] {
  const list = doc.querySelector(".searchSection ul.grid-list");
  if (!list) {
    throw new Error(
      `sunovels: couldn't find the search results grid (.searchSection ul.grid-list) on ${pageUrl} — the layout may have changed, or this page was blocked/errored despite an HTTP 200.`,
    );
  }
  return collectNovelCards(list);
}

export default function createSource(host: SourceHost): Source {
  return {
    // The novel page's chapter list lives behind a paginated tab (50 rows
    // per page, dozens of pages for a long-running novel) rather than
    // being inlined in getNovel's response — see Task 3's getVolumeChapters.
    // getNovel instead returns one pseudo-volume with the total count so
    // the UI can render a "(N chapters)" badge and the right number of
    // skeleton rows before anything is expanded.
    hasLazyVolumes: true,

    canHandle(url: string): boolean {
      try {
        return HOSTS.has(new URL(url).hostname);
      } catch {
        return false;
      }
    },

    async getHomeSections(): Promise<SourceSection[]> {
      const url = `${BASE_URL}/`;
      host.log("info", "getHomeSections");
      const resp = await host.fetch(url);
      const sections = parseHomeSections(parseHtml(resp.text), url, host);
      // parseHomeSections never returns a section with zero cards (see its
      // own comment), so every section reaching this point has at least
      // one card to decorate — coverMapOrWarn is worth calling exactly
      // once here, not once per section, and re-parses the same response
      // text `parseHomeSections` already read rather than issuing another
      // request.
      const coverMap = coverMapOrWarn(resp.text, url, host);
      return sections.map((s) => ({ ...s, cards: s.cards.map((c) => withCover(c, coverMap)) }));
    },

    /** A single request to `/search?title=<query>` — see the file header
     *  for why `title` and not one of the other four params tried. The
     *  results page has no pagination of its own at all (no numeric
     *  pager anywhere in the markup, and live requests with `&page=<n>`
     *  tacked on return byte-identical results) — the same shape
     *  extensions/kolnovel's own search hits (every match on one page,
     *  no working "load more"), so `page` is ignored entirely and
     *  `hasMore` is hardcoded `false` rather than trusted from anything
     *  on the page. There is nothing here to memoise: each query is one
     *  cheap, independent request, not a multi-page scan. */
    async search(query: string): Promise<SourceSearchResult> {
      const trimmed = query.trim();
      // An empty query is not "no results" in the refuse-loudly sense
      // this extension otherwise applies to a failed parse — it is a
      // real, correct empty result (nothing to search for), so it
      // returns a hollow SourceSearchResult on purpose rather than
      // hitting the site for nothing.
      if (!trimmed) {
        return { cards: [], hasMore: false, query: trimmed, page: 1 };
      }
      const url = searchUrl(trimmed);
      host.log("info", `search(${trimmed}) -> ${url}`);
      const resp = await host.fetch(url);
      const cards = parseSearchResults(parseHtml(resp.text), url);
      // A genuine "nothing matched" result has no cards to decorate at
      // all — skip coverMapOrWarn entirely rather than warning about a
      // missing cover payload on a page that was never going to have one.
      if (cards.length === 0) {
        return { cards, hasMore: false, query: trimmed, page: 1 };
      }
      const coverMap = coverMapOrWarn(resp.text, url, host);
      return {
        cards: cards.map((c) => withCover(c, coverMap)),
        hasMore: false,
        query: trimmed,
        page: 1,
      };
    },

    async getNovel(url: string): Promise<SourceNovel> {
      const slug = slugFromUrl(url);
      host.log("info", `getNovel(${url})`);
      const resp = await host.fetch(url);
      const parsed = parseNovelPage(parseHtml(resp.text), url);

      return {
        title: parsed.title,
        // The page does not surface an author anywhere in its rendered
        // markup (verified against the live site) — "" is the deliberate
        // contract for "unknown", never a literal "Unknown"; the host
        // localises the empty case at display time.
        author: "",
        originalTitle: parsed.originalTitle,
        language: "ar",
        direction: "rtl",
        coverUrl: parsed.coverUrl,
        tags: parsed.tags,
        meta: [],
        volumes: [
          {
            id: 1,
            title: strings(host.locale)("allChapters"),
            chapters: [],
            chapterCount: parseChaptersCount(resp.text),
            // Carries the slug forward for getVolumeChapters (Task 3) to
            // rebuild the paginated chapter-list URL from, since our own
            // 1-based `id` has no relation to the site's own addressing.
            key: slug,
          },
        ],
      };
    },

    /** Walks the paginated `.chaptersList` tab from page 0, sequentially
     *  (never concurrently — 32 requests fired at once at a third-party
     *  site invites rate-limiting for no gain on a list the user is
     *  waiting to scroll), and stops as soon as a page yields no rows.
     *
     *  Page count is derived from `volume.chapterCount`
     *  (`Math.ceil(count / PER_PAGE)`, at least 1) rather than a
     *  hardcoded number — that count drifts daily as the site adds
     *  chapters, and chapter numbering itself is sparse (this
     *  extension's example novel has 1582 chapters whose newest is
     *  numbered 1611). This bounds the OVER-counting case: nothing here
     *  may assume the real list runs out exactly where `chapterCount`
     *  predicts, so the empty-page stop (see `parseChapterRows`) is what
     *  actually terminates the loop, not reaching the computed page
     *  count. It does NOT cover the opposite, UNDER-counting case — if
     *  the site has grown past what `chapterCount` reported (stale by
     *  the time this runs), the loop never attempts the later pages at
     *  all, and nothing here signals that under-fetch either.
     *
     *  The slug comes from `volume.key` (set by getNovel) rather than
     *  re-deriving it from `novelUrl`, since `key` is the value this
     *  source's own getNovel stashed there for exactly this call — see
     *  the comment on that assignment. `slugFromUrl(novelUrl)` is kept
     *  only as a fallback for a volume whose `key` is somehow absent. */
    async getVolumeChapters(novelUrl: string, volume: SourceVolume): Promise<SourceChapter[]> {
      const slug = volume.key || slugFromUrl(novelUrl);
      const totalPages = Math.max(1, Math.ceil((volume.chapterCount ?? 0) / PER_PAGE));
      const seen = new Set<string>();
      const chapters: SourceChapter[] = [];

      for (let page = 0; page < totalPages; page++) {
        const url = chapterPageUrl(slug, page);
        // debug, not info: a 1,582-chapter novel walks ~32 pages here, and
        // per-page progress at info buries everything else in the log.
        host.log("debug", `getVolumeChapters(${novelUrl}) page ${page}/${totalPages - 1}`);
        const resp = await host.fetch(url);
        // parseChapterRows throws (rather than returning []) when the
        // container is missing entirely — a blocked/errored page, not a
        // genuine end of list — so that failure propagates out of this
        // call instead of being silently treated as "no more chapters".
        const rows = parseChapterRows(parseHtml(resp.text), slug, url);
        if (rows.length === 0) break;
        for (const c of rows) {
          if (seen.has(c.url)) continue;
          seen.add(c.url);
          chapters.push(c);
        }
      }

      return chapters;
    },

    async getChapterContent(chapter: SourceChapter): Promise<SourceLine[]> {
      // debug, not info: one call per chapter of the import. Same level
      // cenele and kolnovel use.
      host.log("debug", `getChapterContent(${chapter.url})`);
      const resp = await host.fetch(chapter.url);
      return parseChapterLines(parseHtml(resp.text), chapter.url);
    },
  };
}
