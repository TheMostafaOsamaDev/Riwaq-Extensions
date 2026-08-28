// Bundles every extensions/<id> into dist/<id>/index.js, copies
// manifest.json + icon.png alongside it, and writes dist/index.min.json —
// the catalogue the app fetches to discover, install and update
// extensions.
//
// @riwaq/extension-api is bundled INTO every extension, not marked
// external: the host only injects `host` capabilities at runtime, so the
// pure DOM/string helpers in the contract package have to travel with the
// extension itself. Resolution is handled by esbuild's `alias` option
// (pointed at the package's own source file) rather than relying on
// node_modules workspace-linking, so this also works unmodified for
// throwaway fixture extensions built from an arbitrary temp directory in
// build.test.ts, which were never `pnpm install`-ed as a workspace member.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadManifest, API_VERSION } from "./manifest";
import type { ExtensionManifest } from "./manifest";

// Deliberately not `fileURLToPath(new URL("..", import.meta.url))`: under
// vitest's happy-dom environment, resolving a ".." *relative reference*
// against this module's import.meta.url (i.e. calling the `URL`
// constructor with two arguments) silently resolves against happy-dom's
// fake `window.location` instead, producing a bogus
// "http://localhost:3000/@fs/..." URL — but only for a module reached via
// an *import* (like this one, from build.test.ts), not for a vitest entry
// file itself. `fileURLToPath` on this file's own URL (no relative
// resolution involved) plus plain path-segment arithmetic sidesteps that
// bug entirely and works identically under tsx and under vitest.
const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const DEFAULT_EXTENSIONS_DIR = join(REPO_ROOT, "extensions");
const DEFAULT_DIST_DIR = join(REPO_ROOT, "dist");
const EXTENSION_API_ENTRY = join(REPO_ROOT, "packages/extension-api/src/index.ts");

/** A bundle over this size almost certainly means a heavy dependency
 *  slipped in that belongs on `host` instead — pdf.js is the specific
 *  thing this guards against, since PDF parsing is a host capability an
 *  extension should never bundle for itself (see host.pdf in
 *  @riwaq/extension-api's SourceHost). */
const MAX_BUNDLE_BYTES = 512 * 1024;

export interface RepoIndexEntry {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  language: string;
  baseUrl: string;
  description: Record<string, string>;
  author: string;
  /** Relative to index.min.json itself, e.g. "cenele/index.js" — never a
   *  leading slash or an absolute URL, so a fork or mirror of this repo
   *  works without editing any URL. */
  code: string;
  /** Relative to index.min.json itself, e.g. "cenele/icon.png". */
  icon: string;
  sha256: string;
  size: number;
}

export interface RepoIndex {
  name: string;
  apiVersion: number;
  extensions: RepoIndexEntry[];
}

export interface RunBuildOptions {
  /** Defaults to <repoRoot>/extensions. */
  extensionsDir?: string;
  /** Defaults to <repoRoot>/dist. */
  distDir?: string;
}

export interface RunBuildResult {
  distDir: string;
  index: RepoIndex;
}

interface LoadedExtension {
  dirName: string;
  manifest: ExtensionManifest;
}

function listExtensionDirs(extensionsDir: string): string[] {
  if (!existsSync(extensionsDir)) return [];
  return readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Throws, naming both directories, the first time two extensions declare
 *  the same manifest `id`. Exported and unit-tested directly: in the
 *  normal pipeline this is actually unreachable (validateManifest already
 *  requires `id` to equal its own directory name, so two distinct
 *  directories can never validate to the same id — see build.test.ts and
 *  the task report for the full argument), but it stays as defense in
 *  depth against that invariant ever being loosened, and the brief asks
 *  for it explicitly. */
export function assertNoDuplicateIds(extensions: LoadedExtension[]): void {
  const seen = new Map<string, string>();
  for (const { dirName, manifest } of extensions) {
    const owner = seen.get(manifest.id);
    if (owner !== undefined) {
      throw new Error(
        `Extension id "${manifest.id}" is used by both extensions/${owner} and extensions/${dirName}`,
      );
    }
    seen.set(manifest.id, dirName);
  }
}

/** Confirms the just-written bundle actually has a default export, in a
 *  genuinely separate `node` subprocess rather than an in-process dynamic
 *  `import()`. Mirrors build.test.ts's `importDefaultAndCall`: vitest's
 *  module runner refuses in-process dynamic imports of files outside the
 *  project root (which is exactly where this runs from when `runBuild` is
 *  invoked with a temp-dir `distDir`, as build.test.ts does), so a plain
 *  `import()` here would fail with a confusing "Does the file exist?"
 *  even though it plainly does. A child `node --input-type=module`
 *  process has no such restriction, and doubles as proof the bundle is
 *  valid ESM under plain Node, independent of any bundler-specific
 *  module runner.
 *
 *  Without this, an extension whose src/index.ts exports only a named
 *  `createSource` (no `default`) bundles cleanly, hashes cleanly, and
 *  lands in index.min.json — the app then downloads it, evaluates it,
 *  and finds `mod.default === undefined` at runtime, with nothing here
 *  having pointed back at the cause. */
function assertHasDefaultExport(bundlePath: string, id: string): void {
  const href = pathToFileURL(bundlePath).href;
  const script = `import(${JSON.stringify(href)}).then(
    (m) => { console.log(JSON.stringify({ type: typeof m.default })); },
    (err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); },
  );`;
  let stdout: string;
  try {
    stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
    });
  } catch (err) {
    throw new Error(
      `Extension "${id}": bundled output (dist/${id}/index.js) failed to load as ESM — ` +
        `${(err as Error).message}`,
    );
  }
  const { type } = JSON.parse(stdout.trim()) as { type: string };
  if (type !== "function") {
    throw new Error(
      `Extension "${id}": the bundled module has no default export (its default is ${type}, ` +
        `not a function). Its entry file (src/index.ts) must ` +
        "`export default function createSource(host)` — a named-only `export function " +
        "createSource` is not enough; the host loads the module and calls its default export.",
    );
  }
}

async function bundleOne(
  dirName: string,
  manifest: ExtensionManifest,
  extensionsDir: string,
  distDir: string,
): Promise<RepoIndexEntry> {
  const dir = join(extensionsDir, dirName);
  const id = manifest.id;

  const iconSrc = join(dir, "icon.png");
  if (!existsSync(iconSrc)) {
    throw new Error(`Extension "${id}": missing icon.png`);
  }

  let contents: Uint8Array;
  try {
    const result = await build({
      entryPoints: [join(dir, "src/index.ts")],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      minify: true,
      legalComments: "none",
      outfile: join(distDir, id, "index.js"),
      alias: { "@riwaq/extension-api": EXTENSION_API_ENTRY },
      write: false,
    });
    contents = result.outputFiles[0].contents;
  } catch (err) {
    throw new Error(`Extension "${id}": bundling failed — ${(err as Error).message}`);
  }

  if (contents.byteLength > MAX_BUNDLE_BYTES) {
    const actualKb = (contents.byteLength / 1024).toFixed(1);
    const limitKb = MAX_BUNDLE_BYTES / 1024;
    throw new Error(
      `Extension "${id}": bundle is ${actualKb} KB, over the ${limitKb} KB limit. ` +
        "A bundle this large almost always means a heavy dependency slipped in that " +
        "belongs on `host` instead of being bundled — pdf.js is the canonical example: " +
        "PDF parsing is a host capability (see SourceHost.pdf in @riwaq/extension-api), " +
        "not something an extension should ship for itself.",
    );
  }

  const outDir = join(distDir, id);
  mkdirSync(outDir, { recursive: true });
  const bundlePath = join(outDir, "index.js");
  writeFileSync(bundlePath, contents);

  assertHasDefaultExport(bundlePath, id);

  copyFileSync(join(dir, "manifest.json"), join(outDir, "manifest.json"));
  copyFileSync(iconSrc, join(outDir, "icon.png"));

  const sha256 = createHash("sha256").update(contents).digest("hex");

  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    language: manifest.language,
    baseUrl: manifest.baseUrl,
    description: manifest.description,
    author: manifest.author,
    code: `${id}/index.js`,
    icon: `${id}/icon.png`,
    sha256,
    size: contents.byteLength,
  };
}

export async function runBuild(options: RunBuildOptions = {}): Promise<RunBuildResult> {
  const extensionsDir = options.extensionsDir ?? DEFAULT_EXTENSIONS_DIR;
  const distDir = options.distDir ?? DEFAULT_DIST_DIR;

  const dirNames = listExtensionDirs(extensionsDir);
  if (dirNames.length === 0) {
    console.log("No extensions found under extensions/ — writing an empty catalogue.");
  }

  // Pass 1: load + validate every manifest and check for id collisions
  // before doing any (expensive, disk-writing) bundling.
  const loaded: LoadedExtension[] = dirNames.map((dirName) => ({
    dirName,
    manifest: loadManifest(join(extensionsDir, dirName)),
  }));
  assertNoDuplicateIds(loaded);

  // Pass 2: bundle each extension now that every manifest is known good.
  const entries: RepoIndexEntry[] = [];
  for (const { dirName, manifest } of loaded) {
    const entry = await bundleOne(dirName, manifest, extensionsDir, distDir);
    entries.push(entry);
    console.log(`  built ${entry.id}@${entry.version} (${(entry.size / 1024).toFixed(1)} KB)`);
  }

  const index: RepoIndex = {
    name: "Riwaq Official Extensions",
    apiVersion: API_VERSION,
    extensions: entries,
  };

  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, "index.min.json"), JSON.stringify(index));

  return { distDir, index };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  runBuild()
    .then((result) => {
      console.log(
        `Wrote ${result.index.extensions.length} extension(s) to ${result.distDir}/index.min.json`,
      );
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
}
