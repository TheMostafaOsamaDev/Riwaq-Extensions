// One retry policy for `host.fetch`, so every extension that needs one
// behaves the same way. Extensions run in the app's webview (loaded with a
// blob `import()`), so timers exist and a retry can back off. The app's
// importer calls `getChapterContent` from 4 workers on ONE Source instance,
// which is why the rate-limit pause below lives on the fetcher, not on a
// single request: when the site says "slow down", every worker waits.
import type { FetchOptions, FetchResponse, SourceHost } from "./types";

export interface FetcherOptions {
  /** The manifest id; prefixes every error and log line. */
  id: string;
  /** Requests sent per call, first one included, across every reason to
   *  retry. Default 3. A POST/PUT/DELETE is never sent twice. */
  attempts?: number;
  /** Wait before the first retry of a thrown request or a 5xx; doubled for
   *  each retry after it, then scaled by a random 0.5–1.5 so concurrent
   *  callers spread out. Default 1000 ms. */
  retryDelayMs?: number;
  /** What a 429 means on this site.
   *  - "wait" (default): a rate limit. Every caller of this fetcher pauses
   *    for the response's Retry-After (or RateLimit-Reset), then the request
   *    is retried.
   *  - "challenge": a human-verification check a plain HTTP client cannot
   *    pass. The 429 is returned at once, and every call for the next
   *    `Retry-After` (or `defaultWaitMs`) fails fast without a request. */
  on429?: "wait" | "challenge";
  /** Wait used when a 429 says nothing usable. Default 60 s. */
  defaultWaitMs?: number;
  /** Ceiling on one 429 wait or cool-off. Default 300 s. */
  maxWaitMs?: number;
}

/** `host.fetch` with a retry policy. A thrown request that keeps failing
 *  throws `<id>: <url> could not be fetched: …`; a 5xx or 429 that outlasts
 *  the attempts is returned, so the caller reports the status its own way. */
export type Fetcher = (url: string, options?: FetchOptions) => Promise<FetchResponse>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Milliseconds a 429 asks for: `Retry-After` (delta-seconds or an
 *  HTTP-date), then `RateLimit-Reset` (delta-seconds), else `fallbackMs`.
 *  Clamped to [1 s, maxMs]. */
export function retryAfterMs(
  headers: Record<string, string>,
  fallbackMs: number,
  maxMs: number,
  now = Date.now(),
): number {
  let ms = fallbackMs;
  const retryAfter = (headers["retry-after"] ?? "").trim();
  const reset = (headers["ratelimit-reset"] ?? "").trim();
  if (/^\d+$/.test(retryAfter)) ms = Number(retryAfter) * 1000;
  else if (retryAfter && !Number.isNaN(Date.parse(retryAfter))) ms = Date.parse(retryAfter) - now;
  else if (/^\d+$/.test(reset)) ms = Number(reset) * 1000;
  return Math.min(Math.max(ms, 1000), maxMs);
}

export function createFetcher(host: SourceHost, options: FetcherOptions): Fetcher {
  const {
    id,
    attempts = 3,
    retryDelayMs = 1000,
    on429 = "wait",
    defaultWaitMs = 60_000,
    maxWaitMs = 300_000,
  } = options;

  /** Until when every call holds back: after a 429 in "wait" mode, the
   *  time the site said to come back; in "challenge" mode, the end of the
   *  cool-off. Shared by every concurrent caller. */
  let pausedUntil = 0;

  const backoff = (attempt: number) => retryDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random());

  return async function fetchWithRetry(url, init) {
    const method = init?.method ?? "GET";
    const budget = method === "GET" || method === "HEAD" ? Math.max(1, attempts) : 1;
    for (let attempt = 1; ; attempt++) {
      if (on429 === "challenge" && Date.now() < pausedUntil) {
        const seconds = Math.ceil((pausedUntil - Date.now()) / 1000);
        throw new Error(
          `${id}: ${url} was not requested — the site asked for a human-verification check (HTTP 429), so requests are held back for another ${seconds}s.`,
        );
      }
      // A loop, not one sleep: another caller's 429 can push the pause
      // further out while this one waits.
      while (Date.now() < pausedUntil) await sleep(pausedUntil - Date.now());

      let resp: FetchResponse;
      try {
        resp = await host.fetch(url, init);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt >= budget) throw new Error(`${id}: ${url} could not be fetched: ${message}`);
        host.log("debug", `${id}: ${url} failed (${message}); retrying.`);
        await sleep(backoff(attempt));
        continue;
      }

      if (resp.status === 429) {
        const wait = retryAfterMs(resp.headers, defaultWaitMs, maxWaitMs);
        pausedUntil = Math.max(pausedUntil, Date.now() + wait);
        if (on429 === "challenge" || attempt >= budget) return resp;
        host.log("warn", `${id}: ${url} answered HTTP 429; holding every request back ${Math.ceil(wait / 1000)}s.`);
        continue;
      }
      if (resp.status >= 500 && attempt < budget) {
        host.log("debug", `${id}: ${url} answered HTTP ${resp.status}; retrying.`);
        await sleep(backoff(attempt));
        continue;
      }
      return resp;
    }
  };
}
