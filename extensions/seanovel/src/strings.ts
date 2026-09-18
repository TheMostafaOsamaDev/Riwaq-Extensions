import type { Locale } from "@riwaq/extension-api";

/** Strings this extension synthesises itself, for cases the site leaves
 *  unlabelled (a volume with no title, a section with no heading, ...).
 *  Extensions ship their own copy — they cannot reach the app's message
 *  catalogue. Both locales are required so this satisfies
 *  Record<Locale, ...> below.
 *
 *  homeLatest/homePopular/homeCompleted label the three home-page rows
 *  getHomeSections synthesises from the catalogue — the API returns no
 *  section headings of its own to reuse.
 *
 *  volumeFallback labels getNovel's single pseudo-volume (the detail API
 *  has no concept of volumes at all — see index.ts's getNovel). metaOrigin
 *  and metaChapterCount label the two rows getNovel adds to `meta` from the
 *  detail API's `origin` and `chapters_count` fields. */
const CATALOG = {
  en: {
    homeLatest: "Latest",
    homePopular: "Popular",
    homeCompleted: "Completed",
    volumeFallback: "Volume {n}",
    metaOrigin: "Origin",
    metaChapterCount: "Chapters",
  },
  ar: {
    homeLatest: "الأحدث",
    homePopular: "الأكثر شعبية",
    homeCompleted: "مكتملة",
    volumeFallback: "المجلد {n}",
    metaOrigin: "الأصل",
    metaChapterCount: "عدد الفصول",
  },
} satisfies Record<Locale, Record<string, string>>;

export function strings(locale: Locale) {
  const dict = CATALOG[locale] ?? CATALOG.en;
  return (key: keyof typeof CATALOG.en, params?: Record<string, string | number>) =>
    dict[key].replace(/\{(\w+)\}/g, (m, k) => (params && k in params ? String(params[k]) : m));
}
