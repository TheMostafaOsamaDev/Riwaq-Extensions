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
// `canHandle`, `slugFromUrl` and now `getNovel` are implemented.
// `getHomeSections`, `search` and `getChapterContent` still throw "not
// implemented"; implement them one at a time against this manifest's
// `baseUrl`, replacing the matching stub assertion in the sibling
// tests/sunovels.test.ts file as you go.
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
} from "@riwaq/extension-api";
import { strings } from "./strings";

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

    async getChapterContent(_chapter: SourceChapter): Promise<SourceLine[]> {
      throw new Error("not implemented");
    },
  };
}
