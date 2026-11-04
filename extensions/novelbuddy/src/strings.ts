import type { Locale } from "@riwaq/extension-api";

/** Strings this extension synthesises itself. Extensions ship their own
 *  copy — they cannot reach the app's message catalogue. Both locales are
 *  required so this satisfies Record<Locale, ...> below.
 *
 *  - `home*` title the three home rows (index.ts's HOME_ROWS). The English
 *    values are the site's own headings, but those live in the page markup,
 *    not in the `__NEXT_DATA__` arrays the rows are read from.
 *  - `allChapters` titles the single volume `getNovel` returns: the site has
 *    no volume concept of its own, just one flat chapter list.
 *  - `chapterFallback` titles a chapter row the API sent without a name
 *    (never observed, but a blank row in a 6,000-chapter list is worse than
 *    a numbered one).
 *  - `meta*` label the definition-list rows `getNovel` lifts off the novel
 *    page; `ratingValue` formats the rating row's value. The site shows
 *    these as icons and bare numbers, so there is no heading to read.
 *  - `status*` are the site's four status values (its search filter lists
 *    ongoing, completed, hiatus, cancelled). */
const CATALOG = {
  en: {
    homeTrending: "Trending",
    homePopularUpdates: "Popular Updates",
    homeLatestUpdates: "Latest Updates",
    allChapters: "All Chapters",
    chapterFallback: "Chapter {n}",
    metaType: "Type",
    metaChapters: "Chapters",
    metaRating: "Rating",
    ratingValue: "{score} / {max} ({count} ratings)",
    metaViews: "Views",
    metaBookmarks: "Bookmarks",
    metaReleased: "Released",
    metaUpdated: "Last updated",
    statusOngoing: "Ongoing",
    statusCompleted: "Completed",
    statusHiatus: "Hiatus",
    statusCancelled: "Cancelled",
  },
  ar: {
    homeTrending: "الأكثر رواجًا",
    homePopularUpdates: "التحديثات الأكثر شعبية",
    homeLatestUpdates: "آخر التحديثات",
    allChapters: "كل الفصول",
    chapterFallback: "الفصل {n}",
    metaType: "النوع",
    metaChapters: "عدد الفصول",
    metaRating: "التقييم",
    ratingValue: "{score} / {max} ({count} تقييم)",
    metaViews: "المشاهدات",
    metaBookmarks: "الإشارات المرجعية",
    metaReleased: "تاريخ الإصدار",
    metaUpdated: "آخر تحديث",
    statusOngoing: "مستمرة",
    statusCompleted: "مكتملة",
    statusHiatus: "متوقفة مؤقتًا",
    statusCancelled: "ملغاة",
  },
} satisfies Record<Locale, Record<string, string>>;

export type StringKey = keyof typeof CATALOG.en;

export function strings(locale: Locale) {
  const dict = CATALOG[locale] ?? CATALOG.en;
  return (key: StringKey, params?: Record<string, string | number>) =>
    dict[key].replace(/\{(\w+)\}/g, (m, k) => (params && k in params ? String(params[k]) : m));
}
