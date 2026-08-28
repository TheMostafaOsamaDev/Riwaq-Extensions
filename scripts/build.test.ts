import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { API_VERSION } from "./manifest";
import type { ExtensionManifest } from "./manifest";
import { assertNoDuplicateIds, runBuild } from "./build";
import type { RepoIndex } from "./build";

// A real, tiny, valid 1x1 PNG — real bytes rather than a text file wearing
// a .png extension, in case anything ever sniffs the content.
const ONE_PX_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

interface FixtureOptions {
  sourceBody?: string;
  skipIcon?: boolean;
  manifestOverrides?: Record<string, unknown>;
}

/** Writes a minimal, real extension directory (manifest.json, icon.png,
 *  src/index.ts) under extensionsDir/<id>. By default the fixture's
 *  default export calls the bundled @riwaq/extension-api helper
 *  `sanitizeText`, so build.test.ts also proves the pure helper actually
 *  travels with (and runs inside) the emitted bundle, not just that the
 *  import resolves. */
function writeFixtureExtension(
  extensionsDir: string,
  id: string,
  options: FixtureOptions = {},
): void {
  const dir = join(extensionsDir, id);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      id,
      name: `Fixture ${id}`,
      version: "1.0.0",
      apiVersion: API_VERSION,
      language: "en",
      baseUrl: "https://example.com",
      icon: "icon.png",
      description: { en: `Throwaway fixture extension "${id}" for build.test.ts.` },
      author: "build.test.ts",
      ...options.manifestOverrides,
    }),
  );
  if (!options.skipIcon) {
    writeFileSync(join(dir, "icon.png"), ONE_PX_PNG);
  }
  writeFileSync(
    join(dir, "src/index.ts"),
    options.sourceBody ??
      `import { sanitizeText } from "@riwaq/extension-api";

export default function createSource() {
  return { id: "${id}", label: sanitizeText("  hello   world  ") };
}
`,
  );
}

/** Loads an emitted bundle's default export and calls it, in a genuinely
 *  separate `node` subprocess rather than a dynamic `import()` in this
 *  process. Vitest's own module runner intercepts in-process dynamic
 *  imports and refuses to load files outside the project root (the temp
 *  dir fixtures live under the OS tmpdir, e.g. /private/var/folders/...
 *  or /tmp), so a plain `import()` here fails with "Failed to load url
 *  ... Does the file exist?" even though the file plainly exists. A
 *  child `node --input-type=module` process has no such restriction, and
 *  is arguably a more faithful check anyway: it proves the bundle is
 *  valid ESM under plain Node/V8, independent of any bundler-specific
 *  module runner. */
function importDefaultAndCall(bundlePath: string): { type: string; result: unknown } {
  const href = pathToFileURL(bundlePath).href;
  const script = `import(${JSON.stringify(href)}).then((m) => {
    console.log(JSON.stringify({ type: typeof m.default, result: m.default() }));
  });`;
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
  });
  return JSON.parse(stdout.trim());
}

/** Runs `fn` against a fresh temp extensions/dist pair, and guarantees the
 *  whole temp tree is removed afterwards even if an assertion inside `fn`
 *  throws. */
async function withTempDirs<T>(
  fn: (dirs: { extensionsDir: string; distDir: string }) => Promise<T>,
): Promise<T> {
  const tmpRoot = mkdtempSync(join(tmpdir(), "riwaq-build-test-"));
  try {
    return await fn({
      extensionsDir: join(tmpRoot, "extensions"),
      distDir: join(tmpRoot, "dist"),
    });
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

describe("runBuild (end-to-end against real fixtures)", () => {
  let tmpRoot: string;
  let extensionsDir: string;
  let distDir: string;
  let index: RepoIndex;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "riwaq-build-test-"));
    extensionsDir = join(tmpRoot, "extensions");
    distDir = join(tmpRoot, "dist");
    writeFixtureExtension(extensionsDir, "fixture-a");
    writeFixtureExtension(extensionsDir, "fixture-b");
    const result = await runBuild({ extensionsDir, distDir });
    index = result.index;
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("writes a dist/index.min.json that parses, with the repo-level fields", () => {
    const raw = readFileSync(join(distDir, "index.min.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.name).toBe("Riwaq Official Extensions");
    expect(parsed.apiVersion).toBe(API_VERSION);
    expect(Array.isArray(parsed.extensions)).toBe(true);
  });

  it("emits exactly one entry per fixture extension", () => {
    expect(index.extensions).toHaveLength(2);
    expect(index.extensions.map((e) => e.id).sort()).toEqual(["fixture-a", "fixture-b"]);
  });

  it("computes sha256 and size matching a freshly computed hash of the emitted file", () => {
    expect(index.extensions.length).toBeGreaterThan(0);
    for (const entry of index.extensions) {
      const bundlePath = join(distDir, entry.id, "index.js");
      const bytes = readFileSync(bundlePath);
      const freshHash = createHash("sha256").update(bytes).digest("hex");
      expect(entry.sha256).toBe(freshHash);
      expect(entry.size).toBe(bytes.byteLength);
    }
  });

  it("writes code/icon paths relative to the index — no leading slash, no URL", () => {
    expect(index.extensions.length).toBeGreaterThan(0);
    for (const entry of index.extensions) {
      expect(entry.code).toBe(`${entry.id}/index.js`);
      expect(entry.icon).toBe(`${entry.id}/icon.png`);
      for (const path of [entry.code, entry.icon]) {
        expect(path.startsWith("/")).toBe(false);
        expect(path.startsWith("http")).toBe(false);
      }
    }
  });

  it("copies manifest.json and icon.png alongside each bundle", () => {
    expect(index.extensions.length).toBeGreaterThan(0);
    for (const entry of index.extensions) {
      expect(existsSync(join(distDir, entry.id, "manifest.json"))).toBe(true);
      expect(existsSync(join(distDir, entry.id, "icon.png"))).toBe(true);
    }
  });

  it("emits valid ESM with a default export, and the bundled @riwaq/extension-api helper actually runs", () => {
    expect(index.extensions.length).toBeGreaterThan(0);
    for (const entry of index.extensions) {
      const bundlePath = join(distDir, entry.id, "index.js");
      // Loading the real emitted file in a plain node subprocess is the
      // strongest possible check that it is valid ESM (a syntax error
      // would reject the import, not just fail a regex match against the
      // text) and that the default export is a working factory, not just
      // present.
      const { type, result } = importDefaultAndCall(bundlePath);
      expect(type).toBe("function");
      expect(result).toEqual({ id: entry.id, label: "hello world" });
    }
  });
});

describe("runBuild with zero extensions present", () => {
  it("writes an empty, well-formed catalogue instead of failing", async () => {
    await withTempDirs(async ({ extensionsDir, distDir }) => {
      // extensionsDir is intentionally never created — mirrors the real
      // repo today, which has no extensions/ directory at all yet.
      const result = await runBuild({ extensionsDir, distDir });
      expect(result.index).toEqual({
        name: "Riwaq Official Extensions",
        apiVersion: API_VERSION,
        extensions: [],
      });
      const onDisk = JSON.parse(readFileSync(join(distDir, "index.min.json"), "utf8"));
      expect(onDisk).toEqual(result.index);
    });
  });
});

describe("runBuild failure modes", () => {
  it("fails, naming the extension, when icon.png is missing", async () => {
    await withTempDirs(async ({ extensionsDir, distDir }) => {
      writeFixtureExtension(extensionsDir, "no-icon", { skipIcon: true });
      await expect(runBuild({ extensionsDir, distDir })).rejects.toThrow(/no-icon/);
    });
  });

  it("fails, naming the extension and the field, when the manifest is invalid", async () => {
    await withTempDirs(async ({ extensionsDir, distDir }) => {
      writeFixtureExtension(extensionsDir, "bad-manifest", {
        manifestOverrides: { icon: "logo.svg" },
      });
      await expect(runBuild({ extensionsDir, distDir })).rejects.toThrow(/"icon"/);
    });
  });

  it("fails, naming the extension, when the entry file has no default export", async () => {
    await withTempDirs(async ({ extensionsDir, distDir }) => {
      // A named-only `export function createSource` bundles cleanly and
      // hashes cleanly — the whole point of this test is that runBuild
      // itself must still refuse it, because the host only ever calls a
      // module's *default* export.
      writeFixtureExtension(extensionsDir, "no-default-export", {
        sourceBody: `export function createSource() {
  return { id: "no-default-export" };
}
`,
      });

      let error: Error | undefined;
      try {
        await runBuild({ extensionsDir, distDir });
      } catch (err) {
        error = err as Error;
      }

      expect(error).toBeDefined();
      expect(error?.message).toMatch(/no-default-export/);
      expect(error?.message).toMatch(/default export/);
      expect(error?.message).toMatch(/createSource/);
    });
  });

  it("fails, naming the extension and explaining why, when the bundle exceeds 512 KB", async () => {
    await withTempDirs(async ({ extensionsDir, distDir }) => {
      // A literal string this size in the *source* survives minification
      // basically unchanged (minifiers strip whitespace/rename
      // identifiers; they do not shrink string contents), so this
      // reliably produces a >512 KB bundle without mocking anything.
      const filler = "a".repeat(700_000);
      writeFixtureExtension(extensionsDir, "too-big", {
        sourceBody:
          `const filler = ${JSON.stringify(filler)};\n` +
          `export default function createSource() {\n` +
          `  return { id: "too-big", size: filler.length };\n` +
          `}\n`,
      });

      let error: Error | undefined;
      try {
        await runBuild({ extensionsDir, distDir });
      } catch (err) {
        error = err as Error;
      }

      expect(error).toBeDefined();
      expect(error?.message).toMatch(/too-big/);
      expect(error?.message).toMatch(/512/);
      expect(error?.message).toMatch(/host/i);
      expect(error?.message).toMatch(/pdf/i);
    });
  });
});

describe("assertNoDuplicateIds", () => {
  function fixtureManifest(overrides: Partial<ExtensionManifest> = {}): ExtensionManifest {
    return {
      id: "fixture",
      name: "Fixture",
      version: "1.0.0",
      apiVersion: API_VERSION,
      language: "en",
      baseUrl: "https://example.com",
      icon: "icon.png",
      description: { en: "fixture" },
      author: "test",
      ...overrides,
    };
  }

  // validateManifest already requires id === its own directory name, so
  // two *distinct* directories can never both pass validation with the
  // same id — see the task report for the full argument. That makes this
  // branch unreachable through runBuild's real, filesystem-backed
  // pipeline, so it is exercised directly here instead of through an
  // end-to-end fixture (which would require contriving a directory that
  // fails its own id-matches-directory-name rule).
  it("passes when every id is unique", () => {
    expect(() =>
      assertNoDuplicateIds([
        { dirName: "a", manifest: fixtureManifest({ id: "a" }) },
        { dirName: "b", manifest: fixtureManifest({ id: "b" }) },
      ]),
    ).not.toThrow();
  });

  it("throws, naming both directories, when two extensions share an id", () => {
    expect(() =>
      assertNoDuplicateIds([
        { dirName: "dir-a", manifest: fixtureManifest({ id: "dup" }) },
        { dirName: "dir-b", manifest: fixtureManifest({ id: "dup" }) },
      ]),
    ).toThrow(/dir-a.*dir-b/);
  });
});
