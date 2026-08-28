import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_VERSION, loadManifest } from "./manifest";
import { runBuild } from "./build";
import { scaffoldExtension } from "./new-extension";

/** Runs `fn` against a fresh temp directory (used as extensionsDir, and as
 *  the parent of a sibling distDir for the bundling test), and guarantees
 *  the whole temp tree is removed afterwards even if an assertion inside
 *  `fn` throws. Mirrors build.test.ts's withTempDirs. */
async function withTempRoot<T>(fn: (tmpRoot: string) => T | Promise<T>): Promise<T> {
  const tmpRoot = mkdtempSync(join(tmpdir(), "riwaq-new-extension-test-"));
  try {
    return await fn(tmpRoot);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

describe("scaffoldExtension", () => {
  it("writes a manifest that passes the real validator", async () => {
    await withTempRoot((tmpRoot) => {
      const extensionsDir = join(tmpRoot, "extensions");
      const { dir } = scaffoldExtension("my-site", { extensionsDir });
      expect(dir).toBe(join(extensionsDir, "my-site"));

      const manifest = loadManifest(dir);
      expect(manifest.id).toBe("my-site");
      expect(manifest.apiVersion).toBe(API_VERSION);
      expect(manifest.icon).toBe("icon.png");
      expect(manifest.description.en.length).toBeGreaterThan(0);
    });
  });

  it("writes src/index.ts, src/strings.ts and a test file wired to createTestHost", async () => {
    await withTempRoot((tmpRoot) => {
      const extensionsDir = join(tmpRoot, "extensions");
      const { dir } = scaffoldExtension("my-site", { extensionsDir });

      expect(existsSync(join(dir, "src/index.ts"))).toBe(true);
      expect(existsSync(join(dir, "src/strings.ts"))).toBe(true);

      const testFile = join(dir, "tests/my-site.test.ts");
      expect(existsSync(testFile)).toBe(true);
      const testSource = readFileSync(testFile, "utf8");
      expect(testSource).toContain("createTestHost");
      expect(testSource).toContain("../src/index");
    });
  });

  it("writes a real, correctly-sized 128x128 PNG icon", async () => {
    await withTempRoot((tmpRoot) => {
      const extensionsDir = join(tmpRoot, "extensions");
      const { dir } = scaffoldExtension("my-site", { extensionsDir });
      const bytes = readFileSync(join(dir, "icon.png"));

      // PNG signature, then the IHDR chunk's width/height (big-endian
      // uint32s at fixed offsets 16 and 20) — a real decoded image, not a
      // text file wearing a .png extension.
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(bytes.readUInt32BE(16)).toBe(128);
      expect(bytes.readUInt32BE(20)).toBe(128);
    });
  });

  it("rejects a non-kebab-case id and writes nothing", async () => {
    await withTempRoot((tmpRoot) => {
      const extensionsDir = join(tmpRoot, "extensions");
      expect(() => scaffoldExtension("MySite", { extensionsDir })).toThrow(/kebab-case/);
      expect(() => scaffoldExtension("my_site", { extensionsDir })).toThrow(/kebab-case/);
      expect(() => scaffoldExtension("-my-site", { extensionsDir })).toThrow(/kebab-case/);
      expect(existsSync(extensionsDir)).toBe(false);
    });
  });

  it("refuses an id that already exists", async () => {
    await withTempRoot((tmpRoot) => {
      const extensionsDir = join(tmpRoot, "extensions");
      scaffoldExtension("dup", { extensionsDir });
      expect(() => scaffoldExtension("dup", { extensionsDir })).toThrow(/already exists/);
    });
  });

  it("scaffolds an extension that bundles cleanly through the real build pipeline", async () => {
    await withTempRoot(async (tmpRoot) => {
      const extensionsDir = join(tmpRoot, "extensions");
      const distDir = join(tmpRoot, "dist");
      scaffoldExtension("bundle-check", { extensionsDir });

      const result = await runBuild({ extensionsDir, distDir });

      expect(result.index.extensions.map((e) => e.id)).toEqual(["bundle-check"]);
      expect(existsSync(join(distDir, "bundle-check/index.js"))).toBe(true);
    });
  });
});
