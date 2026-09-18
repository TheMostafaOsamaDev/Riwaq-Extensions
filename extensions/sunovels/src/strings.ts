import type { Locale } from "@riwaq/extension-api";

/** Strings this extension synthesises itself, for cases the site leaves
 *  unlabelled (a volume with no title, a section with no heading, ...).
 *  Extensions ship their own copy — they cannot reach the app's message
 *  catalogue. Both locales are required so this satisfies
 *  Record<Locale, ...> below.
 *
 *  `allChapters` titles the single lazy volume `getNovel` returns: this
 *  site has no volume concept of its own, just one flat, paginated
 *  chapter list, so there is nothing on the page to read a label from. */
const CATALOG = {
  en: { allChapters: "All Chapters" },
  ar: { allChapters: "جميع الفصول" },
} satisfies Record<Locale, Record<string, string>>;

export function strings(locale: Locale) {
  const dict = CATALOG[locale] ?? CATALOG.en;
  return (key: keyof typeof CATALOG.en, params?: Record<string, string | number>) =>
    dict[key].replace(/\{(\w+)\}/g, (m, k) => (params && k in params ? String(params[k]) : m));
}
