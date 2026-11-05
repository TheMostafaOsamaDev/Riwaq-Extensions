// Rocks Manga (روكس مانجا) — rocksmanga.com, a Next.js app. Pages are server
// rendered, and series / chapter data ride along in the React Server Components
// flight payload: `self.__next_f.push([1, "<chunk>"])` scripts, which join (in
// order) into one text holding JSON objects.
//
//   - Browse: `/browse?sort={latest|most_viewed}&page=<n>&search=<q>`, 24
//     `.unit` cards a page; `a.page-link[rel=next]` says another page exists.
//   - Series `/manga/<slug>`: the manga object (`{ id, slug, title, synopsis,
//     cover_url, status, is_nsfw, authors, genres }`) and the chapter list
//     (`{ mangaSlug, chapters: [{ id, number, title, created_at }] }`), every
//     chapter inline. The sidebar embeds other series' objects too, so objects
//     are matched on this page's slug, never taken first.
//   - Chapter `/manga/<slug>/chapter/<number>`: `chapter.pages` is a list of
//     `/storage/...` paths on https://api.rocksmanga.com (no Referer needed).
//   - Chapters are returned oldest first. No lock field has been seen on the
//     site; one named `is_locked` / `locked` / `is_premium` is honoured anyway.
import {
  parseHtml,
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

const ID = "rocks-manga";
const BASE_URL = "https://rocksmanga.com";
const API_URL = "https://api.rocksmanga.com";

interface RocksManga {
  id?: number;
  slug?: string;
  title?: string;
  synopsis?: string;
  cover_url?: string;
  status?: string;
  is_nsfw?: boolean;
  authors?: Array<{ name?: string }>;
  artists?: Array<{ name?: string }>;
  genres?: Array<{ name?: string }>;
}

interface RocksChapter {
  id: number;
  number: string | number;
  title?: string;
  is_locked?: boolean;
  locked?: boolean;
  is_premium?: boolean;
}

/** The page's flight chunks, decoded and joined in order. */
function flightText(html: string): string {
  const out: string[] = [];
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try {
      out.push(JSON.parse(m[1]) as string);
    } catch {
      // A chunk that does not decode is skipped; missing data is reported by the caller.
    }
  }
  return out.join("");
}

/** The JSON value (object or array) that starts at `text[start]`, or undefined. */
function jsonAt(text: string, start: number): unknown {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

const slugOf = (url: string): string => {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return parts[0] === "manga" && parts[1] ? decodeURIComponent(parts[1]) : "";
  } catch {
    return "";
  }
};

export default function createSource(host: SourceHost): Source {
  const t = mangaStrings(host.locale);
  const request = createCheckedRequest(host, ID);
  const hostname = new URL(BASE_URL).hostname;

  const browseUrl = (sort: string, page: number, term?: string) =>
    `${BASE_URL}/browse?sort=${sort}&page=${page}` + (term === undefined ? "" : `&search=${encodeURIComponent(term)}`);

  const absolute = (path: string, origin: string) => (/^https?:\/\//.test(path) ? path : origin + path);

  async function browse(url: string): Promise<{ cards: NovelCard[]; hasMore: boolean }> {
    const html = (await request(url)).text;
    const doc = parseHtml(html);
    // Per-item `isNsfw` rides in the flight data's `cards` list, keyed by slug.
    const nsfwBySlug = new Map<string, boolean>();
    const flight = flightText(html);
    const at = flight.indexOf('"cards":[');
    const listed = at < 0 ? undefined : jsonAt(flight, at + '"cards":'.length);
    if (Array.isArray(listed)) {
      for (const item of listed as Array<{ slug?: unknown; isNsfw?: unknown }>) {
        if (item && typeof item.slug === "string" && typeof item.isNsfw === "boolean") {
          nsfwBySlug.set(item.slug, item.isNsfw);
        }
      }
    }
    const cards: NovelCard[] = [];
    for (const unit of doc.querySelectorAll(".unit")) {
      const href = unit.querySelector("a.poster")?.getAttribute("href") ?? "";
      const title = sanitizeText(unit.querySelector(".info > a")?.textContent);
      if (!href || !title) continue;
      const cover = unit.querySelector("img")?.getAttribute("src");
      const nsfw = nsfwBySlug.get(slugOf(absolute(href, BASE_URL)));
      cards.push({
        url: absolute(href, BASE_URL),
        title,
        coverUrl: cover ? absolute(cover, API_URL) : undefined,
        contentType: "manga",
        ...(nsfw === undefined ? {} : { nsfw }),
      });
    }
    return { cards, hasMore: doc.querySelector("a.page-link[rel=next]") !== null };
  }

  async function getChapterPages(chapter: SourceChapter) {
    if (chapter.lock) throw lockedError(ID, chapter);
    const text = flightText((await request(chapter.url)).text);
    let list: unknown;
    for (const m of text.matchAll(/"chapter":\{"id":(\d+),/g)) {
      if (Number(m[1]) !== chapter.id) continue;
      const obj = jsonAt(text, m.index! + '"chapter":'.length) as { pages?: unknown } | undefined;
      list = obj?.pages;
      break;
    }
    const pages: PageRef[] = (Array.isArray(list) ? list : [])
      .filter((p): p is string => typeof p === "string" && p.trim() !== "")
      .map((p) => ({ url: absolute(p.trim(), API_URL) }));
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
      const [latest, popular] = await Promise.all([browse(browseUrl("latest", 1)), browse(browseUrl("most_viewed", 1))]);
      return [
        { id: "latest", title: t.latest, cards: latest.cards },
        { id: "popular", title: t.popular, cards: popular.cards },
      ];
    },

    async search(query, page): Promise<SourceSearchResult> {
      const q = query.trim();
      const pageNum = Math.max(1, page ?? 1);
      if (!q) return { cards: [], hasMore: false, query: q, page: pageNum };
      const { cards, hasMore } = await browse(browseUrl("latest", pageNum, q));
      return { cards, hasMore, query: q, page: pageNum };
    },

    async getNovel(url): Promise<SourceNovel> {
      const slug = slugOf(url);
      if (!slug) throw new Error(`${ID}: ${url} is not a series page`);
      const seriesUrl = `${BASE_URL}/manga/${encodeURIComponent(slug)}`;
      const text = flightText((await request(seriesUrl)).text);

      // The manga object: the one carrying this slug (and a synopsis/type, which
      // the sidebar's slimmer objects lack when they happen to share a slug).
      let manga: RocksManga | undefined;
      const slugKey = `"slug":${JSON.stringify(slug)}`;
      for (let at = text.indexOf(slugKey); at >= 0; at = text.indexOf(slugKey, at + 1)) {
        const open = text.lastIndexOf("{", at);
        const obj = open < 0 ? undefined : (jsonAt(text, open) as RocksManga | undefined);
        if (obj && obj.slug === slug && typeof obj.title === "string" && "synopsis" in obj) {
          manga = obj;
          break;
        }
      }
      if (!manga) throw new Error(`${ID}: ${url} has no series data`);

      let rawChapters: RocksChapter[] | undefined;
      const marker = `"mangaSlug":${JSON.stringify(slug)},"chapters":`;
      const at = text.indexOf(marker);
      if (at >= 0) {
        const parsed = jsonAt(text, at + marker.length);
        if (Array.isArray(parsed)) rawChapters = parsed as RocksChapter[];
      }
      if (!rawChapters) throw new Error(`${ID}: ${url} has no chapter list`);

      const chapters: SourceChapter[] = rawChapters
        .filter((c) => c && typeof c.id === "number" && c.number !== undefined && c.number !== "")
        .map((c) => {
          const raw = String(c.number).trim();
          const number = Number.isFinite(Number(raw)) ? Number(raw) : parseChapterNumber(raw);
          const chapterUrl = `${seriesUrl}/chapter/${encodeURIComponent(raw)}`;
          const title = sanitizeText(c.title);
          const chapter: SourceChapter = {
            id: c.id,
            title: title ? `${raw} - ${title}` : raw,
            url: chapterUrl,
            number,
            lines: [],
          };
          if (c.is_locked || c.locked || c.is_premium) chapter.lock = { reason: "locked", openUrl: chapterUrl };
          return chapter;
        })
        .sort((a, b) => (a.number ?? 0) - (b.number ?? 0) || a.id - b.id);

      const people = (list?: Array<{ name?: string }>) =>
        (list ?? []).map((p) => sanitizeText(p.name)).filter(Boolean).join(", ");
      return {
        title: sanitizeText(manga.title),
        author: people(manga.authors) || people(manga.artists),
        language: "ar",
        direction: "rtl",
        coverUrl: manga.cover_url ? absolute(manga.cover_url, API_URL) : undefined,
        description: htmlToText(manga.synopsis) || undefined,
        tags: (manga.genres ?? []).map((g) => sanitizeText(g.name)).filter(Boolean),
        status: sanitizeText(manga.status) || undefined,
        meta: [],
        volumes: [{ id: 1, title: t.part(1), chapters }],
        contentType: "manga",
        nsfw: manga.is_nsfw === true,
      };
    },

    getChapterPages,

    async getChapterContent(chapter) {
      return pagesAsLines(await getChapterPages(chapter));
    },
  };
}
