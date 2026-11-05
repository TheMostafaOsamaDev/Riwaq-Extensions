// Manga Time (مانجا تايم) — mangatime.org, a Vite + React app over a tRPC API.
// Every call is a batch of one:
//
//   GET <site>/api/trpc/<proc>?batch=1&input=<urlencoded {"0":{"json":<args>}}>
//   -> [{"result":{"data":{"json":…}}}]   (or [{"error":{"json":{"message"}}}])
//
//   - Lists are `search.searchSeries {page, limit: 24, sortBy, sortOrder, query?}`.
//     `query` must be a string or absent (null is a 400), so lists omit it.
//   - A series is `content.getSeriesBySlug {slug}`; its chapters are
//     `content.getChapters {seriesId, limit: -1}`, all of them at once.
//   - Pages are `content.getChapterPages {seriesSlug, chapterNumber}`, which
//     takes an integer: a decimal chapter can't be opened through it. The
//     number is read from the chapter URL (`…/chapter/<n>`), since a chapter
//     the app restores from its snapshot has no `number`.
//   - Site URLs are `<site>/<type>/<slug>` (type: manga | manhwa | manhua) and
//     `<site>/<type>/<slug>/chapter/<n>`. Chapter ids are 24-hex ObjectIds, so
//     ours come from the URL.
//   - The site's own reader also POSTs `content.trackView`; we don't (read-only).
import {
  sanitizeText,
  type NovelCard,
  type PageRef,
  type Source,
  type SourceChapter,
  type SourceHost,
  type SourceNovel,
  type SourceSearchResult,
  type SourceSection,
} from "@riwaq/extension-api";
import {
  chapterIdFromUrl,
  createCheckedRequest,
  htmlToText,
  lockedError,
  mangaStrings,
  pagesAsLines,
} from "@riwaq/manga-themes";

const ID = "manga-time";
const BASE_URL = "https://mangatime.org";
const LIMIT = 24;

interface SeriesSummary {
  title: string;
  slug: string;
  coverUrl?: string;
  type: string;
}

interface SeriesDetail extends SeriesSummary {
  id: string;
  description?: string;
  status?: string;
  author?: string;
  artist?: string;
  nameEn?: string;
  genres?: Array<{ name?: string }>;
}

interface ChapterDto {
  number: number;
  title?: string;
  publishedAt?: string;
  isPremium?: boolean;
  isUnlocked?: boolean;
}

interface PagesDto {
  pages?: string[];
  pageDimensions?: Array<{ w?: number; h?: number }>;
  isUnlocked?: boolean;
}

export default function createSource(host: SourceHost): Source {
  const hostname = new URL(BASE_URL).hostname;
  const t = mangaStrings(host.locale);
  const request = createCheckedRequest(host, ID);

  async function trpc<T>(proc: string, args: unknown): Promise<T> {
    const url = `${BASE_URL}/api/trpc/${proc}?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: { json: args } }))}`;
    const { text } = await request(url);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${ID}: ${proc} did not answer JSON`);
    }
    const first = Array.isArray(body) ? (body[0] as Record<string, any> | undefined) : undefined;
    if (first?.error) {
      const message = sanitizeText(first.error?.json?.message ?? first.error?.message);
      throw new Error(`${ID}: ${message || `${proc} failed`}`);
    }
    const json = first?.result?.data?.json;
    if (json === undefined || json === null) throw new Error(`${ID}: ${proc} answered no data`);
    return json as T;
  }

  /** Cover and page URLs are absolute or site-relative; spaces are escaped. */
  const toImage = (url: string) => {
    const u = url.trim().replace(/ /g, "%20");
    return /^https?:\/\//i.test(u) ? u : `${BASE_URL}${u.startsWith("/") ? "" : "/"}${u}`;
  };

  const seriesUrl = (s: SeriesSummary) => `${BASE_URL}/${s.type}/${s.slug}`;

  const cardsFrom = (results: SeriesSummary[]): NovelCard[] =>
    results
      .filter((s) => s.slug && s.title)
      .map((s) => ({
        url: seriesUrl(s),
        title: sanitizeText(s.title),
        coverUrl: s.coverUrl ? toImage(s.coverUrl) : undefined,
        contentType: "manga" as const,
      }));

  async function list(page: number, sortBy: "recent" | "popularity", query?: string) {
    return trpc<{ results?: SeriesSummary[]; hasMore?: boolean }>("search.searchSeries", {
      page,
      limit: LIMIT,
      sortBy,
      sortOrder: "desc",
      ...(query === undefined ? {} : { query }),
    });
  }

  /** `<site>/<type>/<slug>[/chapter/<n>]` -> the slug; the type is cosmetic. */
  function slugOf(url: string): string {
    let path = "";
    try {
      path = new URL(url).pathname;
    } catch {
      // Reported below.
    }
    const segments = path.split("/").filter(Boolean);
    if (segments.length < 2) throw new Error(`${ID}: ${url} is not a series page`);
    try {
      return decodeURIComponent(segments[1]);
    } catch {
      throw new Error(`${ID}: ${url} is not a series page`);
    }
  }

  /** The `<n>` of `…/chapter/<n>`, else `chapter.number`. The URL comes first:
   *  a chapter the app restores from its snapshot carries no `number`. */
  function chapterNumberOf(chapter: SourceChapter): number | undefined {
    const segment = /\/chapter\/([^/?#]+)/.exec(chapter.url)?.[1]?.trim();
    const n = segment ? Number(segment) : NaN;
    return Number.isFinite(n) ? n : chapter.number;
  }

  async function getChapterPages(chapter: SourceChapter) {
    if (chapter.lock) throw lockedError(ID, chapter);
    const number = chapterNumberOf(chapter);
    if (typeof number !== "number" || !Number.isInteger(number)) {
      throw new Error(`${ID}: decimal chapter numbers aren't supported by the site's reader`);
    }
    const data = await trpc<PagesDto>("content.getChapterPages", {
      seriesSlug: slugOf(chapter.url),
      chapterNumber: number,
    });
    if (data.isUnlocked === false) throw lockedError(ID, chapter);
    const dims = data.pageDimensions ?? [];
    const pages: PageRef[] = (data.pages ?? [])
      .filter((u) => typeof u === "string" && u.trim() !== "")
      .map((u, i) => {
        const page: PageRef = { url: toImage(u) };
        const d = dims[i];
        if (d?.w && d?.h) {
          page.width = d.w;
          page.height = d.h;
        }
        return page;
      });
    if (pages.length === 0) throw new Error(`${ID}: ${chapter.url} lists no page images`);
    return { pages };
  }

  return {
    canHandle(url) {
      try {
        const h = new URL(url).hostname;
        return h === hostname || h === `www.${hostname}`;
      } catch {
        return false;
      }
    },

    async getHomeSections(): Promise<SourceSection[]> {
      const [latest, popular] = await Promise.all([list(1, "recent"), list(1, "popularity")]);
      return [
        { id: "latest", title: t.latest, cards: cardsFrom(latest.results ?? []) },
        { id: "popular", title: t.popular, cards: cardsFrom(popular.results ?? []) },
      ];
    },

    async search(query, page): Promise<SourceSearchResult> {
      const q = query.trim();
      const pageNum = Math.max(1, page ?? 1);
      if (!q) return { cards: [], hasMore: false, query: q, page: pageNum };
      const data = await list(pageNum, "popularity", q);
      return { cards: cardsFrom(data.results ?? []), hasMore: data.hasMore === true, query: q, page: pageNum };
    },

    async getNovel(url): Promise<SourceNovel> {
      const slug = slugOf(url);
      const series = await trpc<SeriesDetail>("content.getSeriesBySlug", { slug });
      if (!series.id || !series.title) throw new Error(`${ID}: ${url} is not a manga series`);
      const { chapters: raw } = await trpc<{ chapters?: ChapterDto[] }>("content.getChapters", {
        seriesId: series.id,
        limit: -1,
      });
      const base = seriesUrl({ ...series, slug: series.slug || slug });
      const chapters: SourceChapter[] = (raw ?? [])
        .filter((c) => typeof c.number === "number")
        .map((c) => {
          const chapterUrl = `${base}/chapter/${c.number}`;
          const title = sanitizeText(c.title);
          const chapter: SourceChapter = {
            id: chapterIdFromUrl(chapterUrl),
            title: !title ? String(c.number) : title.includes(String(c.number)) ? title : `${c.number} - ${title}`,
            url: chapterUrl,
            number: c.number,
            lines: [],
          };
          if (c.isPremium && !c.isUnlocked) chapter.lock = { reason: "premium", openUrl: chapterUrl };
          return chapter;
        })
        .sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
      return {
        title: sanitizeText(series.title),
        author: sanitizeText(series.author || series.artist),
        originalTitle: sanitizeText(series.nameEn) || undefined,
        language: "ar",
        direction: "rtl",
        coverUrl: series.coverUrl ? toImage(series.coverUrl) : undefined,
        description: htmlToText(series.description) || undefined,
        tags: (series.genres ?? []).map((g) => sanitizeText(g.name)).filter(Boolean),
        status: sanitizeText(series.status) || undefined,
        meta: [],
        volumes: [{ id: 1, title: t.part(1), chapters }],
        contentType: "manga",
      };
    },

    getChapterPages,

    async getChapterContent(chapter) {
      return pagesAsLines(await getChapterPages(chapter));
    },
  };
}
