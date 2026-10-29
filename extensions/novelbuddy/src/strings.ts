import type { Locale } from "@riwaq/extension-api";

/** Strings this extension synthesises itself, for cases the site leaves
 *  unlabelled. Extensions ship their own copy — they cannot reach the app's
 *  message catalogue. Both locales are required so this satisfies
 *  Record<Locale, ...> below.
 *
 *  - `allChapters` titles the single volume `getNovel` returns: the site has
 *    no volume concept of its own, just one flat chapter list.
 *  - `chapterFallback` titles a chapter row the API sent without a name
 *    (never observed, but a blank row in a 6,000-chapter list is worse than
 *    a numbered one).
 *  - `meta*` label the definition-list rows `getNovel` lifts off the novel
 *    page. The site shows these as icons and bare numbers, not as labelled
 *    fields, so there is no heading on the page to read them from. */
const CATALOG = {
  en: {
    allChapters: "All Chapters",
    chapterFallback: "Chapter {n}",
    metaType: "Type",
    metaChapters: "Chapters",
    metaRating: "Rating",
    metaViews: "Views",
    metaBookmarks: "Bookmarks",
    metaReleased: "Released",
    metaUpdated: "Last updated",
  },
  ar: {
    allChapters: "جميع الفصول",
    chapterFallback: "الفصل {n}",
    metaType: "النوع",
    metaChapters: "الفصول",
    metaRating: "التقييم",
    metaViews: "المشاهدات",
    metaBookmarks: "الإشارات المرجعية",
    metaReleased: "تاريخ الإصدار",
    metaUpdated: "آخر تحديث",
  },
} satisfies Record<Locale, Record<string, string>>;

export type StringKey = keyof typeof CATALOG.en;

export function strings(locale: Locale) {
  const dict = CATALOG[locale] ?? CATALOG.en;
  return (key: StringKey, params?: Record<string, string | number>) =>
    dict[key].replace(/\{(\w+)\}/g, (m, k) => (params && k in params ? String(params[k]) : m));
}
