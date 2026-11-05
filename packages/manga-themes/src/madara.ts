// Madara (WordPress manga theme) template. One factory turns a site's
// id and base URL into a full manga Source:
//
//   - Home and search are WordPress listing pages (`.page-item-detail` cards
//     and `.c-tabs-item__content` rows).
//   - A series page only shows its newest few chapters. The whole list comes
//     from `POST <series>/ajax/chapters/?t=<n>`, 50 chapters per page, newest
//     first, with a pager whose highest `data-page` is the page count. Each
//     ajax page is one lazy volume, so a long series opens fast.
//   - A chapter page lists its images under `.reading-content`.
//   - An adult series carries an "18+" `.manga-title-badges.adult` on its
//     cards and beside its `.post-title`; those set `nsfw`.
import {
  absoluteUrl,
  parseHtml,
  type FetchOptions,
  sanitizeText,
  type NovelCard,
  type Source,
  type SourceChapter,
  type SourceHost,
  type SourceNovel,
  type SourceSearchResult,
  type SourceSection,
  type SourceVolume,
} from "@riwaq/extension-api";
import { chapterIdFromUrl, chapterNumberFromUrl, createCheckedRequest, lockedError, pagesAsLines } from "./helpers";
import { mangaStrings } from "./strings";

export interface MadaraConfig {
  /** The manifest id; prefixes every error. */
  id: string;
  /** Site origin, no trailing slash. */
  baseUrl: string;
  /** Path segment series live under. Default `"manga"`. */
  seriesPath?: string;
}

/** Chapters per `ajax/chapters/` page, fixed by the theme. */
const CHAPTERS_PER_PAGE = 50;

const COVER_ATTRS = ["data-src", "data-lazy-src", "src"];

/** The theme's "18+" title badge, on a card and beside a series' `.post-title`. */
const ADULT_BADGE = ".manga-title-badges.adult";

/** First non-empty, trimmed value among the attributes, in order. */
function firstAttr(el: Element | null | undefined, attrs: string[]): string | undefined {
  if (!el) return undefined;
  for (const a of attrs) {
    const v = (el.getAttribute(a) ?? "").trim();
    if (v) return v;
  }
  return undefined;
}

export function createMadaraSource(host: SourceHost, config: MadaraConfig): Source {
  const { id } = config;
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const seriesPath = config.seriesPath ?? "manga";
  const hostname = new URL(baseUrl).hostname;
  const t = mangaStrings(host.locale);

  const request = createCheckedRequest(host, id);

  const abs = (href: string, base = baseUrl + "/") => absoluteUrl(href, base);

  function cardsFrom(
    doc: Document,
    rowSelector: string,
    titleSelector: string,
    coverSelector: string,
  ): NovelCard[] {
    const cards: NovelCard[] = [];
    for (const row of doc.querySelectorAll(rowSelector)) {
      // A badge link can precede the title link, so take the last one.
      const links = row.querySelectorAll(titleSelector);
      const link = links[links.length - 1];
      const href = link?.getAttribute("href");
      const title = sanitizeText(link?.textContent);
      if (!href || !title) continue;
      const cover = firstAttr(row.querySelector(coverSelector), COVER_ATTRS);
      const card: NovelCard = {
        url: abs(href),
        title,
        coverUrl: cover ? abs(cover) : undefined,
        contentType: "manga",
      };
      if (row.querySelector(ADULT_BADGE)) card.nsfw = true;
      cards.push(card);
    }
    return cards;
  }

  const listUrl = (order: string) => `${baseUrl}/${seriesPath}/?m_orderby=${order}`;

  /** Madara marks a paid or locked chapter with a class on its `li`. */
  function isLocked(li: Element): boolean {
    return (
      /\b(premium|locked|coin|vip)\b/i.test(li.getAttribute("class") ?? "") ||
      li.querySelector(".fa-lock, .ion-md-lock, .chapter-lock") !== null
    );
  }

  function parseChapters(html: string): SourceChapter[] {
    const chapters: SourceChapter[] = [];
    for (const li of parseHtml(html).querySelectorAll("li.wp-manga-chapter")) {
      const a = li.querySelector("a");
      const href = a?.getAttribute("href");
      if (!href) continue;
      const url = abs(href);
      const chapter: SourceChapter = {
        id: chapterIdFromUrl(url),
        title: sanitizeText(a?.textContent),
        url,
        number: chapterNumberFromUrl(url),
        lines: [],
      };
      if (isLocked(li)) chapter.lock = { reason: "locked", openUrl: url };
      chapters.push(chapter);
    }
    return chapters;
  }

  const ajaxUrl = (seriesUrl: string, page: number) => `${seriesUrl}ajax/chapters/?t=${page}`;
  const ajaxInit: FetchOptions = { method: "POST", headers: { "X-Requested-With": "XMLHttpRequest" } };
  const withSlash = (url: string) => (url.split(/[?#]/)[0].endsWith("/") ? url.split(/[?#]/)[0] : url.split(/[?#]/)[0] + "/");

  async function chapterList(seriesUrl: string, page: number): Promise<{ html: string; chapters: SourceChapter[] }> {
    const resp = await request(ajaxUrl(seriesUrl, page), ajaxInit);
    // The site lists newest first; volumes run oldest first, so chapters do too.
    return { html: resp.text, chapters: parseChapters(resp.text).reverse() };
  }

  async function getChapterPages(chapter: SourceChapter) {
    if (chapter.lock) throw lockedError(id, chapter);
    const resp = await request(chapter.url);
    const doc = parseHtml(resp.text);
    const pages = [...doc.querySelectorAll(".reading-content img")]
      .map((img) => firstAttr(img, ["data-src", "data-lazy-src", "src"]))
      .filter((u): u is string => !!u)
      .map((u) => ({ url: abs(u, chapter.url) }));
    if (pages.length === 0) throw new Error(`${id}: ${chapter.url} lists no page images`);
    return { pages };
  }

  return {
    hasLazyVolumes: true,

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
        request(listUrl("latest")),
        request(listUrl("views")),
      ]);
      const cards = (html: string) =>
        cardsFrom(parseHtml(html), ".page-item-detail", ".post-title a", ".item-thumb img");
      return [
        { id: "latest", title: t.latest, cards: cards(latest.text) },
        { id: "popular", title: t.popular, cards: cards(popular.text) },
      ];
    },

    async search(query, page): Promise<SourceSearchResult> {
      const q = query.trim();
      const pageNum = Math.max(1, page ?? 1);
      if (!q) return { cards: [], hasMore: false, query: q, page: pageNum };
      const url = `${baseUrl}/?s=${encodeURIComponent(q)}&post_type=wp-manga&paged=${pageNum}`;
      const doc = parseHtml((await request(url)).text);
      return {
        cards: cardsFrom(doc, ".c-tabs-item__content", ".post-title a", ".tab-thumb img"),
        // The theme labels the link to the NEXT (older) results page "previous".
        hasMore: doc.querySelector(".nav-links .nav-previous a, a.next.page-numbers") !== null,
        query: q,
        page: pageNum,
      };
    },

    async getNovel(url): Promise<SourceNovel> {
      const seriesUrl = withSlash(url);
      const [series, first] = await Promise.all([request(seriesUrl), chapterList(seriesUrl, 1)]);
      const doc = parseHtml(series.text);
      const title = sanitizeText(doc.querySelector(".post-title h1")?.textContent);
      if (!title) throw new Error(`${id}: ${seriesUrl} is not a series page`);
      const cover = firstAttr(doc.querySelector(".summary_image img"), COVER_ATTRS);

      const pager = [...parseHtml(first.html).querySelectorAll("[data-page]")].map((el) =>
        Number(el.getAttribute("data-page")),
      );
      const pageCount = Math.max(1, ...pager.filter(Number.isFinite));

      // One volume per ajax page, oldest first: volume i holds page
      // pageCount - i + 1, so the last volume is the newest chapters.
      const volumes: SourceVolume[] = [];
      for (let i = 1; i <= pageCount; i++) {
        const page = pageCount - i + 1;
        const newest = page === 1;
        volumes.push({
          id: i,
          title: t.part(i),
          key: String(page),
          chapters: newest ? first.chapters : [],
          chapterCount: newest ? first.chapters.length : page === pageCount ? undefined : CHAPTERS_PER_PAGE,
        });
      }

      const statusItem = [...doc.querySelectorAll(".post-status .post-content_item")].find((item) =>
        /الحالة|status/i.test(item.querySelector(".summary-heading")?.textContent ?? ""),
      );
      return {
        title,
        author: sanitizeText(doc.querySelector(".author-content")?.textContent),
        language: "ar",
        direction: "rtl",
        coverUrl: cover ? abs(cover, seriesUrl) : undefined,
        description: sanitizeText(doc.querySelector(".summary__content")?.textContent) || undefined,
        tags: [...doc.querySelectorAll(".genres-content a")]
          .map((a) => sanitizeText(a.textContent))
          .filter(Boolean),
        status: sanitizeText(statusItem?.querySelector(".summary-content")?.textContent) || undefined,
        meta: [],
        volumes,
        contentType: "manga",
        // The theme also tags an adult series' page with `body.adult-content`.
        ...(doc.querySelector(`.post-title ${ADULT_BADGE}, body.adult-content`) ? { nsfw: true } : {}),
      };
    },

    async getVolumeChapters(novelUrl, volume): Promise<SourceChapter[]> {
      const page = Number(volume.key);
      if (!Number.isInteger(page) || page < 1) {
        throw new Error(`${id}: volume "${volume.title}" has no page key`);
      }
      return (await chapterList(withSlash(novelUrl), page)).chapters;
    },

    getChapterPages,

    async getChapterContent(chapter) {
      return pagesAsLines(await getChapterPages(chapter));
    },
  };
}
