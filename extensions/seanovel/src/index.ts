// SeaNovel source (بحر الروايات) — seanovel.org. Korean, Chinese and
// Japanese web novels translated into Arabic, served from the site's own
// JSON API. Novel pages live at /novels/<slug> and chapters at
// /novels/<slug>/chapters/<id>.
//
// getHomeSections and search are both built on GET /api/novels, which
// returns the entire catalogue (every novel, no query params, no
// pagination) in one call — see cardFor/fetchCatalogue below. getNovel and
// getChapterContent still throw "not implemented" and are filled in by
// later tasks in this plan, against this manifest's `baseUrl`.
import type {
  NovelCard,
  Source,
  SourceChapter,
  SourceHost,
  SourceLine,
  SourceNovel,
  SourceSearchResult,
  SourceSection,
} from "@riwaq/extension-api";
import { strings } from "./strings";

const BASE_URL = "https://seanovel.org";
// Derived from BASE_URL rather than hand-duplicated, so there is one
// source of truth for the hostname. Yields the same two hosts the brief
// specifies: "seanovel.org" and "www.seanovel.org".
const { hostname: BASE_HOSTNAME } = new URL(BASE_URL);
const HOSTS = new Set([BASE_HOSTNAME, `www.${BASE_HOSTNAME}`]);

/** One row of the site's `/api/novels` catalogue. Extra fields the API
 *  returns (description, rating, latest_chapters, ...) are ignored here —
 *  later tasks pull them in as getNovel/getChapterContent need them. */
export interface CatalogueRow {
  slug: string;
  title_ar: string;
  title_original?: string;
  origin?: string;
  author?: string;
  status?: string;
  genres?: string[];
  chapters_count?: number;
  last_updated?: string;
}

/** Cap on cards per home-section row and per search page. The site's
 *  catalogue endpoint has no pagination of its own (it returns every
 *  novel in one call) — this is purely our own page size for slicing it. */
export const PAGE_SIZE = 24;

const novelUrl = (slug: string) => `${BASE_URL}/novels/${slug}`;
const coverUrl = (slug: string) => `${BASE_URL}/api/novel/${slug}/cover?type=webp`;

export function cardFor(row: CatalogueRow): NovelCard {
  return {
    url: novelUrl(row.slug),
    title: row.title_ar || row.title_original || row.slug,
    coverUrl: coverUrl(row.slug),
    subtitle: row.title_original || undefined,
    badges: row.genres?.slice(0, 3),
  };
}

export default function createSource(host: SourceHost): Source {
  const t = strings(host.locale);

  // The catalogue is one call and the server ignores query params (see
  // `search` below), so it is fetched once and reused for both search and
  // the home rows. Deliberately a closure-local variable, NOT a
  // module-scope `let` outside createSource: a module-scope memo would be
  // shared by every Source this factory ever creates, so the first host
  // passed to createSource would win permanently and a second
  // createSource(otherHost) would silently replay the first host's
  // catalogue instead of fetching its own. Scoping it here makes the
  // memoisation per-instance — the cost is one extra /api/novels fetch per
  // Source instance, which is a single cheap call.
  let cataloguePromise: Promise<CatalogueRow[]> | null = null;

  function fetchCatalogue(): Promise<CatalogueRow[]> {
    cataloguePromise ??= (async () => {
      const resp = await host.fetch(`${BASE_URL}/api/novels`);
      const rows = JSON.parse(resp.text) as unknown;
      if (!Array.isArray(rows)) {
        throw new Error("Sea Novel: /api/novels did not return a list of novels.");
      }
      return rows as CatalogueRow[];
    })();
    return cataloguePromise;
  }

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
      host.log("info", "getHomeSections");
      const rows = await fetchCatalogue();

      const latest = [...rows].sort(
        (a, b) => Date.parse(b.last_updated ?? "") - Date.parse(a.last_updated ?? ""),
      );
      const popular = [...rows].sort((a, b) => (b.chapters_count ?? 0) - (a.chapters_count ?? 0));
      const completed = rows.filter((r) => r.status === "completed");

      return [
        { id: "latest", title: t("homeLatest"), rows: latest },
        { id: "popular", title: t("homePopular"), rows: popular },
        { id: "completed", title: t("homeCompleted"), rows: completed },
      ]
        .filter((section) => section.rows.length > 0)
        .map((section) => ({
          id: section.id,
          title: section.title,
          cards: section.rows.slice(0, PAGE_SIZE).map(cardFor),
        }));
    },

    async search(query: string, page = 1): Promise<SourceSearchResult> {
      host.log("info", `search(${query}) page ${page}`);
      const rows = await fetchCatalogue();
      const q = query.toLowerCase();
      const matches = rows.filter(
        (r) =>
          (r.title_ar ?? "").toLowerCase().includes(q) ||
          (r.title_original ?? "").toLowerCase().includes(q) ||
          (r.slug ?? "").toLowerCase().includes(q),
      );
      // The server ignores query params (it always returns the whole
      // catalogue), so search filters locally and pages the filtered list
      // itself rather than trusting any pagination the site might claim.
      const start = (page - 1) * PAGE_SIZE;
      const pageRows = matches.slice(start, start + PAGE_SIZE);
      return {
        cards: pageRows.map(cardFor),
        hasMore: matches.length > start + PAGE_SIZE,
        query,
        page,
      };
    },

    async getNovel(_url: string): Promise<SourceNovel> {
      throw new Error("not implemented");
    },

    async getChapterContent(_chapter: SourceChapter): Promise<SourceLine[]> {
      throw new Error("not implemented");
    },
  };
}
