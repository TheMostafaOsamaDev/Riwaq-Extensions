// A fast, bundle-free lint pass over every extensions/<id>: validates its
// manifest.json and confirms icon.png is a 128×128 PNG, without running
// esbuild at all. `pnpm build` performs the same manifest and icon-presence
// checks as a prerequisite to bundling, so this script's first job is to
// give a contributor a quick, no-bundling "does my manifest look right?"
// signal while iterating, matching the root `pnpm validate` script wired up
// in Task 1. The icon's pixel size is checked only here; CI runs this
// before it builds (see .github/workflows/ci.yml).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadManifest } from "./manifest";
import type { ExtensionManifest } from "./manifest";

// See build.ts for why this is not `fileURLToPath(new URL("..", import.meta.url))`.
const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const EXTENSIONS_DIR = join(REPO_ROOT, "extensions");

/** Every extension ships a square icon of this many pixels. */
const ICON_SIZE = 128;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height of a PNG, read from its IHDR chunk — which the format
 *  requires to come first, right after the 8-byte signature. Throws when
 *  the file is not a PNG. */
export function pngSize(bytes: Buffer): { width: number; height: number } {
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    bytes.toString("latin1", 12, 16) !== "IHDR"
  ) {
    throw new Error("not a PNG");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

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

      const iconPath = join(extensionsDir, dirName, "icon.png");
      if (!existsSync(iconPath)) {
        throw new Error(`extensions/${dirName}: missing icon.png`);
      }
      let icon: { width: number; height: number };
      try {
        icon = pngSize(readFileSync(iconPath));
      } catch {
        throw new Error(`extensions/${dirName}: icon.png is not a PNG`);
      }
      if (icon.width !== ICON_SIZE || icon.height !== ICON_SIZE) {
        throw new Error(
          `extensions/${dirName}: icon.png is ${icon.width}×${icon.height}, expected ${ICON_SIZE}×${ICON_SIZE}`,
        );
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
