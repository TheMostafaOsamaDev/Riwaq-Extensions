// Lava Scans (لافا سكانز) — lavascans.com, a MangaThemesia-family manga
// site with a custom skin. Everything site-specific is the config; the
// scraping lives in the shared template.
import { createThemesiaSource } from "@riwaq/manga-themes";
import type { SourceHost } from "@riwaq/extension-api";

export default (host: SourceHost) =>
  createThemesiaSource(host, { id: "lava-scans", baseUrl: "https://lavascans.com" });
