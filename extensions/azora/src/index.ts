// Azora (ازورا مانجا) — azorafly.com, an Iken-family manga site. Everything
// site-specific is the config; the API calls live in the shared template.
import { createIkenSource } from "@riwaq/manga-themes";
import type { SourceHost } from "@riwaq/extension-api";

export default (host: SourceHost) =>
  createIkenSource(host, {
    id: "azora",
    baseUrl: "https://azorafly.com",
    apiUrl: "https://api.azorafly.com",
  });
