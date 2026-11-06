// Swat Manga (سوات مانجا) — meshmanga.com. A Next.js front end over a Django
// REST-style JSON API on the same origin, under /v2/api/v2/. No cookies, no
// special headers; images are served from the same origin without a Referer.
//
//   - Lists: `/series/releases/?page=n` (latest), `/series/?order_by=
//     -followers_count&page=n` (popular), `/series/?search=q&page=n`. All are
//     `{ count, next, previous, results }`, 20 a page; `next !== null` means
//     more. Latest items carry `serie_id`, the others `id`.
//   - Series `/series/{id}/`; its site page is https://meshmanga.com/series/{id}.
//   - Chapters `/chapters/?serie={id}&order_by=-order&page_size=200`, following
//     `next`. `chapter` is free text ("190", "04 FREE"). No lock field has been
//     seen; one named `is_locked` / `locked` / `is_premium` is honoured anyway.
//     The site page is https://meshmanga.com/chapter/{chapterId}.
//   - Pages `/chapters/{id}/` -> `images: [{ image, order }]`.
//   - Chapters are returned oldest first. The manifest declares
//     `requestsPerSecond: 1` (Mihon limits the site the same way), so lists
//     are followed one request at a time.
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
import { createCheckedRequest, htmlToText, lockedError, mangaStrings, pagesAsLines, parseChapterNumber } from "@riwaq/manga-themes";

const ID = "swat-manga";
const BASE_URL = "https://meshmanga.com";
const API_URL = `${BASE_URL}/v2/api/v2`;

interface ListPage<T> {
  next?: string | null;
  results?: T[];
}

interface SeriesItem {
  id?: number;
  serie_id?: number;
  title?: string;
  poster?: { medium?: string };
}

interface Named {
  name?: string;
}

interface SeriesDetails extends SeriesItem {
  story?: string;
  genres?: Named[];
  author?: Named | string | null;
  artist?: Named | string | null;
  status?: Named | null;
}

interface ChapterItem {
  id: number;
  chapter?: string | number;
  is_locked?: boolean;
  locked?: boolean;
  is_premium?: boolean;
}

interface ChapterDoc {
  images?: Array<{ image?: string; order?: number }>;
}

const seriesUrl = (id: number | string) => `${BASE_URL}/series/${id}`;
const chapterUrl = (id: number | string) => `${BASE_URL}/chapter/${id}`;

const seriesIdOf = (url: string): string => {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return parts[0] === "series" && /^\d+$/.test(parts[1] ?? "") ? parts[1] : "";
  } catch {
    return "";
  }
};

const nameOf = (v: Named | string | null | undefined): string =>
  sanitizeText(typeof v === "string" ? v : v?.name);

export default function createSource(host: SourceHost): Source {
  const t = mangaStrings(host.locale);
  const request = createCheckedRequest(host, ID);
  const hostname = new URL(BASE_URL).hostname;

  async function getJson<T>(url: string): Promise<T> {
    const text = (await request(url, { headers: { Accept: "application/json" } })).text;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`${ID}: ${url} did not answer JSON`);
    }
  }

  async function list(url: string): Promise<{ cards: NovelCard[]; hasMore: boolean }> {
    const data = await getJson<ListPage<SeriesItem>>(url);
    const cards: NovelCard[] = [];
    for (const item of data.results ?? []) {
      const id = item.id ?? item.serie_id;
      const title = sanitizeText(item.title);
      if (id === undefined || !title) continue;
      cards.push({
        url: seriesUrl(id),
        title,
        coverUrl: item.poster?.medium || undefined,
        contentType: "manga",
      });
    }
    return { cards, hasMore: data.next !== null && data.next !== undefined };
  }

  const latestUrl = (page: number) => `${API_URL}/series/releases/?page=${page}`;
  const popularUrl = (page: number) => `${API_URL}/series/?order_by=-followers_count&page=${page}`;

  async function getChapterPages(chapter: SourceChapter) {
    if (chapter.lock) throw lockedError(ID, chapter);
    const doc = await getJson<ChapterDoc>(`${API_URL}/chapters/${chapter.id}/`);
    const pages: PageRef[] = (doc.images ?? [])
      .filter((i): i is { image: string; order?: number } => typeof i.image === "string" && i.image.trim() !== "")
      .map((i, index) => ({ image: i.image.trim(), order: i.order ?? index + 1, index }))
      .sort((a, b) => a.order - b.order || a.index - b.index)
      .map((i) => ({ url: i.image }));
    if (pages.length === 0) throw new Error(`${ID}: chapter ${chapter.id} lists no page images`);
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
      // One after the other: the host paces the site at one request a second.
      const latest = await list(latestUrl(1));
      const popular = await list(popularUrl(1));
      return [
        { id: "latest", title: t.latest, cards: latest.cards },
        { id: "popular", title: t.popular, cards: popular.cards },
      ];
    },

    async search(query, page): Promise<SourceSearchResult> {
      const q = query.trim();
      const pageNum = Math.max(1, page ?? 1);
      if (!q) return { cards: [], hasMore: false, query: q, page: pageNum };
      const { cards, hasMore } = await list(`${API_URL}/series/?search=${encodeURIComponent(q)}&page=${pageNum}`);
      return { cards, hasMore, query: q, page: pageNum };
    },

    async getNovel(url): Promise<SourceNovel> {
      const id = seriesIdOf(url);
      if (!id) throw new Error(`${ID}: ${url} is not a series page`);
      const details = await getJson<SeriesDetails>(`${API_URL}/series/${id}/`);
      if (!details.title) throw new Error(`${ID}: ${url} has no series data`);

      const raw: ChapterItem[] = [];
      let next: string | null | undefined = `${API_URL}/chapters/?serie=${id}&order_by=-order&page_size=200`;
      const seen = new Set<string>();
      while (next && !seen.has(next)) {
        seen.add(next);
        const data: ListPage<ChapterItem> = await getJson<ListPage<ChapterItem>>(next);
        raw.push(...(data.results ?? []));
        next = data.next;
      }

      const chapters: SourceChapter[] = raw
        .filter((c) => c && typeof c.id === "number")
        .map((c) => {
          const label = sanitizeText(String(c.chapter ?? ""));
          const chapter: SourceChapter = {
            id: c.id,
            title: label || String(c.id),
            url: chapterUrl(c.id),
            number: parseChapterNumber(label),
            lines: [],
          };
          if (c.is_locked || c.locked || c.is_premium) chapter.lock = { reason: "locked", openUrl: chapter.url };
          return chapter;
        })
        .sort((a, b) => (a.number ?? 0) - (b.number ?? 0) || a.id - b.id);

      return {
        title: sanitizeText(details.title),
        author: nameOf(details.author) || nameOf(details.artist),
        language: "ar",
        direction: "rtl",
        coverUrl: details.poster?.medium || undefined,
        description: htmlToText(details.story) || undefined,
        tags: (details.genres ?? []).map((g) => sanitizeText(g.name)).filter(Boolean),
        status: nameOf(details.status) || undefined,
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
