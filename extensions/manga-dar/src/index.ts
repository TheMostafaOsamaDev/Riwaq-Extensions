// MangaDar (مانجا دار) — mangadar.com, WordPress with the MiraiThemes
// "MangaVerse" theme behind Cloudflare (not challenged). Mihon's source for
// this site is out of date; this follows the live pages.
//
//   - Lists: popular is `/manga/` (`/manga/page/N/` from page 2; page 1
//     301s to `/manga/`), latest adds `?sort=new`. 30 tiles per page. Each
//     tile is an `<a class="group block">` inside an Alpine
//     `<template x-if="view === 'grid'">`, so the DOM parser exposes it only
//     as the template's content, never to querySelectorAll.
//   - Search: `GET /wp-admin/admin-ajax.php?action=mangaverse_search&q=` →
//     `{ success, data: [{ title, url, cover, ... }] }`, one page.
//   - A series is `/manga/<slug>/`. Every chapter is in
//     `<script id="mdg-manga-chapters-json">{"rows":[[id,"387.1",url,unixTs,num],...]}`,
//     newest first; they are returned oldest first.
//   - A chapter is `/manga/<slug>/<n>/`. Each `.reader-page img` carries a 1x1
//     GIF in `src` and the real address in `data-mds`: base64 of a signed site
//     URL `/?mdrs=1&c=<chapterId>&i=<idx>&exp=<unix seconds>&pnonce=…&sig=…`
//     (valid about 10 hours) that 302-redirects to storage.mangadar.com. The
//     PageRef keeps the signed site URL (the app follows the redirect); its
//     cacheKey drops the signature so a cached page survives a re-sign.
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
  createCheckedRequest,
  htmlToText,
  lockedError,
  mangaStrings,
  pagesAsLines,
  parseChapterNumber,
} from "@riwaq/manga-themes";

const ID = "manga-dar";
const BASE_URL = "https://mangadar.com";
const HOSTNAME = "mangadar.com";

type ChapterRow = [number, string, string, ...unknown[]];

export default function createSource(host: SourceHost): Source {
  const t = mangaStrings(host.locale);
  const request = createCheckedRequest(host, ID);

  // Series and chapter pages carry ad <iframe>s the readers never use; dropping
  // them keeps a parser (happy-dom in the tests) from trying to load them.
  const parse = (html: string) => parseHtml(html.replace(/<iframe\b[\s\S]*?<\/iframe>/gi, ""));

  const listUrl = (page: number, sort?: "new") => {
    const path = page > 1 ? `/manga/page/${page}/` : "/manga/";
    return `${BASE_URL}${path}${sort ? `?sort=${sort}` : ""}`;
  };

  function listCards(html: string): NovelCard[] {
    const doc = parse(html);
    const cards: NovelCard[] = [];
    for (const tpl of doc.querySelectorAll("template")) {
      if ((tpl.getAttribute("x-if") ?? "").replace(/\s/g, "") !== "view==='grid'") continue;
      // The template's children live in `.content`; fall back to its markup.
      const inner = (tpl as HTMLTemplateElement).content ?? parseHtml(tpl.innerHTML);
      const link = inner.querySelector("a[href]");
      const href = link?.getAttribute("href");
      const title = sanitizeText(inner.querySelector("h3")?.textContent);
      if (!href || !title) continue;
      const cover = inner.querySelector("img")?.getAttribute("src");
      cards.push({
        url: absoluteUrl(href.trim(), BASE_URL + "/"),
        title,
        coverUrl: cover ? absoluteUrl(cover.trim(), BASE_URL + "/") : undefined,
        contentType: "manga",
      });
    }
    return cards;
  }

  function parseJson<T>(text: string, what: string): T {
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`${ID}: ${what} is not valid JSON`);
    }
  }

  function chapterRows(html: string, url: string): ChapterRow[] {
    const m = /<script[^>]*id="mdg-manga-chapters-json"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    if (!m) throw new Error(`${ID}: ${url} has no chapter list`);
    const rows = parseJson<{ rows?: ChapterRow[] }>(m[1], `${url} chapter list`).rows;
    if (!Array.isArray(rows)) throw new Error(`${ID}: ${url} has no chapter list`);
    return rows;
  }

  /** Base64 of a site URL or path, to `{ path+query }` rebased on the site. */
  function decodeMds(mds: string, chapterUrl: string): URL {
    let decoded: string;
    try {
      decoded = atob(mds.trim());
    } catch {
      throw new Error(`${ID}: ${chapterUrl} has an unreadable page address`);
    }
    try {
      const u = new URL(decoded, BASE_URL + "/");
      return new URL(`${u.pathname}${u.search}`, BASE_URL);
    } catch {
      throw new Error(`${ID}: ${chapterUrl} has an unreadable page address`);
    }
  }

  async function getChapterPages(chapter: SourceChapter) {
    if (chapter.lock) throw lockedError(ID, chapter);
    const doc = parse((await request(chapter.url)).text);
    const pages: PageRef[] = [];
    let earliest = Infinity;
    for (const img of doc.querySelectorAll(".reader-page img[data-mds]")) {
      const u = decodeMds(img.getAttribute("data-mds") ?? "", chapter.url);
      const c = u.searchParams.get("c");
      const i = u.searchParams.get("i");
      const exp = Number(u.searchParams.get("exp"));
      if (!c || !i || !Number.isFinite(exp) || exp <= 0) {
        throw new Error(`${ID}: ${chapter.url} has an unsigned page address`);
      }
      earliest = Math.min(earliest, exp);
      pages.push({ url: u.href, cacheKey: `${BASE_URL}/mdrs/${c}/${i}` });
    }
    if (pages.length === 0) throw new Error(`${ID}: ${chapter.url} lists no page images`);
    // `exp` is unix seconds.
    return { pages, expiresAt: earliest * 1000 };
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
      const [latest, popular] = await Promise.all([request(listUrl(1, "new")), request(listUrl(1))]);
      return [
        { id: "latest", title: t.latest, cards: listCards(latest.text), viewMoreUrl: listUrl(1, "new") },
        { id: "popular", title: t.popular, cards: listCards(popular.text), viewMoreUrl: listUrl(1) },
      ];
    },

    async search(query, page): Promise<SourceSearchResult> {
      const q = query.trim();
      const pageNum = Math.max(1, page ?? 1);
      // The endpoint answers one page of matches.
      if (!q || pageNum > 1) return { cards: [], hasMore: false, query: q, page: pageNum };
      const url = `${BASE_URL}/wp-admin/admin-ajax.php?action=mangaverse_search&q=${encodeURIComponent(q)}`;
      const data = parseJson<{ data?: Array<{ title?: string; url?: string; cover?: string }> }>(
        (await request(url)).text,
        url,
      );
      const cards: NovelCard[] = [];
      for (const r of Array.isArray(data.data) ? data.data : []) {
        const title = sanitizeText(r.title);
        const href = (r.url ?? "").trim();
        if (!title || !href) continue;
        cards.push({
          url: absoluteUrl(href, BASE_URL + "/"),
          title,
          coverUrl: r.cover ? absoluteUrl(r.cover.trim(), BASE_URL + "/") : undefined,
          contentType: "manga",
        });
      }
      return { cards, hasMore: false, query: q, page: pageNum };
    },

    async getNovel(url): Promise<SourceNovel> {
      const html = (await request(url)).text;
      const doc = parse(html);
      const title = sanitizeText(doc.querySelector("h1")?.textContent);
      if (!title) throw new Error(`${ID}: ${url} is not a manga series page`);
      const rows = chapterRows(html, url);

      const chapters: SourceChapter[] = [];
      const seen = new Set<number>();
      for (const row of rows) {
        const [rowId, label, href] = row;
        if (typeof href !== "string" || !href) continue;
        const chapterUrl = absoluteUrl(href, url);
        const id = Number(rowId);
        if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
        seen.add(id);
        const text = String(label ?? "");
        chapters.push({
          id,
          title: text ? `الفصل ${text}` : chapterUrl,
          url: chapterUrl,
          number: parseChapterNumber(text),
          lines: [],
        });
      }
      // The site lists newest first; chapters are returned oldest first.
      chapters.reverse();

      const statusLabel = [...doc.querySelectorAll("span")].find((s) => sanitizeText(s.textContent) === "الحالة");
      const status = sanitizeText(statusLabel?.nextElementSibling?.textContent);
      const author = sanitizeText(doc.querySelector('a[href*="/people/author/"]')?.textContent);
      const cover = doc.querySelector('meta[property="og:image"]')?.getAttribute("content");
      const description = htmlToText(doc.querySelector('[x-ref="synContent"]')?.innerHTML);
      return {
        title,
        author,
        originalTitle: sanitizeText(doc.querySelector("h1 + p")?.textContent) || undefined,
        language: "ar",
        direction: "rtl",
        coverUrl: cover ? absoluteUrl(cover.trim(), url) : undefined,
        description: description || undefined,
        tags: [...new Set([...doc.querySelectorAll('a[href*="/genre/"]')].map((a) => sanitizeText(a.textContent)))].filter(
          Boolean,
        ),
        status: status || undefined,
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
