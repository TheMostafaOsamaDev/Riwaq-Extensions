// KolNovel source (ملوك الروايات) — kolnovel.com. This merges what used to
// ship as two separate extensions: a free mirror at free.kolnovel.com and
// the main site at kolnovel.com. The free mirror now 301-redirects to the
// main domain, so they are the same site today, and `canHandle` accepts
// every hostname either extension ever matched — including free.kolnovel.com
// and kolnovel.online — so URLs already saved in a user's library keep
// resolving after the merge.
//
// Discovery (home, search, novel page) is delegated to ./theme.ts, the
// DOM parsers for the site's "starless" theme.
//
// Chapter lists are lazy: the novel page carries every volume's name and
// chapter count but no chapter rows, and each volume's rows come from
//
//   GET /wp-admin/admin-ajax.php?action=kol_series_volume_chapters
//         &nonce=<page nonce>&series_id=<id>&volume=<name>&page=<n>
//     → { success: true, data: { html, page, pages, total } }   (50 rows a page)
//
// so `getNovel` returns volumes with empty `chapters[]` and `getVolumeChapters`
// fills one on demand, cenele-style.
//
// Chapter content is read HTML-first from the page's `.epcontent` body
// (translated text + official illustrations, served inline). That covers
// every chapter the free mirror ever served, plus some the main site
// serves ONLY as a downloadable PDF — for those, we fall back to the
// site's token-gated download flow:
//
//   token:  POST /wp-admin/admin-ajax.php  action=ts_ln_dl_url&post_id=<id>
//             → { error:0, url: "https://kolnovel.com/<chapter>/pdf/?tspdftoken=<token>" }
//   bytes:  GET <token url>  → application/pdf
//
// Neither path is allowed to come back empty-handed: if the HTML body parses
// to nothing AND the PDF extracts to nothing, `getChapterContent` throws with
// the chapter URL in the message rather than returning `[]`, which the reader
// would render as a blank page indistinguishable from a genuinely empty
// chapter. The three ways the token request itself can fail are three
// separately-named errors — see `requestPdfUrl`.
//
// The downloaded bytes are handed to `host.pdf.extractChapter` — PDF parsing
// itself is NOT done here. pdf.js is far too heavy to bundle into an
// extension (the build enforces a size ceiling specifically to catch that
// kind of mistake), so the host owns the one shared pdf.js instance and this
// extension only ever sees the bytes going in and SourceLines coming out.
//
// Search uses the site's WordPress results page: `GET /?s=<query>`, then
// `/page/<N>/?s=<query>` for later pages, 20 results each.

import {
  absoluteUrl,
  parseHtml,
  type ExtractedImage,
  type Source,
  type SourceHost,
  type SourceLine,
} from "@riwaq/extension-api";
import {
  numberChapters,
  parseChapterContent,
  parseChapterIndex,
  parseHomeSections,
  parseNovelPage,
  parseSearchResults,
  parseVolumeChapterRows,
  type ChapterIndex,
  type ChapterRow,
} from "./theme";

const BASE_URL = "https://kolnovel.com";
const AJAX_URL = `${BASE_URL}/wp-admin/admin-ajax.php`;
/** Pages of one volume's listing in flight at once. A 2,756-chapter volume
 *  is 56 pages; one after another that is most of a minute. */
const PAGE_CONCURRENCY = 6;

export default function createSource(host: SourceHost): Source {
  // Images extracted from chapter PDFs during getChapterContent, keyed by
  // the ref emitted in image SourceLines. The host reads them back through
  // resolveImage. Cleared at the start of every PDF extraction (and in
  // getNovel) so the map holds one chapter's images, not a session's.
  const imageStore = new Map<string, ExtractedImage>();
  let lastNovelTitle: string | undefined;
  // The novel page's chapter index (series id, nonce, volume names and
  // counts), keyed by novel URL. getVolumeChapters needs it and is often
  // called with no getNovel this session — the app reopens a saved novel
  // from its snapshot — so a miss refetches the page.
  const indexCache = new Map<string, ChapterIndex>();

  async function loadIndex(novelUrl: string): Promise<ChapterIndex> {
    const resp = await host.fetch(novelUrl);
    const index = parseChapterIndex(parseHtml(resp.text), BASE_URL);
    if (!index) {
      throw new Error(
        `kolnovel: couldn't find the chapter index on ${novelUrl} — the layout may have changed.`,
      );
    }
    indexCache.set(novelUrl, index);
    return index;
  }

  return {
    hasLazyVolumes: true,

    canHandle(url) {
      try {
        const h = new URL(url).hostname.toLowerCase();
        // free.kolnovel.com 301s to kolnovel.com and kolnovel.online is a
        // mirror; both are accepted so URLs already saved in a user's library
        // keep resolving after the merge.
        return (
          h === "kolnovel.com" ||
          h === "www.kolnovel.com" ||
          h === "free.kolnovel.com" ||
          h === "kolnovel.online"
        );
      } catch {
        return false;
      }
    },

    async getHomeSections() {
      host.log("info", "getHomeSections");
      const resp = await host.fetch(BASE_URL + "/");
      return parseHomeSections(parseHtml(resp.text), BASE_URL, host);
    },

    async search(query, page = 1) {
      const trimmed = query.trim();
      // An empty query is a real, correct empty result — nothing to search
      // for — not a reason to fetch the site's own "no search term" page.
      // Every extension in this repo answers it the same way.
      if (!trimmed) {
        return { cards: [], hasMore: false, query: trimmed, page: 1 };
      }
      const n = Math.max(1, Math.floor(page));
      const path = n > 1 ? `/page/${n}/` : "/";
      const url = `${BASE_URL}${path}?${new URLSearchParams({ s: trimmed })}`;
      host.log("info", `search(${trimmed}, ${n}) → ${url}`);
      const resp = await host.fetch(url);
      return parseSearchResults(parseHtml(resp.text), BASE_URL, trimmed, n);
    },

    async getNovel(url) {
      host.log("info", `getNovel(${url})`);
      imageStore.clear();
      const resp = await host.fetch(url);
      const doc = parseHtml(resp.text);
      const novel = parseNovelPage(doc, BASE_URL, url, host);
      const index = parseChapterIndex(doc, BASE_URL);
      if (index) indexCache.set(url, index);
      lastNovelTitle = novel.title;
      return novel;
    },

    async getVolumeChapters(novelUrl, volume) {
      host.log("debug", `getVolumeChapters(${novelUrl}, #${volume.id})`);
      let index = indexCache.get(novelUrl) ?? (await loadIndex(novelUrl));
      // Find the volume by its site name (`key`), not by position: a saved
      // snapshot's ids were assigned on an earlier visit, and a volume added
      // since shifts every position after it.
      const findVolume = (ix: ChapterIndex) => {
        const pos =
          volume.key !== undefined
            ? ix.volumes.findIndex((v) => v.key === volume.key)
            : volume.id - 1;
        return pos >= 0 && pos < ix.volumes.length ? pos : -1;
      };
      let pos = findVolume(index);
      if (pos < 0) {
        index = await loadIndex(novelUrl);
        pos = findVolume(index);
      }
      if (pos < 0) {
        throw new Error(
          `kolnovel: volume "${volume.key ?? volume.title}" is no longer listed on ${novelUrl}.`,
        );
      }
      // Ids run across the whole novel, oldest volume first, so chapter n of
      // the novel keeps id n whichever volume is loaded first.
      const startId = 1 + index.volumes.slice(0, pos).reduce((sum, v) => sum + v.count, 0);

      let rows: ChapterRow[];
      try {
        rows = await fetchVolumeRows(host, index, index.volumes[pos].key);
      } catch (e) {
        if (!(e instanceof NonceRejected)) throw e;
        // WordPress nonces expire within a day; a long-lived session (or a
        // cached index) holds a stale one. Reload the page once for a fresh
        // nonce before giving up.
        index = await loadIndex(novelUrl);
        rows = await fetchVolumeRows(host, index, index.volumes[pos].key);
      }
      return numberChapters(rows, startId, host);
    },

    async getChapterContent(chapter): Promise<SourceLine[]> {
      host.log("debug", `getChapterContent(#${chapter.id}) ${chapter.url}`);
      // HTML-first: most chapters serve their text + official illustrations
      // inline in `.epcontent`. Read that directly — no PDF round-trip, no
      // token flow.
      const resp = await host.fetch(chapter.url);
      const htmlLines = parseChapterContent(parseHtml(resp.text), BASE_URL);
      // Any extracted content means the chapter is readable as HTML. No
      // minimum-length gate: legitimately short or image-heavy chapters
      // serve their full body inline too, and a length heuristic would
      // wrongly route them to the PDF endpoint (which fails for HTML-only
      // chapters). Empty → PDF fallback.
      if (htmlLines.length > 0) return htmlLines;

      host.log("debug", `no HTML body — falling back to PDF for ${chapter.url}`);
      // Drop the previous call's refs before minting new ones. getNovel is
      // the only other place this is cleared, and a reader that opens
      // chapter after chapter from a snapshot never calls getNovel at all —
      // so without this the map grows for the whole session, holding every
      // image of every PDF chapter ever opened. Clearing here is safe
      // because a ref is only ever resolved between the getChapterContent
      // call that minted it and the next one on this instance (see
      // Source.resolveImage in @riwaq/extension-api).
      imageStore.clear();
      const postId = extractPostId(chapter.url);
      if (!postId) {
        throw new Error(`kolnovel: couldn't find a post id in chapter URL: ${chapter.url}`);
      }
      const pdfUrl = await requestPdfUrl(host, postId, chapter.url);
      const bytes = await host.fetchBytes(pdfUrl);
      assertPdf(bytes, chapter.url);

      let counter = 0;
      const pdfLines = await host.pdf.extractChapter(bytes, {
        chapterUrl: chapter.url,
        novelTitle: lastNovelTitle,
        mintImageRef: (img) => {
          const ref = `kolnovel:img:${postId}:${++counter}`;
          imageStore.set(ref, img);
          return ref;
        },
      });
      // Refuse loudly rather than hand back a hollow chapter. Both paths have
      // now come up empty: the HTML body parsed to nothing (which is what sent
      // us here) and the PDF extracted to nothing either. Returning `[]` would
      // import a chapter the reader renders as a blank page — indistinguishable
      // from a chapter that is genuinely empty, and silent at every layer above
      // this one. The URL is in the message because that is the only handle a
      // user has when reporting it.
      if (pdfLines.length === 0) {
        throw new Error(
          `kolnovel: extracted no content for ${chapter.url} — the chapter page had no ` +
            "readable HTML body and its downloaded PDF produced no lines.",
        );
      }
      return pdfLines;
    },

    async resolveImage(ref) {
      return imageStore.get(ref) ?? null;
    },
  };
}

/** The AJAX endpoint answered `-1`/HTTP 403 or `success: false`: the nonce
 *  it was given is stale or wrong. */
class NonceRejected extends Error {}

/** Every row of one volume, oldest first. Page 1 says how many pages there
 *  are; the rest are fetched a few at a time. A chapter published between
 *  two page requests shifts the listing by one row, so rows are de-duplicated
 *  by URL. */
async function fetchVolumeRows(host: SourceHost, index: ChapterIndex, key: string): Promise<ChapterRow[]> {
  const first = await fetchVolumePage(host, index, key, 1);
  const pages: ChapterRow[][] = [first.rows];
  let next = 2;
  const worker = async () => {
    while (next <= first.pages) {
      const n = next++;
      pages[n - 1] = (await fetchVolumePage(host, index, key, n)).rows;
    }
  };
  await Promise.all(Array.from({ length: Math.min(PAGE_CONCURRENCY, first.pages - 1) }, worker));
  const seen = new Set<string>();
  const rows = pages.flat().filter((r) => !seen.has(r.url) && seen.add(r.url));
  return rows.reverse();
}

async function fetchVolumePage(
  host: SourceHost,
  index: ChapterIndex,
  key: string,
  page: number,
): Promise<{ rows: ChapterRow[]; pages: number }> {
  const params = new URLSearchParams({
    action: "kol_series_volume_chapters",
    nonce: index.nonce,
    series_id: index.seriesId,
    volume: key,
    page: String(page),
  });
  const resp = await host.fetch(`${index.ajaxUrl}?${params}`, {
    headers: { Accept: "application/json" },
  });
  // A refused nonce comes back as the bare body `-1`, which is valid JSON.
  let json: { success?: boolean; data?: { html?: unknown; pages?: unknown } } | -1 | null;
  try {
    json = JSON.parse(resp.text);
  } catch {
    json = null;
  }
  if (resp.status === 403 || json === -1 || json?.success === false) {
    throw new NonceRejected(
      `kolnovel: the chapter-list endpoint refused series ${index.seriesId} (HTTP ${resp.status}).`,
    );
  }
  const data = json === null ? undefined : json.data;
  if (!data || typeof data.html !== "string" || typeof data.pages !== "number") {
    throw new Error(
      `kolnovel: the chapter-list endpoint returned an unexpected response for series ` +
        `${index.seriesId}, volume "${key}", page ${page} (HTTP ${resp.status}).`,
    );
  }
  return { rows: parseVolumeChapterRows(parseHtml(data.html), BASE_URL), pages: Math.max(1, data.pages) };
}

/** The WordPress post id is the trailing number in the chapter permalink,
 *  e.g. ".../...z435ggye-275085/" → "275085". Tolerate a trailing "/pdf/"
 *  download segment and any query/hash so the permalink and its PDF-download
 *  variant (".../-275085/pdf/?tspdftoken=…") both resolve to the same id. */
function extractPostId(url: string): string | null {
  const path = url.replace(/[?#].*$/, "").replace(/\/pdf\/?$/i, "");
  const m = path.match(/-(\d+)\/?$/);
  return m ? m[1] : null;
}

/** POST the ts_ln_dl_url action and return the tokenized PDF URL.
 *
 *  The three ways this can fail are reported as three different errors on
 *  purpose. They have different causes and different fixes, and the single
 *  "members-only or removed" message this used to raise for all of them was a
 *  guess presented as a diagnosis — it named a cause the code had not
 *  established, which is worse than saying less. Verified against the live
 *  endpoint (2026-09-18):
 *
 *    post_id=293246     → {"error":0,"url":"https://kolnovel.com/…/pdf/?tspdftoken=…"}
 *    post_id= (empty)   → {"error":403,"url":""}
 *    post_id=999999999  → {"error":0,"url":"/pdf/?tspdftoken=…"}   ← relative!
 *
 *  That last one is why the returned url is resolved against BASE_URL rather
 *  than passed through: for a post id the site does not recognise it reports
 *  success and hands back a ROOT-RELATIVE url with the novel segment missing.
 *  Forwarding that string straight to `host.fetchBytes` asks the host to fetch
 *  a relative URL; resolving it produces a real absolute URL that then fails
 *  the `%PDF` check below with a message that says what actually happened.
 *  For a normal response the url is already absolute and resolving is a no-op. */
async function requestPdfUrl(
  host: SourceHost,
  postId: string,
  chapterUrl: string,
): Promise<string> {
  const body = `action=ts_ln_dl_url&post_id=${encodeURIComponent(postId)}`;
  const resp = await host.fetch(AJAX_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body,
  });

  let json: { error?: number; url?: string } | null;
  try {
    json = JSON.parse(resp.text) as { error?: number; url?: string } | null;
  } catch {
    throw new Error(
      `kolnovel: the PDF token endpoint returned non-JSON for ${chapterUrl} ` +
        `(HTTP ${resp.status}).`,
    );
  }
  if (json === null || typeof json !== "object") {
    throw new Error(
      `kolnovel: the PDF token endpoint returned JSON that is not an object for ${chapterUrl} ` +
        `(HTTP ${resp.status}).`,
    );
  }
  if (json.error !== 0) {
    const code = json.error === undefined ? "absent" : String(json.error);
    throw new Error(
      `kolnovel: the PDF token endpoint refused post ${postId} for ${chapterUrl} ` +
        `(error code ${code}). The site answers 403 here for a post id it does not accept.`,
    );
  }
  if (!json.url) {
    throw new Error(
      `kolnovel: the PDF token endpoint reported success for post ${postId} ` +
        `(${chapterUrl}) but returned no download url.`,
    );
  }
  return absoluteUrl(json.url, BASE_URL);
}

/** Guard: the download endpoint answers with an HTML page rather than a file
 *  in several situations — the un-tokenized `/pdf/` path serves a small JS
 *  loader whose own script POSTs `ts_ln_dl_url` and redirects (captured in
 *  tests/fixtures/pdf-loader.html), and an expired token or a members-only
 *  chapter produce an error/login page the same way.
 *
 *  This is a magic-byte check rather than a Content-Type check because the
 *  extension cannot see the content type at all: `SourceHost.fetchBytes`
 *  returns `Promise<Uint8Array>`, with no headers alongside it (only the text
 *  `fetch` returns a `FetchResponse` carrying `headers`). The first four bytes
 *  are the only evidence available on this path.
 *
 *  The message reports the chapter URL and what actually arrived, because
 *  "was not a PDF" alone cannot be acted on: a user forwarding the error, and
 *  a maintainer reading it later, need to be able to tell an HTML loader page
 *  from an empty body from a CDN challenge without re-running the download. */
function assertPdf(bytes: Uint8Array, chapterUrl: string): void {
  // `>= 4`, not `> 4`: the check reads bytes 0-3, so four bytes is exactly
  // enough to evaluate it. `> 4` was right only by accident — no 4-byte
  // file is a valid PDF, so nothing was ever wrongly rejected — but the
  // bound should say what the code below actually needs.
  const ok =
    bytes.length >= 4 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46; // F
  if (!ok) {
    throw new Error(
      `kolnovel: the tokenized download for ${chapterUrl} was not a PDF — expected a ` +
        `%PDF header, got ${describeBytes(bytes)}. The site serves an HTML loader or ` +
        "login page here when the token has expired or the chapter is members-only.",
    );
  }
}

/** A short, safe description of what came back instead of a PDF: the length
 *  plus the first few bytes as printable ASCII (anything else as `.`), so an
 *  HTML page reads as `<html>` in the message without risking a dump of an
 *  arbitrary binary body into a log. */
function describeBytes(bytes: Uint8Array): string {
  let prefix = "";
  for (const byte of bytes.slice(0, 8)) {
    prefix += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".";
  }
  return `${bytes.length} bytes starting "${prefix}"`;
}
