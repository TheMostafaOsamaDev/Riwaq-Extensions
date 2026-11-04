import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_VERSION } from "./manifest";
import { pngSize, runValidate } from "./validate";

// A real, tiny, valid 1x1 PNG (the same bytes build.test.ts uses).
const ONE_PX_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

/** An extensions dir holding one otherwise-valid extension with this icon. */
function withIcon(icon: Buffer): string {
  const root = mkdtempSync(join(tmpdir(), "riwaq-validate-"));
  dirs.push(root);
  const dir = join(root, "fixture");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      id: "fixture",
      name: "Fixture",
      version: "1.0.0",
      apiVersion: API_VERSION,
      language: "en",
      baseUrl: "https://example.com",
      icon: "icon.png",
      description: { en: "Throwaway fixture for validate.test.ts." },
      author: "validate.test.ts",
    }),
  );
  writeFileSync(join(dir, "icon.png"), icon);
  return root;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("runValidate — icon.png", () => {
  it("passes every extension in the repo (each ships a 128×128 icon)", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runValidate()).toBe(true);
  });

  it("fails an icon of the wrong size, naming both sizes", () => {
    const errors: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation((msg: string) => errors.push(msg));
    expect(runValidate(withIcon(ONE_PX_PNG))).toBe(false);
    expect(errors[0]).toContain("extensions/fixture: icon.png is 1×1, expected 128×128");
  });

  it("fails a file that is not a PNG", () => {
    const errors: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation((msg: string) => errors.push(msg));
    expect(runValidate(withIcon(Buffer.from("GIF89a not a png at all")))).toBe(false);
    expect(errors[0]).toContain("extensions/fixture: icon.png is not a PNG");
  });
});

describe("pngSize", () => {
  it("reads width and height from the IHDR chunk", () => {
    expect(pngSize(ONE_PX_PNG)).toEqual({ width: 1, height: 1 });
  });
});
