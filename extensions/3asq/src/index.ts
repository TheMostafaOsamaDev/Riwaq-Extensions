// 3asq (مانجا العاشق) — 3asq.online, a Madara-theme manga site. Everything
// site-specific is the config; the scraping lives in the shared template.
import { createMadaraSource } from "@riwaq/manga-themes";
import type { SourceHost } from "@riwaq/extension-api";

export default (host: SourceHost) =>
  createMadaraSource(host, { id: "3asq", baseUrl: "https://3asq.online" });
