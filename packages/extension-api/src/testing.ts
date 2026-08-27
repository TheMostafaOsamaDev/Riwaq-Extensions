import type { Locale, SourceHost, SourceLine } from "./types";

export interface TestHostOptions {
  /** Map of URL (or a substring of one) to the response body to return. Lookup
   *  prefers an exact match, then the first key the URL contains. */
  responses?: Record<string, string>;
  /** Bytes for fetchBytes, keyed the same way. */
  byteResponses?: Record<string, Uint8Array>;
  locale?: Locale;
  /** Collects every request the extension made, so a test can assert on the
   *  URL, method and body an extension sent — not just what it parsed. */
  calls?: Array<{ url: string; method: string; body?: string }>;
}

/** A SourceHost backed by fixtures. Every capability either serves a canned
 *  response or throws a clear error, so a test never reaches the network. */
export function createTestHost(options: TestHostOptions = {}): SourceHost {
  const { responses = {}, byteResponses = {}, locale = "en", calls = [] } = options;

  const lookup = <T,>(table: Record<string, T>, url: string, kind: string): T => {
    if (url in table) return table[url];
    const key = Object.keys(table).find((k) => url.includes(k));
    if (key === undefined) {
      throw new Error(
        `createTestHost: no ${kind} fixture for ${url}. Known keys: ${Object.keys(table).join(", ") || "(none)"}`,
      );
    }
    return table[key];
  };

  return {
    locale,
    async fetch(url, opts) {
      calls.push({ url, method: opts?.method ?? "GET", body: opts?.body });
      return { status: 200, text: lookup(responses, url, "text"), headers: {} };
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
    log() {},
    pdf: {
      async extractChapter(): Promise<SourceLine[]> {
        throw new Error(
          "createTestHost: pdf.extractChapter is not stubbed. Pass a fake host explicitly if your test needs it.",
        );
      },
    },
  };
}
