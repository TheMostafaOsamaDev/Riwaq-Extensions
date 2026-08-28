import type { Locale } from "@riwaq/extension-api";

/** The handful of strings this extension synthesises itself, for the cases the
 *  site leaves unlabelled. Extensions ship their own copy — they cannot reach
 *  the app's message catalogue. Values match what Riwaq shipped before the
 *  split, so imported books keep their existing titles. */
const CATALOG = {
  en: { volumeFallback: "Volume {n}", chapterNoTitleFallback: "{n} - No Title" },
  ar: { volumeFallback: "المجلد {n}", chapterNoTitleFallback: "{n} - بلا عنوان" },
} satisfies Record<Locale, Record<string, string>>;

export function strings(locale: Locale) {
  const dict = CATALOG[locale] ?? CATALOG.en;
  return (key: keyof typeof CATALOG.en, params?: Record<string, string | number>) =>
    dict[key].replace(/\{(\w+)\}/g, (m, k) => (params && k in params ? String(params[k]) : m));
}
