// SeaNovel source (بحر الروايات) — seanovel.org. Korean, Chinese and
// Japanese web novels translated into Arabic, served from the site's own
// JSON API (see later tasks in this plan for home sections, search, novel
// detail and chapter content). Novel pages live at /novels/<slug> and
// chapters at /novels/<slug>/chapters/<id>.
//
// Every method below throws "not implemented" except canHandle. Implement
// the rest one at a time against this manifest's `baseUrl`, replacing the
// matching stub assertion in the sibling tests/*.test.ts file as you go —
// it already imports createTestHost and is wired to fail loudly (via the
// "not implemented" assertions) until you do.
import type {
  Source,
  SourceChapter,
  SourceHost,
  SourceLine,
  SourceNovel,
  SourceSearchResult,
  SourceSection,
} from "@riwaq/extension-api";

const BASE_URL = "https://seanovel.org";
// Derived from BASE_URL rather than hand-duplicated, so there is one
// source of truth for the hostname. Yields the same two hosts the brief
// specifies: "seanovel.org" and "www.seanovel.org".
const { hostname: BASE_HOSTNAME } = new URL(BASE_URL);
const HOSTS = new Set([BASE_HOSTNAME, `www.${BASE_HOSTNAME}`]);

export default function createSource(_host: SourceHost): Source {
  return {
    canHandle(url: string): boolean {
      // Cheap and synchronous — no host.fetch here.
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
