// Madara (WordPress manga theme) template. One factory turns a site's
// id and base URL into a full manga Source:
//
//   - Home and search are WordPress listing pages (`.page-item-detail` cards
//     and `.c-tabs-item__content` rows).
//   - A series page only shows its newest few chapters. The whole list comes
//     from `POST <series>/ajax/chapters/?t=<n>`, 50 chapters per page, newest
//     first, with a pager whose highest `data-page` is the page count P (on the
//     last page itself, the current page).
//   - Volumes are lazy and counted from the OLDEST chapter: volume k is
//     chapters 50(k-1)+1 … 50k from the oldest, whatever the site has added
//     since, so a release never moves a chapter between volumes (the ajax
//     pages, counted from the newest, all shift by one). The total is
//     50(P-1) + the length of page P, so getNovel reads page 1 (for P and the
//     newest volume) and page P. A volume spans one or two ajax pages; which
//     ones depends on the current length of page P, so expanding a volume
//     reads page P again first.
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

  /** One ajax page's chapters, newest first, as the site lists them. */
  function parseChapters(doc: Document): SourceChapter[] {
    const chapters: SourceChapter[] = [];
    for (const li of doc.querySelectorAll("li.wp-manga-chapter")) {
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

  /** One ajax page: its chapters newest first, and the highest page its pager names. */
  interface ChapterPage {
    chapters: SourceChapter[];
    lastPage: number;
  }
  type Pages = Map<number, ChapterPage>;

  async function chapterPage(seriesUrl: string, page: number): Promise<ChapterPage> {
    const doc = parseHtml((await request(ajaxUrl(seriesUrl, page), ajaxInit)).text);
    const named = [...doc.querySelectorAll("[data-page]")]
      .map((el) => Number(el.getAttribute("data-page")))
      .filter((n) => Number.isInteger(n) && n > 0);
    return { chapters: parseChapters(doc), lastPage: Math.max(page, ...named) };
  }

  async function pagesInto(seriesUrl: string, pages: Pages, wanted: number[]): Promise<void> {
    const missing = wanted.filter((p) => !pages.has(p));
    const fetched = await Promise.all(missing.map((p) => chapterPage(seriesUrl, p)));
    missing.forEach((p, i) => pages.set(p, fetched[i]));
  }

  /** The page count each series had when last read; a hint only, since every
   *  50th release adds a page. It saves reading page 1 to find page P. */
  const lastPageHint = new Map<string, number>();

  /** The chapter total, from page P read now. `pages` gathers what was read. */
  async function chapterTotal(seriesUrl: string, pages: Pages): Promise<number> {
    let last = pages.get(1)?.lastPage ?? lastPageHint.get(seriesUrl);
    // A stale hint costs one hop: page P's pager names the new last page.
    for (let hop = 0; hop < 4; hop++) {
      if (last === undefined) {
        await pagesInto(seriesUrl, pages, [1]);
        last = pages.get(1)!.lastPage;
      }
      await pagesInto(seriesUrl, pages, [last]);
      const page = pages.get(last)!;
      if (page.lastPage > last) {
        last = page.lastPage;
        continue;
      }
      if (page.chapters.length === 0 && last > 1 && !pages.has(1)) {
        // The hint is past the end (chapters were removed): ask page 1.
        last = undefined;
        continue;
      }
      lastPageHint.set(seriesUrl, last);
      return CHAPTERS_PER_PAGE * (last - 1) + page.chapters.length;
    }
    throw new Error(`${id}: ${seriesUrl} has a chapter pager that keeps moving`);
  }

  /** Chapters k·50-49 … k·50 counted from the oldest (fewer in the newest
   *  volume), oldest first, from the one or two ajax pages that hold them. */
  async function volumeChapters(seriesUrl: string, k: number, total: number, pages: Pages): Promise<SourceChapter[]> {
    // Positions counted from the newest, 1-based, as the pages list them.
    const newestEnd = total - CHAPTERS_PER_PAGE * (k - 1);
    if (newestEnd < 1) return [];
    const newestStart = Math.max(1, newestEnd - CHAPTERS_PER_PAGE + 1);
    const first = Math.ceil(newestStart / CHAPTERS_PER_PAGE);
    const lastPage = Math.ceil(newestEnd / CHAPTERS_PER_PAGE);
    const wanted = first === lastPage ? [first] : [first, lastPage];
    await pagesInto(seriesUrl, pages, wanted);
    const pageCount = Math.ceil(total / CHAPTERS_PER_PAGE);
    for (const p of wanted) {
      const n = pages.get(p)!.chapters.length;
      // Every page but the last is full; anything else breaks the arithmetic.
      if (p < pageCount && n !== CHAPTERS_PER_PAGE) {
        throw new Error(`${id}: ${seriesUrl} chapter page ${p} lists ${n} chapters, not ${CHAPTERS_PER_PAGE}`);
      }
    }
    const newestFirst = wanted.flatMap((p) => pages.get(p)!.chapters);
    const offset = CHAPTERS_PER_PAGE * (first - 1);
    // The site lists newest first; volumes run oldest first, so chapters do too.
    return newestFirst.slice(newestStart - offset - 1, newestEnd - offset).reverse();
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
      const [series, first] = await Promise.all([request(seriesUrl), chapterPage(seriesUrl, 1)]);
      const doc = parseHtml(series.text);
      const title = sanitizeText(doc.querySelector(".post-title h1")?.textContent);
      if (!title) throw new Error(`${id}: ${seriesUrl} is not a series page`);
      const cover = firstAttr(doc.querySelector(".summary_image img"), COVER_ATTRS);

      const pages: Pages = new Map([[1, first]]);
      const total = await chapterTotal(seriesUrl, pages);
      const count = Math.max(1, Math.ceil(total / CHAPTERS_PER_PAGE));
      // Volume k is the k-th fifty from the oldest; only the newest is filled,
      // from page 1 (it is the newest `total - 50(count-1)` chapters).
      const newest = await volumeChapters(seriesUrl, count, total, pages);
      const volumes: SourceVolume[] = [];
      for (let k = 1; k <= count; k++) {
        volumes.push({
          id: k,
          title: t.part(k),
          key: String(k),
          chapters: k === count ? newest : [],
          chapterCount: k === count ? total - CHAPTERS_PER_PAGE * (count - 1) : CHAPTERS_PER_PAGE,
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
      const k = /^\d+$/.test(volume.key ?? "") ? Number(volume.key) : NaN;
      if (!Number.isSafeInteger(k) || k < 1) {
        throw new Error(`${id}: volume "${volume.title}" has no part key`);
      }
      const seriesUrl = withSlash(novelUrl);
      const pages: Pages = new Map();
      const total = await chapterTotal(seriesUrl, pages);
      return volumeChapters(seriesUrl, k, total, pages);
    },

    getChapterPages,

    async getChapterContent(chapter) {
      return pagesAsLines(await getChapterPages(chapter));
    },
  };
}
