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
// Only `canHandle` and the `slugFromUrl` helper are implemented so far.
// Every other method below still throws "not implemented"; implement them
// one at a time against this manifest's `baseUrl`, replacing the matching
// stub assertion in the sibling tests/sunovels.test.ts file as you go.
import {
  SourceUrlError,
  type Source,
  type SourceChapter,
  type SourceHost,
  type SourceLine,
  type SourceNovel,
  type SourceSearchResult,
  type SourceSection,
} from "@riwaq/extension-api";

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

export default function createSource(_host: SourceHost): Source {
  return {
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

    async getNovel(_url: string): Promise<SourceNovel> {
      throw new Error("not implemented");
    },

    async getChapterContent(_chapter: SourceChapter): Promise<SourceLine[]> {
      throw new Error("not implemented");
    },
  };
}
