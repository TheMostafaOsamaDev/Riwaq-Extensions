// Team-X (olympustaff.com) — a server-rendered Laravel site. Cookies are set
// but not needed; HTML and images load without a Referer.
//
//   - Latest: `GET /?page=n`, `div.last-chapter div.box`, one box per released
//     chapter, so a series repeats; cards are one per series.
//   - Popular: `GET /series?page=n`, `div.listupd div.bsx`.
//   - Search: `GET /search?keyword=q`, `div.tx-grid a.tx-card`, no paging.
//   - Series `/series/{slug}`: chapters are `div.chapter-card` (`data-number`),
//     newest first, 40 a page, paginated with `ul.pagination` (`rel="next"`);
//     every page is followed. They are returned oldest first.
//   - A locked chapter has `span.status-badge.locked` and `href="#"` (it opens
//     a buy dialog; it costs points). Its id is the dialog's
//     `data-bs-whatever`; its url is the series page.
//   - Pages: `div.image_list img.manga-chapter-img`, else `canvas[data-src]`.
//   - Cover URLs drop the `thumbnail_` file prefix to get the full image.
import {
  absoluteUrl,
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
import {
  chapterIdFromUrl,
  createCheckedRequest,
  htmlToText,
  lockedError,
  mangaStrings,
  pagesAsLines,
  parseChapterNumber,
} from "@riwaq/manga-themes";

const ID = "team-x";
const BASE_URL = "https://olympustaff.com";
const HOSTNAME = "olympustaff.com";
// The widest series seen has 6 chapter pages; the cap only stops a loop.
const MAX_CHAPTER_PAGES = 200;

const fullSize = (url: string) => url.replace(/\/thumbnail_/, "/");

export default function createSource(host: SourceHost): Source {
  const t = mangaStrings(host.locale);
  const request = createCheckedRequest(host, ID);
  const abs = (href: string, base = `${BASE_URL}/`) => absoluteUrl(href.trim(), base);

  function latestCards(doc: Document): NovelCard[] {
    const cards = new Map<string, NovelCard>();
    for (const box of doc.querySelectorAll("div.last-chapter div.box")) {
      const link = box.querySelector("div.info a");
      const href = link?.getAttribute("href");
      const title = sanitizeText(link?.querySelector("h3")?.textContent);
      if (!href || !title) continue;
      const url = abs(href);
      if (cards.has(url)) continue;
      const cover = box.querySelector("div.imgu img")?.getAttribute("src");
      cards.set(url, { url, title, coverUrl: cover ? fullSize(abs(cover)) : undefined, contentType: "manga" });
    }
    return [...cards.values()];
  }

  function popularCards(doc: Document): NovelCard[] {
    const cards: NovelCard[] = [];
    for (const item of doc.querySelectorAll("div.listupd div.bsx")) {
      const link = item.querySelector("a");
      const href = link?.getAttribute("href");
      const title = sanitizeText(link?.getAttribute("title") || item.querySelector("div.tt")?.textContent);
      if (!href || !title) continue;
      const img = item.querySelector("img");
      const cover = img?.getAttribute("data-src") || img?.getAttribute("src");
      cards.push({ url: abs(href), title, coverUrl: cover ? abs(cover) : undefined, contentType: "manga" });
    }
    return cards;
  }

  function searchCards(doc: Document): NovelCard[] {
    const cards: NovelCard[] = [];
    for (const a of doc.querySelectorAll("div.tx-grid a.tx-card")) {
      const href = a.getAttribute("href");
      const title = sanitizeText(a.querySelector("h3")?.textContent);
      if (!href || !title) continue;
      const cover = a.querySelector("img")?.getAttribute("src");
      cards.push({ url: abs(href), title, coverUrl: cover ? fullSize(abs(cover)) : undefined, contentType: "manga" });
    }
    return cards;
  }

  function chaptersOf(doc: Document, seriesUrl: string): SourceChapter[] {
    const out: SourceChapter[] = [];
    for (const card of doc.querySelectorAll("div.chapter-card")) {
      const link = card.querySelector("a.chapter-link") ?? card.querySelector("a");
      const rawHref = (link?.getAttribute("href") ?? "").trim();
      const hasUrl = rawHref !== "" && rawHref !== "#" && !rawHref.startsWith("javascript:");
      const locked = card.querySelector("span.status-badge.locked") !== null || !hasUrl;
      const label = sanitizeText(card.querySelector(".chapter-number")?.textContent);
      const numberAttr = (card.getAttribute("data-number") ?? "").trim();
      const number = parseChapterNumber(numberAttr) ?? parseChapterNumber(label);
      if (number === undefined && !hasUrl) continue;

      // A locked chapter has no page of its own; the fragment keeps its url unique.
      const url = hasUrl ? abs(rawHref, seriesUrl) : `${seriesUrl}#chapter-${number}`;
      let id = chapterIdFromUrl(hasUrl ? url : `${seriesUrl}#${number}`);
      const siteId = Number(link?.getAttribute("data-bs-whatever"));
      if (locked && Number.isInteger(siteId) && siteId > 0 && siteId < 2 ** 31) id = siteId;

      const base = label || `الفصل ${numberAttr}`;
      const name = sanitizeText(card.querySelector(".chapter-title")?.textContent);
      const dull = new Set([numberAttr, label, `الفصل ${numberAttr}`, `الفصل رقم ${numberAttr}`]);
      const chapter: SourceChapter = {
        id,
        title: name && !dull.has(name) ? `${base} - ${name}` : base,
        url,
        number,
        lines: [],
      };
      if (locked) chapter.lock = { reason: "points", openUrl: seriesUrl };
      out.push(chapter);
    }
    return out;
  }

  async function getChapterPages(chapter: SourceChapter) {
    if (chapter.lock) throw lockedError(ID, chapter);
    const doc = parseHtml((await request(chapter.url)).text);
    const pages: PageRef[] = [];
    const list = doc.querySelector("div.image_list");
    const images = list?.querySelectorAll("img.manga-chapter-img") ?? [];
    for (const img of images) {
      const src = img.getAttribute("src")?.trim();
      if (src) pages.push({ url: abs(src, chapter.url) });
    }
    if (pages.length === 0) {
      for (const canvas of list?.querySelectorAll("canvas[data-src]") ?? []) {
        const src = canvas.getAttribute("data-src")?.trim();
        if (src) pages.push({ url: abs(src, chapter.url) });
      }
    }
    if (pages.length === 0) throw new Error(`${ID}: ${chapter.url} lists no page images`);
    return { pages };
  }

  return {
    canHandle(url) {
      try {
        const h = new URL(url).hostname;
        return h === HOSTNAME || h === `www.${HOSTNAME}`;
      } catch {
        return false;
      }
    },

    async getHomeSections(): Promise<SourceSection[]> {
      const [home, popular] = await Promise.all([
        request(`${BASE_URL}/?page=1`),
        request(`${BASE_URL}/series?page=1`),
      ]);
      return [
        { id: "latest", title: t.latest, cards: latestCards(parseHtml(home.text)) },
        { id: "popular", title: t.popular, cards: popularCards(parseHtml(popular.text)) },
      ];
    },

    async search(query, page): Promise<SourceSearchResult> {
      const q = query.trim();
      const pageNum = Math.max(1, page ?? 1);
      // The results page has no paging.
      if (!q || pageNum > 1) return { cards: [], hasMore: false, query: q, page: pageNum };
      const res = await request(`${BASE_URL}/search?keyword=${encodeURIComponent(q)}`);
      return { cards: searchCards(parseHtml(res.text)), hasMore: false, query: q, page: pageNum };
    },

    async getNovel(url): Promise<SourceNovel> {
      const seriesUrl = url.split(/[?#]/)[0];
      const firstDoc = parseHtml((await request(seriesUrl)).text);
      let doc = firstDoc;
      const title = sanitizeText(firstDoc.querySelector("div.author-info-title h1")?.textContent);
      if (!title) throw new Error(`${ID}: ${url} is not a series page`);

      const chapters: SourceChapter[] = [];
      const seen = new Set<string>([seriesUrl]);
      for (let n = 0; n < MAX_CHAPTER_PAGES; n++) {
        chapters.push(...chaptersOf(doc, seriesUrl));
        const next = doc.querySelector("ul.pagination a[rel=next]")?.getAttribute("href");
        if (!next) break;
        const nextUrl = abs(next, seriesUrl);
        if (seen.has(nextUrl)) break;
        seen.add(nextUrl);
        doc = parseHtml((await request(nextUrl)).text);
      }
      // The site lists newest first; chapters are returned oldest first.
      chapters.reverse();

      const infoValue = (label: string) => {
        for (const row of firstDoc.querySelectorAll(".full-list-info")) {
          const [head, value] = row.querySelectorAll("small");
          if (head && value && sanitizeText(head.textContent).startsWith(label)) return sanitizeText(value.textContent);
        }
        return "";
      };
      const artist = infoValue("الرسام");
      const cover = firstDoc.querySelector("div.text-right img")?.getAttribute("src");
      const description = htmlToText(firstDoc.querySelector("div.review-content")?.innerHTML);
      return {
        title,
        author: artist && artist !== "غير معروف" ? artist : "",
        language: "ar",
        direction: "rtl",
        coverUrl: cover ? abs(cover, seriesUrl) : undefined,
        description: description || undefined,
        tags: [...firstDoc.querySelectorAll("div.review-author-info a")].map((a) => sanitizeText(a.textContent)).filter(Boolean),
        status: infoValue("الحالة") || undefined,
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
