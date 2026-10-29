import { describe, expect, it } from "vitest";
import { createTestHost, type TestHostOptions } from "./testing";

describe("createTestHost", () => {
  it("answers 200 with no headers unless told otherwise", async () => {
    const host = createTestHost({ responses: { "/a": "body" } });
    expect(await host.fetch("https://x.test/a")).toEqual({ status: 200, text: "body", headers: {} });
  });

  it("looks status and headers up per URL the way it looks up bodies", async () => {
    const host = createTestHost({
      responses: { "x.test": "fallback", "https://x.test/busy": "slow down" },
      status: { "/busy": 429, "/broken": 503 },
      headers: { "/busy": { "retry-after": "7" } },
    });
    expect(await host.fetch("https://x.test/busy")).toEqual({
      status: 429,
      text: "slow down",
      headers: { "retry-after": "7" },
    });
    expect((await host.fetch("https://x.test/broken")).status).toBe(503);
    expect(await host.fetch("https://x.test/fine")).toEqual({ status: 200, text: "fallback", headers: {} });
  });

  it("collects log calls in order", () => {
    const logs: NonNullable<TestHostOptions["logs"]> = [];
    const host = createTestHost({ logs });
    host.log("info", "one");
    host.log("warn", "two");
    expect(logs).toEqual([
      { level: "info", message: "one" },
      { level: "warn", message: "two" },
    ]);
  });
});
