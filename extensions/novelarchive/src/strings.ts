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
 *    the rating row's value.
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
    ratingValue: "{score} / 5 ({count} ratings)",
    metaLatestRelease: "Latest release",
    metaUpdated: "Updated",
    metaAltNames: "Also known as",
  },
  ar: {
    homeTrending: "الأكثر رواجًا",
    homeEditorsChoice: "اختيارات المحررين",
    homeLatestUpdates: "آخر التحديثات",
    allChapters: "جميع الفصول",
    chapterFallback: "الفصل {n}",
    metaChapters: "عدد الفصول",
    metaViews: "المشاهدات",
    metaRating: "التقييم",
    ratingValue: "{score} / 5 ({count} تقييم)",
    metaLatestRelease: "آخر إصدار",
    metaUpdated: "آخر تحديث",
    metaAltNames: "أسماء أخرى",
  },
} satisfies Record<Locale, Record<string, string>>;

export function strings(locale: Locale) {
  const dict = CATALOG[locale] ?? CATALOG.en;
  return (key: keyof typeof CATALOG.en, params?: Record<string, string | number>) =>
    dict[key].replace(/\{(\w+)\}/g, (m, k) => (params && k in params ? String(params[k]) : m));
}
