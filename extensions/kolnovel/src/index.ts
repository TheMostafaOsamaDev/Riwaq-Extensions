// KolNovel source (ملوك الروايات) — kolnovel.com. This merges what used to
// ship as two separate extensions: a free mirror at free.kolnovel.com and
// the main site at kolnovel.com. The free mirror now 301-redirects to the
// main domain, so they are the same site today, and `canHandle` accepts
// every hostname either extension ever matched — including free.kolnovel.com
// and kolnovel.online — so URLs already saved in a user's library keep
// resolving after the merge.
//
// Discovery (home, search, novel page) is delegated to ./theme.ts, the
// shared KolNovel WordPress-theme DOM parsers. It is private to this
// extension now — there is no second KolNovel-family extension left to
// share it with.
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
// The downloaded bytes are handed to `host.pdf.extractChapter` — PDF parsing
// itself is NOT done here. pdf.js is far too heavy to bundle into an
// extension (the build enforces a size ceiling specifically to catch that
// kind of mistake), so the host owns the one shared pdf.js instance and this
// extension only ever sees the bytes going in and SourceLines coming out.
//
// Search uses the site's WordPress results page (`GET /?s=<query>`). See
// this extension's README: every match renders on one page and every
// pagination URL on this host returns HTTP 500, so `search` ignores its
// `page` argument and always reports `hasMore: false`.

import {
  parseHtml,
  type ExtractedImage,
  type Source,
  type SourceHost,
  type SourceLine,
} from "@riwaq/extension-api";
import {
  parseChapterContent,
  parseHomeSections,
  parseNovelPage,
  parseSearchResults,
} from "./theme";

const BASE_URL = "https://kolnovel.com";
const AJAX_URL = `${BASE_URL}/wp-admin/admin-ajax.php`;

export default function createSource(host: SourceHost): Source {
  // Images extracted from chapter PDFs during getChapterContent, keyed by
  // the ref emitted in image SourceLines. The host reads them back through
  // resolveImage. Cleared per novel so the map doesn't grow across imports.
  const imageStore = new Map<string, ExtractedImage>();
  let lastNovelTitle: string | undefined;

  return {
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

    async search(query) {
      const url = `${BASE_URL}/?${new URLSearchParams({ s: query })}`;
      host.log("info", `search(${query}) → ${url}`);
      const resp = await host.fetch(url);
      // KolNovel renders every match on one page, and BOTH `?s=<q>&paged=<N>`
      // and `/page/<N>/?s=<q>` return HTTP 500 on this host (verified against
      // the live site — see README). parseSearchResults derives `hasMore`
      // from the theme's `.pagination` block, which the theme does populate
      // on broad queries — so the `page` argument is ignored (there is only
      // ever a page 1 to fetch) and `hasMore` is forced to false here rather
      // than trusted from the DOM. A true value would offer a "Load more"
      // control whose click could only ever refetch the same page.
      return {
        ...parseSearchResults(parseHtml(resp.text), BASE_URL, query, 1),
        hasMore: false,
      };
    },

    async getNovel(url) {
      host.log("info", `getNovel(${url})`);
      imageStore.clear();
      const resp = await host.fetch(url);
      const novel = parseNovelPage(parseHtml(resp.text), BASE_URL, url, host);
      lastNovelTitle = novel.title;
      return novel;
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
      const postId = extractPostId(chapter.url);
      if (!postId) {
        throw new Error(`KolNovel: couldn't find a post id in chapter URL: ${chapter.url}`);
      }
      const pdfUrl = await requestPdfUrl(host, postId);
      const bytes = await host.fetchBytes(pdfUrl);
      assertPdf(bytes);

      let counter = 0;
      return host.pdf.extractChapter(bytes, {
        chapterUrl: chapter.url,
        novelTitle: lastNovelTitle,
        mintImageRef: (img) => {
          const ref = `kolnovel:img:${postId}:${++counter}`;
          imageStore.set(ref, img);
          return ref;
        },
      });
    },

    async resolveImage(ref) {
      return imageStore.get(ref) ?? null;
    },
  };
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

/** POST the ts_ln_dl_url action and return the tokenized PDF URL. */
async function requestPdfUrl(host: SourceHost, postId: string): Promise<string> {
  const body = `action=ts_ln_dl_url&post_id=${encodeURIComponent(postId)}`;
  const resp = await host.fetch(AJAX_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body,
  });
  let json: { error?: number; url?: string };
  try {
    json = JSON.parse(resp.text);
  } catch {
    throw new Error(`KolNovel: PDF token endpoint returned non-JSON (status ${resp.status})`);
  }
  if (!json || json.error !== 0 || !json.url) {
    throw new Error(`KolNovel: PDF not available for post ${postId} (members-only or removed)`);
  }
  return json.url;
}

/** Guard: the tokenized endpoint returns the JS loader HTML (not a PDF) when
 *  the token is missing/invalid or the chapter is members-only. */
function assertPdf(bytes: Uint8Array): void {
  const ok =
    bytes.length > 4 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46; // F
  if (!ok) {
    // requestPdfUrl already handled the members-only case; reaching here with
    // non-PDF bytes means the token expired or the endpoint returned an
    // error/login/CDN page instead of the file.
    throw new Error(
      "KolNovel: downloaded chapter was not a PDF (token may have expired, or the endpoint returned an error/login page).",
    );
  }
}
