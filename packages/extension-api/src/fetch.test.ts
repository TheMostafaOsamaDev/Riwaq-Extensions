import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFetcher, retryAfterMs } from "./fetch";
import { createTestHost, type TestHostOptions } from "./testing";
import type { FetchResponse, SourceHost } from "./types";

const URL_A = "https://x.test/a";
const ok = (text = "ok"): FetchResponse => ({ status: 200, text, headers: {} });
const status = (code: number, headers: Record<string, string> = {}): FetchResponse => ({
  status: code,
  text: `HTTP ${code}`,
  headers,
});

/** A host whose fetch answers each request with the next reply in turn (an
 *  Error is thrown), and records when each request went out. */
function scripted(replies: Array<FetchResponse | Error>, logs: NonNullable<TestHostOptions["logs"]> = []) {
  const sent: number[] = [];
  const host: SourceHost = {
    ...createTestHost({ logs }),
    async fetch() {
      sent.push(Date.now());
      const reply = replies.length > 1 ? replies.shift()! : replies[0];
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return { host, sent, logs };
}

beforeEach(() => {
  vi.useFakeTimers();
  // No jitter: every backoff is exactly retryDelayMs × 2^(n-1).
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createFetcher — transient failures", () => {
  it("returns a success at once, with one request", async () => {
    const { host, sent } = scripted([ok()]);
    expect(await createFetcher(host, { id: "x" })(URL_A)).toEqual(ok());
    expect(sent).toHaveLength(1);
  });

  it("retries a thrown request after a doubling backoff, then succeeds", async () => {
    const { host, sent, logs } = scripted([new Error("connection reset"), new Error("timeout"), ok()]);
    const pending = createFetcher(host, { id: "x" })(URL_A);
    await vi.runAllTimersAsync();
    expect(await pending).toEqual(ok());
    expect(sent.map((t) => t - sent[0])).toEqual([0, 1000, 3000]);
    expect(logs).toContainEqual({ level: "debug", message: `x: ${URL_A} failed (connection reset); retrying.` });
  });

  it("throws, prefixed with the id, once the attempts run out", async () => {
    const { host, sent } = scripted([new Error("connection reset")]);
    const pending = createFetcher(host, { id: "x", attempts: 2 })(URL_A);
    const assertion = expect(pending).rejects.toThrow(`x: ${URL_A} could not be fetched: connection reset`);
    await vi.runAllTimersAsync();
    await assertion;
    expect(sent).toHaveLength(2);
  });

  it("retries a 5xx and hands back the last one when it never recovers", async () => {
    const { host, sent } = scripted([status(502)]);
    const pending = createFetcher(host, { id: "x" })(URL_A);
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe(502);
    expect(sent).toHaveLength(3);
  });

  it("never retries a 4xx other than 429", async () => {
    const { host, sent } = scripted([status(404)]);
    expect((await createFetcher(host, { id: "x" })(URL_A)).status).toBe(404);
    expect(sent).toHaveLength(1);
  });

  it("never sends a POST twice", async () => {
    const { host, sent } = scripted([status(503)]);
    expect((await createFetcher(host, { id: "x" })(URL_A, { method: "POST", body: "q" })).status).toBe(503);
    expect(sent).toHaveLength(1);
  });
});

describe("createFetcher — 429 as a rate limit", () => {
  it("waits the Retry-After, warns, then retries", async () => {
    const { host, sent, logs } = scripted([status(429, { "retry-after": "7" }), ok()]);
    const pending = createFetcher(host, { id: "x" })(URL_A);
    await vi.advanceTimersByTimeAsync(6_999);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual(ok());
    expect(sent).toHaveLength(2);
    expect(logs.filter((l) => l.level === "warn").map((l) => l.message)).toEqual([
      `x: ${URL_A} answered HTTP 429; holding every request back 7s.`,
    ]);
  });

  it("holds every concurrent caller back until the pause ends", async () => {
    const { host, sent } = scripted([status(429, { "retry-after": "30" }), ok()]);
    const fetcher = createFetcher(host, { id: "x" });
    const first = fetcher(URL_A);
    await vi.advanceTimersByTimeAsync(0);
    // Asked while the pause is on: no request until it ends.
    const second = fetcher("https://x.test/b");
    const third = fetcher("https://x.test/c");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second, third]);
    expect(sent).toHaveLength(4);
    expect(sent.slice(1).every((t) => t - sent[0] === 30_000)).toBe(true);
  });

  it("hands back the 429 when the attempts run out, and later calls still wait", async () => {
    const { host, sent } = scripted([status(429, { "retry-after": "5" })]);
    const fetcher = createFetcher(host, { id: "x", attempts: 2 });
    const pending = fetcher(URL_A);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await pending).status).toBe(429);
    expect(sent).toHaveLength(2);
    const later = fetcher(URL_A);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(sent).toHaveLength(2);
    await vi.runAllTimersAsync();
    await later;
    expect(sent).toHaveLength(4);
  });

  it("caps a long Retry-After", async () => {
    const { host, sent } = scripted([status(429, { "retry-after": "86400" }), ok()]);
    const pending = createFetcher(host, { id: "x", maxWaitMs: 60_000 })(URL_A);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pending).toEqual(ok());
    expect(sent[1] - sent[0]).toBe(60_000);
  });
});

describe("createFetcher — 429 as a challenge", () => {
  it("returns the 429 at once and fails fast, without a request, until the cool-off ends", async () => {
    const { host, sent } = scripted([status(429), ok()]);
    const fetcher = createFetcher(host, { id: "x", on429: "challenge", defaultWaitMs: 120_000 });
    expect((await fetcher(URL_A)).status).toBe(429);
    await vi.advanceTimersByTimeAsync(119_000);
    await expect(fetcher("https://x.test/b")).rejects.toThrow(
      "x: https://x.test/b was not requested — the site asked for a human-verification check (HTTP 429), so requests are held back for another 1s.",
    );
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await fetcher("https://x.test/b")).toEqual(ok());
    expect(sent).toHaveLength(2);
  });

  it("still retries a 5xx", async () => {
    const { host, sent } = scripted([status(503), ok()]);
    const pending = createFetcher(host, { id: "x", on429: "challenge" })(URL_A);
    await vi.runAllTimersAsync();
    expect(await pending).toEqual(ok());
    expect(sent).toHaveLength(2);
  });
});

describe("retryAfterMs", () => {
  const now = Date.parse("2026-10-21T07:28:00Z");
  it("reads Retry-After seconds, then RateLimit-Reset, else the fallback", () => {
    expect(retryAfterMs({ "retry-after": "12", "ratelimit-reset": "40" }, 60_000, 300_000, now)).toBe(12_000);
    expect(retryAfterMs({ "ratelimit-reset": "40" }, 60_000, 300_000, now)).toBe(40_000);
    expect(retryAfterMs({}, 60_000, 300_000, now)).toBe(60_000);
    expect(retryAfterMs({ "retry-after": "soon" }, 60_000, 300_000, now)).toBe(60_000);
  });

  it("reads an HTTP-date Retry-After", () => {
    expect(retryAfterMs({ "retry-after": "Wed, 21 Oct 2026 07:28:30 GMT" }, 60_000, 300_000, now)).toBe(30_000);
  });

  it("clamps to [1 s, max]", () => {
    expect(retryAfterMs({ "retry-after": "0" }, 60_000, 300_000, now)).toBe(1_000);
    expect(retryAfterMs({ "retry-after": "9999" }, 60_000, 300_000, now)).toBe(300_000);
  });
});
