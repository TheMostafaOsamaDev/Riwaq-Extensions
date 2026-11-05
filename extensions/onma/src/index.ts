// Onma (مانجا اون لاين) — onma.me, an MMRCMS manga site. Everything
// site-specific is the config; the page parsing lives in the shared template.
// (onma.top, the older domain, no longer resolves.)
import { createMmrcmsSource } from "@riwaq/manga-themes";
import type { SourceHost } from "@riwaq/extension-api";

export default (host: SourceHost) => createMmrcmsSource(host, { id: "onma", baseUrl: "https://onma.me" });
