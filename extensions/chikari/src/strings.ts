import type { Locale } from "@riwaq/extension-api";

/** Strings this extension synthesises itself, for cases the site leaves
 *  unlabelled. Extensions ship their own copy — they cannot reach the app's
 *  message catalogue. Both locales are required so this satisfies
 *  Record<Locale, ...> below.
 *
 *  home* — the five novel rows `GET /api/home?type=novel` returns arrive as
 *  bare slugs (`trending`, `popular`, ...); the headings live in the site's
 *  own client bundle, not in the API response. The `en` values are those
 *  headings verbatim. `homeBingeable` is there because the site's table has
 *  a sixth row the novel feed has not been seen to send — see index.ts's
 *  HOME_ROWS.
 *
 *  status* — the site's own labels for its `status` values (`releasing`,
 *  `completed`, ...), again taken verbatim from its client bundle.
 *
 *  chapterFallback — a chapter whose `title` is empty. The site renders the
 *  same "Chapter <n>" fallback itself.
 *
 *  cardLatest — the card subtitle naming the newest chapter, matching the
 *  site's own "Ch. <n>" card label.
 *
 *  volumeFallback — getNovel's single pseudo-volume (the site has no
 *  volumes; every chapter row's `volume` field is ""). */
const CATALOG = {
  en: {
    homeTrending: "Trending",
    homePopular: "Popular",
    homeTopRated: "Top Rated",
    homeBingeable: "Complete & Bingeable",
    homeRecentlyUpdated: "Recently Updated",
    homeRecentlyAdded: "Recently Added",
    statusReleasing: "Releasing",
    statusCompleted: "Completed",
    statusHiatus: "Hiatus",
    statusCancelled: "Cancelled",
    statusUpcoming: "Upcoming",
    volumeFallback: "Chapters",
    chapterFallback: "Chapter {n}",
    cardLatest: "Ch. {n}",
    metaChapters: "Chapters",
    metaRating: "Rating",
    metaRatingValue: "{score} / 10 ({count} ratings)",
    metaViews: "Views",
    metaUpdated: "Last updated",
    metaYear: "Year",
    metaAltTitles: "Alternative titles",
  },
  ar: {
    homeTrending: "الأكثر رواجًا",
    homePopular: "الأكثر شعبية",
    homeTopRated: "الأعلى تقييمًا",
    homeBingeable: "مكتملة وجاهزة للقراءة المتواصلة",
    homeRecentlyUpdated: "المحدّثة مؤخرًا",
    homeRecentlyAdded: "المضافة حديثًا",
    statusReleasing: "مستمرة",
    statusCompleted: "مكتملة",
    statusHiatus: "متوقفة مؤقتًا",
    statusCancelled: "ملغاة",
    statusUpcoming: "قادمة",
    volumeFallback: "الفصول",
    chapterFallback: "الفصل {n}",
    cardLatest: "الفصل {n}",
    metaChapters: "عدد الفصول",
    metaRating: "التقييم",
    metaRatingValue: "{score} / 10 ({count} تقييم)",
    metaViews: "المشاهدات",
    metaUpdated: "آخر تحديث",
    metaYear: "السنة",
    metaAltTitles: "عناوين بديلة",
  },
} satisfies Record<Locale, Record<string, string>>;

export type StringKey = keyof typeof CATALOG.en;

export function strings(locale: Locale) {
  const dict = CATALOG[locale] ?? CATALOG.en;
  return (key: StringKey, params?: Record<string, string | number>) =>
    dict[key].replace(/\{(\w+)\}/g, (m, k) => (params && k in params ? String(params[k]) : m));
}
