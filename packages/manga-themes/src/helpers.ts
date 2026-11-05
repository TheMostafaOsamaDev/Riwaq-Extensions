import {
  createFetcher,
  parseHtml,
  sanitizeText,
  type ChapterPages,
  type FetchOptions,
  type FetchResponse,
  type SourceChapter,
  type SourceHost,
  type SourceLine,
} from "@riwaq/extension-api";

/** Arabic-Indic (U+0660-0669) and Persian (U+06F0-06F9) digits to 0-9. */
function foldDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (c) => {
    const code = c.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

/** First number in a chapter label. A dash between two numbers reads as a
 *  decimal point (slug `1155-5` is chapter 1155.5). */
export function parseChapterNumber(text: string): number | undefined {
  const m = /(\d+)(?:[.\-](\d+))?/.exec(foldDigits(text));
  if (!m) return undefined;
  return Number(m[2] === undefined ? m[1] : `${m[1]}.${m[2]}`);
}

/** The chapter number in a chapter URL's last path segment. An absolute URL
 *  carries that segment percent-encoded (`الفصل-12` is `%D8%A7…-12`, whose
 *  escapes would read as 8), so it is decoded first; an invalid escape leaves
 *  the raw text. */
export function chapterNumberFromUrl(url: string): number | undefined {
  const segment = url.split(/[?#]/)[0].split("/").filter(Boolean).pop() ?? "";
  let text = segment;
  try {
    text = decodeURIComponent(segment);
  } catch {
    // Keep the raw segment.
  }
  return parseChapterNumber(text);
}

/** FNV-1a 32-bit over the URL's UTF-16 code units, masked to 31 bits; never 0. */
export function chapterIdFromUrl(url: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const id = h & 0x7fffffff;
  return id === 0 ? 1 : id;
}

export function pagesAsLines(pages: ChapterPages): SourceLine[] {
  return pages.pages.map((p) => ({ type: "image" as const, content: p.url }));
}

/** Drops the query string, keeping only the params named in `keep`. */
export function withoutQuery(url: string, keep: string[] = []): string {
  const q = url.indexOf("?");
  if (q < 0) return url;
  const hash = url.indexOf("#", q);
  const base = url.slice(0, q);
  const frag = hash < 0 ? "" : url.slice(hash);
  const params = new URLSearchParams(url.slice(q + 1, hash < 0 ? undefined : hash));
  const kept = new URLSearchParams();
  for (const [k, v] of params) if (keep.includes(k)) kept.append(k, v);
  const qs = kept.toString();
  return base + (qs ? `?${qs}` : "") + frag;
}

export function lockedError(id: string, _chapter: SourceChapter): Error {
  return new Error(`${id}: chapter is locked`);
}

/** GET/POST through the retrying fetcher; a Cloudflare challenge and any other
 *  non-200 become `<id>: ...` errors instead of being parsed as content. */
export function createCheckedRequest(
  host: SourceHost,
  id: string,
): (url: string, init?: FetchOptions) => Promise<FetchResponse> {
  const fetcher = createFetcher(host, { id });
  return async (url, init) => {
    const resp = await fetcher(url, init);
    if (resp.status === 403 && (resp.headers["cf-mitigated"] ?? "").toLowerCase() === "challenge") {
      throw new Error(`${id}: blocked by a Cloudflare check`);
    }
    if (resp.status !== 200) throw new Error(`${id}: ${url} answered HTTP ${resp.status}`);
    return resp;
  };
}

/** HTML (or plain text) to plain text: tags gone, entities decoded, one paragraph or
 *  `<br>` per line, blank lines dropped. */
export function htmlToText(raw: string | undefined): string {
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
