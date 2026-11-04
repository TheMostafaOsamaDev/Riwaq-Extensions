import type { Locale } from "@riwaq/extension-api";

/** Strings this extension synthesises itself. Extensions ship their own
 *  copy — they cannot reach the app's message catalogue. Both locales are
 *  required so this satisfies Record<Locale, ...> below.
 *
 *  - homeTrending / homeEditorsChoice / homeLatestUpdates title the three
 *    home rows. The English values are the site's own headings, but the
 *    site sets them in its page markup and JS, not in the JSON the rows
 *    come from, so they are restated here (and translated for `ar`).
 *  - allChapters titles getNovel's single pseudo-volume: the site has no
 *    volume concept, just one flat chapter list.
 *  - chapterFallback names a chapter the API lists without a name (the
 *    site's own reader falls back to the same "Chapter N").
 *  - meta* label the rows getNovel lifts into `meta`; ratingValue formats
 *    the rating row's value (the site rates out of 5, passed as {max}).
 *  - status* name the site's three release statuses (the values its own
 *    library filter knows); any other value is shown as the site wrote it.
 */
const CATALOG = {
  en: {
    homeTrending: "Trending",
    homeEditorsChoice: "Editor's Choice",
    homeLatestUpdates: "Latest Updates",
    allChapters: "All Chapters",
    chapterFallback: "Chapter {n}",
    metaChapters: "Chapters",
    metaViews: "Views",
    metaRating: "Rating",
    ratingValue: "{score} / {max} ({count} ratings)",
    metaLatestRelease: "Latest release",
    metaUpdated: "Last updated",
    metaAltTitles: "Alternative titles",
    statusOngoing: "Ongoing",
    statusCompleted: "Completed",
    statusHiatus: "Hiatus",
  },
  ar: {
    homeTrending: "الأكثر رواجًا",
    homeEditorsChoice: "اختيارات المحررين",
    homeLatestUpdates: "آخر التحديثات",
    allChapters: "كل الفصول",
    chapterFallback: "الفصل {n}",
    metaChapters: "عدد الفصول",
    metaViews: "المشاهدات",
    metaRating: "التقييم",
    ratingValue: "{score} / {max} ({count} تقييم)",
    metaLatestRelease: "آخر إصدار",
    metaUpdated: "آخر تحديث",
    metaAltTitles: "عناوين بديلة",
    statusOngoing: "مستمرة",
    statusCompleted: "مكتملة",
    statusHiatus: "متوقفة مؤقتًا",
  },
} satisfies Record<Locale, Record<string, string>>;

export type StringKey = keyof typeof CATALOG.en;

export function strings(locale: Locale) {
  const dict = CATALOG[locale] ?? CATALOG.en;
  return (key: StringKey, params?: Record<string, string | number>) =>
    dict[key].replace(/\{(\w+)\}/g, (m, k) => (params && k in params ? String(params[k]) : m));
}
