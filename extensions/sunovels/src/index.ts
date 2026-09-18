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
// `canHandle`, `slugFromUrl`, `getNovel`, `getVolumeChapters` and now
// `getChapterContent` are implemented. `getHomeSections` and `search`
// still throw "not implemented"; implement them one at a time against
// this manifest's `baseUrl`, replacing the matching stub assertion in
// the sibling tests/sunovels.test.ts file as you go.
import {
  absoluteUrl,
  parseHtml,
  sanitizeText,
  SourceUrlError,
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
  if (!m) throw new SourceUrlError(`Sun Novels: ${url} is not a novel page URL.`);
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
      `Sun Novels: couldn't find a novel title on ${pageUrl} (.main-head is missing or empty) — the layout may have changed, or this wasn't a real novel page.`,
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
      `Sun Novels: couldn't find the chapter list on ${pageUrl} (.chaptersList is missing) — the layout may have changed, or this page was blocked/errored despite an HTTP 200.`,
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
      `Sun Novels: couldn't find the chapter body (.chapter-content) on ${chapterUrl} — the layout may have changed, or this page was blocked/errored despite an HTTP 200.`,
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
      `Sun Novels: chapter body (.chapter-content) at ${chapterUrl} parsed to zero lines of real text.`,
    );
  }

  return lines;
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
      throw new Error("not implemented");
    },

    async search(_query: string, _page?: number): Promise<SourceSearchResult> {
      // If the site renders every match on one page, ignore _page and
      // always return hasMore: false — see the README's note on
      // extensions/kolnovel for why that is correct, not lazy.
      throw new Error("not implemented");
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
        host.log("info", `getVolumeChapters(${novelUrl}) page ${page}/${totalPages - 1}`);
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
      host.log("info", `getChapterContent(${chapter.url})`);
      const resp = await host.fetch(chapter.url);
      return parseChapterLines(parseHtml(resp.text), chapter.url);
    },
  };
}
