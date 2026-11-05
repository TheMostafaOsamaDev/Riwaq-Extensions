// Iken (Next.js manga CMS) template. One factory turns a site's id, origin
// and API origin into a full manga Source. The site is a client-rendered app,
// so everything comes from its JSON API:
//
//   - Lists are `GET <api>/api/query?perPage=18&page=<n>&orderBy=<…>`, which
//     answers `{ posts, totalCount }`. Novels share the endpoint and are
//     dropped (`seriesType: "NOVEL"`, or the older `isNovel: true`).
//   - A series is `GET <api>/api/post?postSlug=<slug>`. Its inline chapter
//     array can be empty, so the chapters come from
//     `GET <api>/api/chapters?postId=<id>` (all of them, newest first); they
//     are returned oldest first.
//   - Pages are `GET <api>/api/chapter?chapterId=<id>` -> `images`. A paid
//     chapter answers 200 with `images: []`, so locked chapters are never
//     requested.
//   - Cards, series and chapters carry site URLs
//     (`<baseUrl>/series/<slug>[/<chapter-slug>]`); the API stays internal.
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
import { createCheckedRequest, lockedError, pagesAsLines } from "./helpers";
import { mangaStrings } from "./strings";

export interface IkenConfig {
  /** The manifest id; prefixes every error. */
  id: string;
  /** Site origin, no trailing slash. */
  baseUrl: string;
  /** API origin, no trailing slash. */
  apiUrl: string;
}

/** Posts per `api/query` page. */
const PER_PAGE = 18;

interface IkenPost {
  id: number;
  slug: string;
  postTitle: string;
  featuredImage?: string;
  seriesType?: string;
  seriesStatus?: string;
  isNovel?: boolean;
  postContent?: string;
  author?: string;
  artist?: string;
  genres?: Array<{ name?: string }>;
}

interface IkenChapter {
  id: number;
  slug: string;
  number: number;
  title?: string;
  isLocked?: boolean;
  isPermanentlyLocked?: boolean;
}

interface IkenImage {
  url: string;
  width?: number;
  height?: number;
  order?: number;
}

const isNovel = (p: IkenPost) => p.isNovel === true || (p.seriesType ?? "").toUpperCase() === "NOVEL";

/** `postContent` is HTML (`<p>…</p>`) on newer posts and plain text on older
 *  ones. Returns plain text: tags gone, entities decoded, one paragraph or
 *  `<br>` per line, blank lines dropped. */
function htmlToText(raw: string | undefined): string {
  if (!raw) return "";
  const doc = parseHtml(raw);
  for (const br of doc.querySelectorAll("br")) br.replaceWith("\n");
  for (const block of doc.querySelectorAll("p, div, li, h1, h2, h3, h4, h5, h6, blockquote")) {
    block.append("\n");
  }
  return (doc.body.textContent ?? "")
    .split(/\r\n?|\n/)
    .map((line) => sanitizeText(line))
    .filter(Boolean)
    .join("\n");
}

export function createIkenSource(host: SourceHost, config: IkenConfig): Source {
  const { id } = config;
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const apiUrl = config.apiUrl.replace(/\/+$/, "");
  const hostname = new URL(baseUrl).hostname;
  const t = mangaStrings(host.locale);
  const request = createCheckedRequest(host, id);

  async function api<T>(path: string): Promise<T> {
    const url = `${apiUrl}${path}`;
    try {
      return JSON.parse((await request(url)).text) as T;
    } catch (err) {
      if (err instanceof SyntaxError) throw new Error(`${id}: ${url} did not answer JSON`);
      throw err;
    }
  }

  const seriesUrl = (slug: string) => `${baseUrl}/series/${slug}`;

  function cardsFrom(posts: IkenPost[]): NovelCard[] {
    return posts
      .filter((p) => !isNovel(p) && p.slug && p.postTitle)
      .map((p) => ({
        url: seriesUrl(p.slug),
        title: sanitizeText(p.postTitle),
        coverUrl: p.featuredImage || undefined,
        contentType: "manga" as const,
      }));
  }

  const listPath = (page: number, orderBy: string, term?: string) =>
    `/api/query?perPage=${PER_PAGE}&page=${page}` +
    (term === undefined ? "" : `&searchTerm=${encodeURIComponent(term)}`) +
    `&orderBy=${orderBy}`;

  async function getChapterPages(chapter: SourceChapter) {
    if (chapter.lock) throw lockedError(id, chapter);
    const data = await api<{ chapter?: { images?: IkenImage[] } }>(`/api/chapter?chapterId=${chapter.id}`);
    const images = (data.chapter?.images ?? [])
      .filter((i) => typeof i.url === "string" && i.url.trim() !== "")
      .map((image, index) => ({ image, index }))
      .sort((a, b) => (a.image.order ?? a.index) - (b.image.order ?? b.index) || a.index - b.index);
    const pages: PageRef[] = images.map(({ image }) => {
      const page: PageRef = { url: image.url.trim() };
      if (image.width && image.height) {
        page.width = image.width;
        page.height = image.height;
      }
      return page;
    });
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
        api<{ posts?: IkenPost[] }>(listPath(1, "lastChapterAddedAt")),
        api<{ posts?: IkenPost[] }>(listPath(1, "totalViews")),
      ]);
      return [
        { id: "latest", title: t.latest, cards: cardsFrom(latest.posts ?? []) },
        { id: "popular", title: t.popular, cards: cardsFrom(popular.posts ?? []) },
      ];
    },

    async search(query, page): Promise<SourceSearchResult> {
      const q = query.trim();
      const pageNum = Math.max(1, page ?? 1);
      if (!q) return { cards: [], hasMore: false, query: q, page: pageNum };
      const data = await api<{ posts?: IkenPost[]; totalCount?: number }>(
        listPath(pageNum, "lastChapterAddedAt", q),
      );
      return {
        cards: cardsFrom(data.posts ?? []),
        hasMore: pageNum * PER_PAGE < (data.totalCount ?? 0),
        query: q,
        page: pageNum,
      };
    },

    async getNovel(url): Promise<SourceNovel> {
      let slug = "";
      try {
        slug = decodeURIComponent(url.split(/[?#]/)[0].split("/").filter(Boolean).pop() ?? "");
      } catch {
        // A malformed escape is not a series URL; reported below.
      }
      if (!slug) throw new Error(`${id}: ${url} is not a series page`);
      const data = await api<{ post?: IkenPost }>(`/api/post?postSlug=${encodeURIComponent(slug)}`);
      const post = data.post;
      if (!post || !post.postTitle || isNovel(post)) throw new Error(`${id}: ${url} is not a manga series`);
      const list = await api<{ post?: { chapters?: IkenChapter[] } }>(`/api/chapters?postId=${post.id}`);
      const chapters: SourceChapter[] = (list.post?.chapters ?? [])
        .map((c) => {
          const chapterUrl = `${seriesUrl(post.slug)}/${c.slug}`;
          const title = sanitizeText(c.title);
          const chapter: SourceChapter = {
            id: c.id,
            title: title ? `${c.number} - ${title}` : String(c.number),
            url: chapterUrl,
            number: c.number,
            lines: [],
          };
          if (c.isLocked || c.isPermanentlyLocked) chapter.lock = { reason: "paid", openUrl: chapterUrl };
          return chapter;
        })
        // The API lists newest first; chapters are returned oldest first.
        .sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
      return {
        title: sanitizeText(post.postTitle),
        author: sanitizeText(post.author || post.artist),
        language: "ar",
        direction: "rtl",
        coverUrl: post.featuredImage || undefined,
        description: htmlToText(post.postContent) || undefined,
        tags: (post.genres ?? []).map((g) => sanitizeText(g.name)).filter(Boolean),
        status: sanitizeText(post.seriesStatus) || undefined,
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
