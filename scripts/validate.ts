// A fast, bundle-free lint pass over every extensions/<id>: validates its
// manifest.json and confirms icon.png is present, without running esbuild
// at all. `pnpm build` already performs the exact same checks as a
// prerequisite to bundling (and is the one CI actually gates on — see
// .github/workflows/ci.yml from Task 6), so this script's job is purely
// to give a contributor a quick, no-bundling "does my manifest look
// right?" signal while iterating, matching the root `pnpm validate`
// script wired up in Task 1.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadManifest } from "./manifest";
import type { ExtensionManifest } from "./manifest";

// See build.ts for why this is not `fileURLToPath(new URL("..", import.meta.url))`.
const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const EXTENSIONS_DIR = join(REPO_ROOT, "extensions");

function listExtensionDirs(extensionsDir: string): string[] {
  if (!existsSync(extensionsDir)) return [];
  return readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Validates every extension under `extensionsDir`, printing one line per
 *  extension. Returns true when every extension is valid (including the
 *  vacuous case of zero extensions present). */
export function runValidate(extensionsDir: string = EXTENSIONS_DIR): boolean {
  const dirNames = listExtensionDirs(extensionsDir);
  if (dirNames.length === 0) {
    console.log("No extensions found under extensions/ — nothing to validate.");
    return true;
  }

  const seenIds = new Map<string, string>();
  let failures = 0;

  for (const dirName of dirNames) {
    try {
      const manifest: ExtensionManifest = loadManifest(join(extensionsDir, dirName));

      if (!existsSync(join(extensionsDir, dirName, "icon.png"))) {
        throw new Error(`extensions/${dirName}: missing icon.png`);
      }

      const owner = seenIds.get(manifest.id);
      if (owner !== undefined) {
        throw new Error(
          `extensions/${dirName}: id "${manifest.id}" is already used by extensions/${owner}`,
        );
      }
      seenIds.set(manifest.id, dirName);

      console.log(`  ok    ${dirName}`);
    } catch (err) {
      failures += 1;
      console.error(`  FAIL  ${dirName}: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} of ${dirNames.length} extension(s) failed validation.`);
    return false;
  }
  console.log(`\nAll ${dirNames.length} extension(s) valid.`);
  return true;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  process.exitCode = runValidate() ? 0 : 1;
}
