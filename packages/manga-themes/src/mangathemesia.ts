// MangaThemesia (WordPress manga theme) template. One factory turns a site's
// id and base URL into a full manga Source:
//
//   - Lists are `/<seriesPath>/?order=<update|popular>&page=<n>`; search is
//     `/?s=<q>&paged=<n>`.
//   - The whole chapter list is inline on the series page, newest first, so
//     there are no lazy volumes; it is returned oldest first.
//   - A chapter page carries `ts_reader.run({...})`; `sources[0].images` are
//     the pages in order.
//
// Sites on this theme often re-skin it. Each lookup therefore tries the stock
// MangaThemesia selector first and then the custom skins seen so far
// (Lava Scans: `.manga-card-v`, `.legend-card`, `.ch-item`).
import {
  absoluteUrl,
  parseHtml,
  sanitizeText,
  type NovelCard,
  type Source,
  type SourceChapter,
  type SourceHost,
  type SourceNovel,
  type SourceSearchResult,
  type SourceSection,
} from "@riwaq/extension-api";
import { chapterIdFromUrl, chapterNumberFromUrl, createCheckedRequest, lockedError, pagesAsLines } from "./helpers";
import { mangaStrings } from "./strings";

export interface ThemesiaConfig {
  /** The manifest id; prefixes every error. */
  id: string;
  /** Site origin, no trailing slash. */
  baseUrl: string;
  /** Path segment series live under. Default `"manga"`. */
  seriesPath?: string;
}

const CARD = ".bsx, .manga-card-v, .legend-card";
const CARD_TITLE = ".card-v-title a, .legend-title a";
const CARD_COVER = ["data-src", "data-lazy-src", "src"];
const SIGNS_LOCKED = /\b(locked|premium|paid|coin|vip)\b/i;

function firstAttr(el: Element | null | undefined, attrs: string[]): string | undefined {
  if (!el) return undefined;
  for (const a of attrs) {
    const v = (el.getAttribute(a) ?? "").trim();
    if (v) return v;
  }
  return undefined;
}

/** The JSON object passed to `ts_reader.run(`, found by balancing braces
 *  (string-aware) rather than guessing where the call ends. */
function readerJson(source: string): unknown {
  const start = source.indexOf("{", source.indexOf("ts_reader.run("));
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(source.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function createThemesiaSource(host: SourceHost, config: ThemesiaConfig): Source {
  const { id } = config;
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const seriesPath = config.seriesPath ?? "manga";
  const hostname = new URL(baseUrl).hostname;
  const t = mangaStrings(host.locale);

  const request = createCheckedRequest(host, id);

  const abs = (href: string, base = baseUrl + "/") => absoluteUrl(href, base);

  function cardsFrom(doc: Document): NovelCard[] {
    const cards: NovelCard[] = [];
    for (const row of doc.querySelectorAll(CARD)) {
      const link = row.querySelector(CARD_TITLE) ?? row.querySelector("a");
      const href = link?.getAttribute("href");
      const title = sanitizeText(
        row.querySelector(".tt, .card-v-title, .legend-title")?.textContent || link?.getAttribute("title"),
      );
      if (!href || !title) continue;
      const cover = firstAttr(row.querySelector("img"), CARD_COVER);
      cards.push({
        url: abs(href),
        title,
        coverUrl: cover ? abs(cover) : undefined,
        contentType: "manga",
      });
    }
    return cards;
  }

  const listUrl = (order: string, page: number) =>
    `${baseUrl}/${seriesPath}/?order=${order}&page=${page}`;

  function parseChapters(doc: Document): SourceChapter[] {
    const chapters: SourceChapter[] = [];
    for (const li of doc.querySelectorAll("#chapterlist li, .ch-item")) {
      const a = li.querySelector(".eph-num a, .ch-main-anchor, a");
      const href = a?.getAttribute("href");
      if (!href) continue;
      const url = abs(href);
      const label = sanitizeText(
        li.querySelector(".chapternum, .ch-num")?.textContent || a?.textContent,
      );
      const attrNumber = Number(li.getAttribute("data-num") ?? li.getAttribute("data-ch"));
      const siteId = Number(li.getAttribute("data-id"));
      const chapter: SourceChapter = {
        id: Number.isInteger(siteId) && siteId > 0 && siteId < 2 ** 31 ? siteId : chapterIdFromUrl(url),
        title: label,
        url,
        number:
          (li.getAttribute("data-num") ?? li.getAttribute("data-ch")) && Number.isFinite(attrNumber)
            ? attrNumber
            : chapterNumberFromUrl(url),
        lines: [],
      };
      const locked =
        SIGNS_LOCKED.test(li.getAttribute("class") ?? "") ||
        li.getAttribute("data-coin") === "yes" ||
        li.querySelector(".fa-lock, .fa-coins") !== null;
      if (locked) chapter.lock = { reason: "locked", openUrl: url };
      chapters.push(chapter);
    }
    // The page lists newest first; chapters are returned oldest first.
    return chapters.reverse();
  }

  async function getChapterPages(chapter: SourceChapter) {
    if (chapter.lock) throw lockedError(id, chapter);
    const resp = await request(chapter.url);
    const doc = parseHtml(resp.text);
    let images: unknown;
    for (const script of doc.querySelectorAll("script")) {
      const text = script.textContent ?? "";
      if (!text.includes("ts_reader.run(")) continue;
      const json = readerJson(text) as { sources?: Array<{ images?: unknown }> } | undefined;
      images = json?.sources?.[0]?.images;
      break;
    }
    const pages = (Array.isArray(images) ? images : [])
      .filter((u): u is string => typeof u === "string" && u.trim() !== "")
      .map((u) => ({ url: abs(u.trim(), chapter.url) }));
    if (pages.length === 0) throw new Error(`${id}: ${chapter.url} lists no page images`);
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
      const [latest, popular] = await Promise.all([
        request(listUrl("update", 1)),
        request(listUrl("popular", 1)),
      ]);
      return [
        { id: "latest", title: t.latest, cards: cardsFrom(parseHtml(latest.text)) },
        { id: "popular", title: t.popular, cards: cardsFrom(parseHtml(popular.text)) },
      ];
    },

    async search(query, page): Promise<SourceSearchResult> {
      const q = query.trim();
      const pageNum = Math.max(1, page ?? 1);
      if (!q) return { cards: [], hasMore: false, query: q, page: pageNum };
      // `&paged=` pages the results; a bare `&page=` is ignored by WordPress search.
      const doc = parseHtml(
        (await request(`${baseUrl}/?s=${encodeURIComponent(q)}&paged=${pageNum}`)).text,
      );
      return {
        cards: cardsFrom(doc),
        hasMore: doc.querySelector("a.next.page-numbers, .hpage a.r") !== null,
        query: q,
        page: pageNum,
      };
    },

    async getNovel(url): Promise<SourceNovel> {
      const doc = parseHtml((await request(url)).text);
      const title = sanitizeText(doc.querySelector(".entry-title, .lh-title")?.textContent);
      if (!title) throw new Error(`${id}: ${url} is not a series page`);
      const cover = firstAttr(doc.querySelector(".thumb img, .lh-poster img"), CARD_COVER);
      const statusEl = doc.querySelector(".imptdt i, .status-badge-lux");
      return {
        title,
        author: "",
        language: "ar",
        direction: "rtl",
        coverUrl: cover ? abs(cover, url) : undefined,
        description:
          sanitizeText(
            doc.querySelector(".entry-content[itemprop=description], #manga-story")?.textContent,
          ) || undefined,
        tags: [...doc.querySelectorAll(".mgen a, .lh-genre-tag")]
          .map((a) => sanitizeText(a.textContent))
          .filter(Boolean),
        status: sanitizeText(statusEl?.textContent) || undefined,
        meta: [],
        volumes: [{ id: 1, title: t.part(1), chapters: parseChapters(doc) }],
        contentType: "manga",
      };
    },

    getChapterPages,

    async getChapterContent(chapter) {
      return pagesAsLines(await getChapterPages(chapter));
    },
  };
}
