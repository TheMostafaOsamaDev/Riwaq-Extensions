import type { Locale } from "@riwaq/extension-api";

/** Strings this extension synthesises itself, for cases the site leaves
 *  unlabelled (a volume with no title, a section with no heading, ...).
 *  Extensions ship their own copy — they cannot reach the app's message
 *  catalogue. Replace "placeholder" with real keys as you need them; both
 *  locales are required so this satisfies Record<Locale, ...> below.
 *
 *  homeLatest/homePopular/homeCompleted label the three home-page rows
 *  getHomeSections synthesises from the catalogue — the API returns no
 *  section headings of its own to reuse. */
const CATALOG = {
  en: {
    placeholder: "Placeholder",
    homeLatest: "Latest",
    homePopular: "Popular",
    homeCompleted: "Completed",
  },
  ar: {
    placeholder: "Placeholder",
    homeLatest: "الأحدث",
    homePopular: "الأكثر شعبية",
    homeCompleted: "مكتملة",
  },
} satisfies Record<Locale, Record<string, string>>;

export function strings(locale: Locale) {
  const dict = CATALOG[locale] ?? CATALOG.en;
  return (key: keyof typeof CATALOG.en, params?: Record<string, string | number>) =>
    dict[key].replace(/\{(\w+)\}/g, (m, k) => (params && k in params ? String(params[k]) : m));
}
