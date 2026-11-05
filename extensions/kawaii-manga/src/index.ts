// Kawaii Manga (كواي مانجا) — kawaiimanga.org, a Next.js front end over a JSON API
// at https://manga-api.kawaii-anime.com/api/manga (images on manga-cdn.kawaii-anime.com).
//
//   - Every API call needs `x-app-key: km_2026_live` (a fixed key that also sits in
//     the site's home page) and `x-app-token: <jwt>` from `GET /token`. A token
//     lasts 1800 s; without one the API answers 401 `{"error":"token_required"}`.
//     The token is cached on the instance until 60 s before its `exp` claim.
//   - Browse `/own?action=browse&page=N[&sort=views]` -> `{ results, hasMore }`
//     (20 a page); search `/own?action=search&q=` (one page, no paging).
//   - Series `/own?action=series&slug=` carries every chapter inline as
//     `{ id, number, title, pageCount }` (ids are opaque strings). No lock fields
//     have been seen; names like `isLocked` / `is_premium` are honoured anyway.
//   - Pages `/own?action=pages&chapterId=` -> signed image URLs
//     (`?md5=...&expires=<unix s>`), no Referer needed. Covers are unsigned.
//   - Site pages: series `/manga/<slug>`, reader `/reader/<slug>/<number>`.
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
  withoutQuery,
} from "@riwaq/manga-themes";

const ID = "kawaii-manga";
const BASE_URL = "https://kawaiimanga.org";
const API_URL = "https://manga-api.kawaii-anime.com/api/manga";
const APP_KEY = "km_2026_live";
/** Renew this long before the token's own expiry. */
const MARGIN_MS = 60_000;
/** Validity assumed for a token whose `exp` cannot be read. */
const FALLBACK_MS = 1_740_000;

interface ApiManga {
  slug?: string;
  title?: string;
  titleEn?: string;
  titleAr?: string | null;
  description?: string | null;
  coverUrl?: string | null;
  author?: string | null;
  artist?: string | null;
  type?: string | null;
  status?: string | null;
  genres?: unknown;
  chapters?: ApiChapter[];
}

interface ApiChapter {
  id?: string | number;
  number?: number | string;
  title?: string;
  isLocked?: boolean;
  is_locked?: boolean;
  locked?: boolean;
  isPremium?: boolean;
  is_premium?: boolean;
}

const STATUS: Record<string, string> = {
  ongoing: "Ongoing",
  coming_soon: "Ongoing",
  completed: "Completed",
  cancelled: "Cancelled",
  dropped: "Cancelled",
};

const TYPE: Record<string, string> = { manga: "Manga", manhua: "Manhua", manhwa: "Manhwa" };

function parseJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${ID}: ${what} is not valid JSON`);
  }
}

/** Expiry (epoch ms) from a JWT's payload, or undefined when it cannot be read. */
function jwtExpiry(token: string): number | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const exp = (JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))) as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

const slugOf = (url: string): string => {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return (parts[0] === "manga" || parts[0] === "reader") && parts[1] ? decodeURIComponent(parts[1]) : "";
  } catch {
    return "";
  }
};

export default function createSource(host: SourceHost): Source {
  const t = mangaStrings(host.locale);
  const request = createCheckedRequest(host, ID);
  const hostname = new URL(BASE_URL).hostname;

  let token: { value: string; validUntil: number } | undefined;
  let inflight: Promise<string> | undefined;
  /** reader url -> the API's chapter id, filled by getNovel. */
  const chapterIds = new Map<string, string>();

  async function fetchToken(): Promise<string> {
    const resp = await request(`${API_URL}/token`, { headers: { "x-app-key": APP_KEY, accept: "application/json" } });
    const data = parseJson<{ token?: unknown }>(resp.text, "the token response");
    if (typeof data.token !== "string" || !data.token) throw new Error(`${ID}: the token response has no token`);
    const exp = jwtExpiry(data.token);
    token = { value: data.token, validUntil: (exp ?? Date.now() + FALLBACK_MS) - (exp === undefined ? 0 : MARGIN_MS) };
    return data.token;
  }

  /** The cached token, or one fetch shared by every caller waiting for it. */
  function getToken(): Promise<string> {
    if (token && Date.now() < token.validUntil) return Promise.resolve(token.value);
    inflight ??= fetchToken().finally(() => {
      inflight = undefined;
    });
    return inflight;
  }

  /** GET an API url. A 401 renews the token once and retries; a second one is an error. */
  async function api<T>(url: string): Promise<T> {
    let used = "";
    const send = async () => {
      used = await getToken();
      return request(url, { headers: { "x-app-key": APP_KEY, "x-app-token": used, accept: "application/json" } });
    };
    let resp: Awaited<ReturnType<typeof send>>;
    try {
      resp = await send();
    } catch (e) {
      if (!(e instanceof Error) || !/ HTTP 401$/.test(e.message)) throw e;
      // Drop the rejected token, but not a newer one a parallel call already fetched.
      if (token?.value === used) token = undefined;
      resp = await send();
    }
    return parseJson<T>(resp.text, url);
  }

  const seriesUrl = (slug: string) => `${BASE_URL}/manga/${encodeURIComponent(slug)}`;
  const cardOf = (m: ApiManga): NovelCard | undefined => {
    const title = sanitizeText(m.title) || sanitizeText(m.titleEn);
    if (!m.slug || !title) return undefined;
    return {
      url: seriesUrl(m.slug),
      title,
      coverUrl: m.coverUrl || undefined,
      subtitle: sanitizeText(m.titleAr) || undefined,
      contentType: "manga",
    };
  };

  async function list(path: string): Promise<{ cards: NovelCard[]; hasMore: boolean }> {
    const data = await api<{ results?: ApiManga[]; hasMore?: boolean }>(`${API_URL}/own?${path}`);
    const cards = (data.results ?? []).map(cardOf).filter((c): c is NovelCard => c !== undefined);
    return { cards, hasMore: data.hasMore === true };
  }

  async function loadSeries(slug: string): Promise<ApiManga> {
    const manga = await api<ApiManga>(`${API_URL}/own?action=series&slug=${encodeURIComponent(slug)}`);
    if (!manga || typeof manga.title !== "string" || !Array.isArray(manga.chapters)) {
      throw new Error(`${ID}: ${seriesUrl(slug)} has no series data`);
    }
    return manga;
  }

  const numberOf = (c: ApiChapter): number | undefined => {
    const n = typeof c.number === "number" ? c.number : Number(String(c.number ?? "").trim());
    return String(c.number ?? "").trim() !== "" && Number.isFinite(n) ? n : undefined;
  };

  async function getChapterPages(chapter: SourceChapter) {
    if (chapter.lock) throw lockedError(ID, chapter);
    let chapterId = chapterIds.get(chapter.url);
    if (!chapterId) {
      // A fresh instance (or a chapter restored from storage): read the series.
      const slug = slugOf(chapter.url);
      if (!slug) throw new Error(`${ID}: ${chapter.url} is not a chapter page`);
      for (const c of (await loadSeries(slug)).chapters ?? []) {
        const n = numberOf(c);
        if (c.id !== undefined && n !== undefined) chapterIds.set(`${BASE_URL}/reader/${encodeURIComponent(slug)}/${n}`, String(c.id));
      }
      chapterId = chapterIds.get(chapter.url);
    }
    if (!chapterId) throw new Error(`${ID}: ${chapter.url} is not in the series' chapter list`);

    const data = await api<{ pages?: unknown }>(`${API_URL}/own?action=pages&chapterId=${encodeURIComponent(chapterId)}`);
    const urls = (Array.isArray(data.pages) ? data.pages : []).filter((p): p is string => typeof p === "string" && p !== "");
    if (urls.length === 0) throw new Error(`${ID}: ${chapter.url} lists no page images`);
    const pages: PageRef[] = urls.map((url) => ({ url, cacheKey: withoutQuery(url) }));
    const expires = urls
      .map((u) => Number(/[?&]expires=(\d+)/.exec(u)?.[1]))
      .filter((n) => Number.isFinite(n) && n > 0);
    return expires.length ? { pages, expiresAt: Math.min(...expires) * 1000 } : { pages };
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
      const [latest, popular] = await Promise.all([list("action=browse&page=1"), list("action=browse&page=1&sort=views")]);
      return [
        { id: "latest", title: t.latest, cards: latest.cards },
        { id: "popular", title: t.popular, cards: popular.cards },
      ];
    },

    async search(query): Promise<SourceSearchResult> {
      const q = query.trim();
      if (!q) return { cards: [], hasMore: false, query: q, page: 1 };
      const { cards } = await list(`action=search&q=${encodeURIComponent(q)}`);
      return { cards, hasMore: false, query: q, page: 1 };
    },

    async getNovel(url): Promise<SourceNovel> {
      const slug = slugOf(url);
      if (!slug) throw new Error(`${ID}: ${url} is not a series page`);
      const manga = await loadSeries(slug);

      const chapters: SourceChapter[] = [];
      for (const c of manga.chapters ?? []) {
        const number = numberOf(c);
        if (number === undefined || c.id === undefined) continue;
        const chapterUrl = `${BASE_URL}/reader/${encodeURIComponent(slug)}/${number}`;
        const base = t.chapter(number);
        const own = sanitizeText(c.title);
        // The API's default title is the Arabic "الفصل N"; anything else is a real subtitle.
        const subtitle = own && own !== mangaStrings("ar").chapter(number) && own !== base ? own : "";
        const chapter: SourceChapter = {
          id: chapterIdFromUrl(chapterUrl),
          title: subtitle ? `${base} - ${subtitle}` : base,
          url: chapterUrl,
          number,
          lines: [],
        };
        if (c.isLocked || c.is_locked || c.locked || c.isPremium || c.is_premium) {
          chapter.lock = { reason: "locked", openUrl: chapterUrl };
        }
        chapterIds.set(chapterUrl, String(c.id));
        chapters.push(chapter);
      }
      chapters.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));

      const person = (v: string | null | undefined) => {
        const s = sanitizeText(v);
        return s.toLowerCase() === "unknown" ? "" : s;
      };
      const type = TYPE[manga.type ?? ""];
      const genres = Array.isArray(manga.genres) ? manga.genres.map((g) => sanitizeText(String(g))).filter(Boolean) : [];
      return {
        title: sanitizeText(manga.title),
        author: person(manga.author) || person(manga.artist),
        originalTitle: sanitizeText(manga.titleEn) && manga.titleEn !== manga.title ? sanitizeText(manga.titleEn) : undefined,
        language: "ar",
        direction: "rtl",
        coverUrl: manga.coverUrl || undefined,
        description: htmlToText(manga.description ?? undefined) || undefined,
        tags: [...new Set([...(type ? [type] : []), ...genres])],
        status: STATUS[manga.status ?? ""],
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
