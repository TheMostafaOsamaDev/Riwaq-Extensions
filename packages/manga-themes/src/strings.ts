import type { Locale } from "@riwaq/extension-api";

export interface MangaStrings {
  latest: string;
  popular: string;
  part: (n: number) => string;
  chapter: (n: number | string) => string;
}

export function mangaStrings(locale: Locale): MangaStrings {
  if (locale === "ar") {
    return { latest: "آخر التحديثات", popular: "الأكثر مشاهدة", part: (n) => `الجزء ${n}`, chapter: (n) => `الفصل ${n}` };
  }
  return { latest: "Latest updates", popular: "Popular", part: (n) => `Part ${n}`, chapter: (n) => `Chapter ${n}` };
}
