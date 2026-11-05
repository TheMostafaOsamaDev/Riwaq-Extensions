import type { ChapterPages, SourceChapter, SourceLine } from "@riwaq/extension-api";

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
