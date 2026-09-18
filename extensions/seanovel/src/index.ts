// SeaNovel source (بحر الروايات) — seanovel.org. Korean, Chinese and
// Japanese web novels translated into Arabic, served from the site's own
// JSON API. Novel pages live at /novels/<slug> and chapters at
// /novels/<slug>/chapters/<id>.
//
// getHomeSections and search are both built on GET /api/novels, which
// returns the entire catalogue (every novel, no query params, no
// pagination) in one call — see cardFor/fetchCatalogue below. getNovel
// fetches GET /api/novel/<slug>, which carries the full chapter list in one
// response (see getNovel below). getChapterContent still throws "not
// implemented" and is filled in by a later task in this plan.
import {
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

/** Shape of `GET /api/novel/<slug>` — the one-novel detail endpoint
 *  `getNovel` fetches. Extends `CatalogueRow` for the fields both
 *  endpoints share; adds the two only the detail endpoint carries: the
 *  full description and the complete chapter list. Other fields the
 *  endpoint returns (rating, similar_novels, initial_chapters,
 *  cover_version, first_published_at, source_id, has_volumes) are
 *  ignored — in particular `has_volumes` is never consulted, because this
 *  extension always returns exactly one fully-populated pseudo-volume and
 *  never declares lazy volumes (see `getNovel` below). */
export interface NovelDetailRow extends CatalogueRow {
  description?: string;
  chapters?: Array<{ id: number; title: string }>;
}

/** Cap on cards per home-section row and per search page. The site's
 *  catalogue endpoint has no pagination of its own (it returns every
 *  novel in one call) — this is purely our own page size for slicing it. */
export const PAGE_SIZE = 24;

const novelUrl = (slug: string) => `${BASE_URL}/novels/${slug}`;
const coverUrl = (slug: string) => `${BASE_URL}/api/novel/${slug}/cover?type=webp`;
const chapterUrl = (slug: string, id: number) => `${BASE_URL}/novels/${slug}/chapters/${id}`;

/** `/novels/<slug>` and `/novels/<slug>/chapters/<n>` both yield <slug>. */
export function slugFromUrl(url: string): string {
  const m = new URL(url).pathname.match(/^\/novels\/([^/]+)/);
  if (!m) {
    throw new SourceUrlError(`Sea Novel: ${url} is not a novel page URL.`);
  }
  return decodeURIComponent(m[1]);
}

/** Parse a JSON API response body, reporting the endpoint path and the
 *  response's HTTP status in the thrown error instead of letting a
 *  non-JSON response (a CDN interstitial, a WAF block page, an outage
 *  page, ...) surface as a bare, context-free `SyntaxError`. Mirrors the
 *  pattern in extensions/kolnovel/src/index.ts's `requestPdfUrl`. */
function parseJsonResponse(resp: FetchResponse, endpoint: string): unknown {
  try {
    return JSON.parse(resp.text);
  } catch {
    throw new Error(`Sea Novel: ${endpoint} did not return JSON (status ${resp.status}).`);
  }
}

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
      const rows = parseJsonResponse(resp, "/api/novels");
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

    async getNovel(url: string): Promise<SourceNovel> {
      const slug = slugFromUrl(url);
      host.log("info", `getNovel(${slug})`);
      const resp = await host.fetch(`${BASE_URL}/api/novel/${slug}`);
      const parsed = parseJsonResponse(resp, `/api/novel/${slug}`);
      // Mirrors the shape checks its two siblings make after their own
      // guarded parse: kolnovel's requestPdfUrl checks the decoded object,
      // and fetchCatalogue above checks `!Array.isArray(rows)`. A response
      // that parses successfully as `null`, a number, or an array (a
      // maintenance/error payload that still happens to be valid JSON)
      // would otherwise reach `data.origin` etc. below and throw a raw,
      // unbranded TypeError.
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`Sea Novel: /api/novel/${slug} did not return a novel object.`);
      }
      const data = parsed as NovelDetailRow;

      const meta: SourceNovelMeta[] = [];
      if (data.origin) meta.push({ label: t("metaOrigin"), value: data.origin });
      meta.push({ label: t("metaChapterCount"), value: String(data.chapters_count ?? 0) });

      const chapters: SourceChapter[] = (data.chapters ?? []).map((c) => ({
        id: c.id,
        title: c.title,
        url: chapterUrl(slug, c.id),
        lines: [],
      }));

      // The "always one fully-populated volume, never lazy" design (see the
      // volumes comment below) rests entirely on `chapters` always carrying
      // every chapter `chapters_count` claims to have. It does today (the
      // committed fixture's 3180 matches exactly), but nothing on this end
      // enforces that server-side — a truncated or paginated response for
      // an unusually large novel would otherwise silently produce a
      // shorter book with no signal anywhere. Warn rather than throw: see
      // task-3 fix report for the reasoning (short version — the chapters
      // that DID come back are still a useful, readable book, and a hard
      // failure would deny the user all of them over what may well be a
      // transient or self-correcting API inconsistency).
      if (data.chapters_count !== undefined && chapters.length !== data.chapters_count) {
        host.log(
          "warn",
          `Sea Novel: /api/novel/${slug} claims chapters_count=${data.chapters_count} but returned ${chapters.length} chapters.`,
        );
      }

      return {
        title: data.title_ar,
        originalTitle: data.title_original || undefined,
        // Never a literal "Unknown" — many catalogue rows have no author at
        // all, and the empty case is localized by the host at display time.
        author: data.author ?? "",
        language: "ar",
        direction: "rtl",
        coverUrl: coverUrl(slug),
        description: data.description,
        tags: data.genres ?? [],
        status: data.status,
        meta,
        // The detail endpoint carries every chapter in one response (see
        // NovelDetailRow above) — there is nothing left to lazily fetch, so
        // this is always exactly one fully-populated pseudo-volume and
        // `hasLazyVolumes` is never declared on this Source.
        volumes: [
          {
            id: 1,
            title: t("volumeFallback", { n: 1 }),
            chapters,
          },
        ],
      };
    },

    async getChapterContent(_chapter: SourceChapter): Promise<SourceLine[]> {
      throw new Error("not implemented");
    },
  };
}
