// MMRCMS (a PHP manga CMS) template. One factory turns a site's id and base
// URL into a full manga Source. Pages are server-rendered HTML:
//
//   - Home: the "latest chapters" block lists one `.manga-item` per released
//     chapter, so a series with several new chapters repeats; cards are one
//     per series. Popular is `GET /filterList?page=1&sortBy=views&asc=false`,
//     an HTML fragment of `.chapter-container` cards (`sortBy=name` works too;
//     an unknown `sortBy` answers HTTP 500).
//   - Search is `GET /search?query=<q>`, the autocomplete endpoint: JSON
//     `{ suggestions: [{ value: <title>, data: <slug> }] }`, one page, no
//     covers (the cover URL follows the site's fixed upload path).
//   - A series is `/manga/<slug>`, with every chapter inline in
//     `ul.chapters` as `/manga/<slug>/<n>` (`<n>` may be decimal). The site
//     lists them newest first; they are returned oldest first.
//   - A chapter page carries `var pages = [{ page_image, page_slug, external }]`.
//     A page is `<imageBase>/uploads/manga/<slug>/chapters/<n>/<page_image>`,
//     where imageBase is the origin of the first `img.scan-page` (the images
//     live on `www.`); an `external: 1` entry's `page_image` is already an
//     absolute URL.
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
  pagesAsLines,
  parseChapterNumber,
} from "./helpers";
import { mangaStrings } from "./strings";

export interface MmrcmsConfig {
  /** The manifest id; prefixes every error. */
  id: string;
  /** Site origin, no trailing slash. */
  baseUrl: string;
}

interface MmrcmsPage {
  page_image?: string;
  external?: number | string;
}

export function createMmrcmsSource(host: SourceHost, config: MmrcmsConfig): Source {
  const { id } = config;
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const hostname = new URL(baseUrl).hostname;
  const t = mangaStrings(host.locale);
  const request = createCheckedRequest(host, id);

  const abs = (href: string, base = baseUrl + "/") => absoluteUrl(href.trim(), base);
  const coverFor = (slug: string) => `${baseUrl}/uploads/manga/${slug}/cover/cover_250x350.jpg`;

  function latestCards(doc: Document): NovelCard[] {
    const cards = new Map<string, NovelCard>();
    for (const item of doc.querySelectorAll(".latest-managa .manga-item")) {
      const link = item.querySelector("h3.manga-heading a");
      const href = link?.getAttribute("href");
      const title = sanitizeText(link?.textContent);
      if (!href || !title) continue;
      const url = abs(href);
      if (cards.has(url)) continue;
      const cover = item.querySelector(".right-image img")?.getAttribute("src");
      cards.set(url, { url, title, coverUrl: cover ? abs(cover) : undefined, contentType: "manga" });
    }
    return [...cards.values()];
  }

  function listCards(doc: Document): NovelCard[] {
    const cards: NovelCard[] = [];
    for (const item of doc.querySelectorAll(".chapter-container")) {
      const link = item.querySelector("a.chart-title");
      const href = link?.getAttribute("href");
      const title = sanitizeText(link?.textContent);
      if (!href || !title) continue;
      const cover = item.querySelector(".chapter-image img")?.getAttribute("src");
      cards.push({ url: abs(href), title, coverUrl: cover ? abs(cover) : undefined, contentType: "manga" });
    }
    return cards;
  }

  async function getChapterPages(chapter: SourceChapter) {
    if (chapter.lock) throw lockedError(id, chapter);
    const html = (await request(chapter.url)).text;
    const m = /var\s+pages\s*=\s*(\[[\s\S]*?\])\s*;/.exec(html);
    let entries: MmrcmsPage[] = [];
    if (m) {
      try {
        entries = JSON.parse(m[1]) as MmrcmsPage[];
      } catch {
        throw new Error(`${id}: ${chapter.url} has an unreadable page list`);
      }
    }
    const path = /\/manga\/(.+)\/([^/?#]+)(?:[?#].*)?$/.exec(chapter.url);
    const imageSrc = parseHtml(html).querySelector("img.scan-page")?.getAttribute("src")?.trim();
    let imageBase = baseUrl;
    if (imageSrc) {
      try {
        imageBase = new URL(abs(imageSrc, chapter.url)).origin;
      } catch {
        // Keep the site origin.
      }
    }
    const pages: PageRef[] = [];
    for (const entry of entries) {
      const file = (entry.page_image ?? "").trim();
      if (!file) continue;
      if (Number(entry.external) === 1) {
        pages.push({ url: abs(file, chapter.url) });
      } else if (path) {
        pages.push({ url: `${imageBase}/uploads/manga/${path[1]}/chapters/${path[2]}/${file}` });
      }
    }
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
      const [home, popular] = await Promise.all([
        request(`${baseUrl}/`),
        request(`${baseUrl}/filterList?page=1&sortBy=views&asc=false`),
      ]);
      return [
        { id: "latest", title: t.latest, cards: latestCards(parseHtml(home.text)) },
        { id: "popular", title: t.popular, cards: listCards(parseHtml(popular.text)) },
      ];
    },

    async search(query, page): Promise<SourceSearchResult> {
      const q = query.trim();
      const pageNum = Math.max(1, page ?? 1);
      // The endpoint answers one page of suggestions.
      if (!q || pageNum > 1) return { cards: [], hasMore: false, query: q, page: pageNum };
      const url = `${baseUrl}/search?query=${encodeURIComponent(q)}`;
      let data: { suggestions?: Array<{ value?: string; data?: string }> };
      try {
        data = JSON.parse((await request(url)).text);
      } catch (err) {
        if (err instanceof SyntaxError) throw new Error(`${id}: ${url} did not answer JSON`);
        throw err;
      }
      const cards: NovelCard[] = [];
      for (const s of data.suggestions ?? []) {
        const slug = (s.data ?? "").trim();
        const title = sanitizeText(s.value);
        if (!slug || !title) continue;
        cards.push({ url: `${baseUrl}/manga/${slug}`, title, coverUrl: coverFor(slug), contentType: "manga" });
      }
      return { cards, hasMore: false, query: q, page: pageNum };
    },

    async getNovel(url): Promise<SourceNovel> {
      const doc = parseHtml((await request(url)).text);
      const root = doc.querySelector(".single-managa");
      const title = sanitizeText(root?.querySelector(".panel-heading")?.textContent);
      if (!root || !title) throw new Error(`${id}: ${url} is not a manga series page`);

      const chapters: SourceChapter[] = [];
      const seen = new Set<string>();
      for (const a of doc.querySelectorAll("ul.chapters h5.chapter-title-rtl a")) {
        const href = a.getAttribute("href");
        if (!href) continue;
        const chapterUrl = abs(href, url);
        if (seen.has(chapterUrl)) continue;
        seen.add(chapterUrl);
        const last = chapterUrl.split(/[?#]/)[0].split("/").filter(Boolean).pop() ?? "";
        chapters.push({
          id: chapterIdFromUrl(chapterUrl),
          title: sanitizeText(a.textContent) || last,
          url: chapterUrl,
          number: parseChapterNumber(last),
          lines: [],
        });
      }
      // The site lists newest first; chapters are returned oldest first.
      chapters.reverse();

      const statusRow = [...root.querySelectorAll("h3")].find((h) => sanitizeText(h.textContent).startsWith("الحالة"));
      const cover = root.querySelector(".boxed img")?.getAttribute("src");
      const description = htmlToText(doc.querySelector(".managa-summary .well p")?.innerHTML);
      return {
        title,
        author: sanitizeText(root.querySelector('a[href*="/manga-list/author/"]')?.textContent),
        language: "ar",
        direction: "rtl",
        coverUrl: cover ? abs(cover, url) : undefined,
        description: description || undefined,
        tags: [...root.querySelectorAll('a[href*="/manga-list/category/"]')]
          .map((a) => sanitizeText(a.textContent))
          .filter(Boolean),
        status: sanitizeText(statusRow?.querySelector(".label")?.textContent) || undefined,
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
