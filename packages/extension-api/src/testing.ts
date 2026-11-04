import type { Locale, SourceHost, SourceLine } from "./types";

export interface TestHostOptions {
  /** Map of URL (or a substring of one) to the response body to return. Lookup
   *  prefers an exact match, then the first key the URL contains. */
  responses?: Record<string, string>;
  /** Bytes for fetchBytes, keyed the same way. */
  byteResponses?: Record<string, Uint8Array>;
  /** HTTP status for `fetch`, keyed the same way as `responses` — so a host
   *  name ("example.com") answers every URL on it. A URL no key matches
   *  answers 200. */
  status?: Record<string, number>;
  /** Response headers for `fetch` (lower-cased names, as `FetchResponse`
   *  promises), keyed the same way. None when no key matches. */
  headers?: Record<string, Record<string, string>>;
  locale?: Locale;
  /** Collects every request the extension made, so a test can assert on the
   *  URL, method and body an extension sent — not just what it parsed. */
  calls?: Array<{ url: string; method: string; body?: string }>;
  /** Collects every `host.log` call, in order. */
  logs?: Array<{ level: "debug" | "info" | "warn" | "error"; message: string }>;
}

/** A SourceHost backed by fixtures. Every capability either serves a canned
 *  response or throws a clear error, so a test never reaches the network. */
export function createTestHost(options: TestHostOptions = {}): SourceHost {
  const {
    responses = {},
    byteResponses = {},
    status = {},
    headers = {},
    locale = "en",
    calls = [],
    logs = [],
  } = options;

  const find = <T,>(table: Record<string, T>, url: string): T | undefined => {
    if (url in table) return table[url];
    const key = Object.keys(table).find((k) => url.includes(k));
    return key === undefined ? undefined : table[key];
  };

  const lookup = <T,>(table: Record<string, T>, url: string, kind: string): T => {
    const found = find(table, url);
    if (found === undefined) {
      throw new Error(
        `createTestHost: no ${kind} fixture for ${url}. Known keys: ${Object.keys(table).join(", ") || "(none)"}`,
      );
    }
    return found;
  };

  return {
    locale,
    async fetch(url, opts) {
      calls.push({ url, method: opts?.method ?? "GET", body: opts?.body });
      return {
        status: find(status, url) ?? 200,
        text: lookup(responses, url, "text"),
        headers: { ...find(headers, url) },
      };
    },
    async fetchBytes(url, opts) {
      calls.push({ url, method: opts?.method ?? "GET", body: opts?.body });
      return lookup(byteResponses, url, "bytes");
    },
    async renderAndExtract() {
      throw new Error(
        "createTestHost: renderAndExtract is not available in tests. Extensions that need it cannot be unit-tested — prefer static fetch.",
      );
    },
    log(level, message) {
      logs.push({ level, message });
    },
    pdf: {
      async extractChapter(): Promise<SourceLine[]> {
        throw new Error(
          "createTestHost: pdf.extractChapter is not stubbed. Pass a fake host explicitly if your test needs it.",
        );
      },
    },
  };
}
