// Scaffolds a new extensions/<id>: a manifest stub, a placeholder icon, a
// src/index.ts with every required Source method wired to `throw new
// Error("not implemented")`, a starter src/strings.ts, and a test file
// already wired to createTestHost. Refuses a non-kebab-case id or one that
// already exists, rather than silently overwriting or "fixing" it.
//
// `pnpm typecheck`, `pnpm test`, `pnpm validate` and `pnpm build` all pass
// against the result immediately — the README tells a newcomer to run this
// as step one, and a scaffold that doesn't build or test clean would make
// that first impression a lie. scripts/new-extension.test.ts proves this
// on every run rather than relying on it having been true once.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { relative, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { API_VERSION, KEBAB_CASE_RE } from "./manifest";

// See build.ts for why this is not `fileURLToPath(new URL("..", import.meta.url))`.
const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const DEFAULT_EXTENSIONS_DIR = join(REPO_ROOT, "extensions");

// A real, minimal 128×128 PNG (flat fill) — actual decoded bytes, not a
// text file wearing a .png extension. scripts/build.ts and
// scripts/manifest.ts both require exactly this file at this size; replace
// it with a real icon before shipping (see the README's manifest reference).
const PLACEHOLDER_ICON_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAA80lEQVR42u3SMQ0AAAjAMPxr4EMAEsEGCT1mYGlk9ehvYQIARgAg" +
  "AASAABAAAkAACAABIAAEgAAQAAJAAAgAASAABIAAEAACQAAIAAEgAASAABAAAkAACAABIAAEgAAQAAJAAAgAASAABIAAEAACQAAI" +
  "AAEgAASAABAAAkAACAABIAAEgAAQAAJAAAgAASAABIAAEAACQAAIAAEgAASAABAAAkAACAABIAAEgAAAwAQAjABAAAgAASAABIAA" +
  "EAACQAAIAAEgAASAABAAAkAACAABIAAEgAAQAAJAAAgAASAABIAAEAACQAAIAAEgAASAANCNFs7nSvbSNAeiAAAAAElFTkSuQmCC";

function manifestJson(id: string): string {
  const manifest = {
    id,
    name: "TODO: Display Name",
    version: "0.1.0",
    apiVersion: API_VERSION,
    language: "en",
    baseUrl: "https://example.com",
    icon: "icon.png",
    description: { en: "TODO: one-line description shown in the sources list." },
    author: "TODO: your name",
  };
  return JSON.stringify(manifest, null, 2) + "\n";
}

const INDEX_TS = `// TODO: describe the site this extension scrapes — theme, quirks, which
// pages are static HTML vs need host.renderAndExtract. See extensions/cenele
// or extensions/kolnovel for the level of detail expected once this is real.
//
// Every method below throws "not implemented". Implement them one at a
// time against this manifest's \`baseUrl\`, replacing the matching stub
// assertion in the sibling tests/*.test.ts file as you go — it already
// imports createTestHost and is wired to fail loudly (via the "not
// implemented" assertions) until you do.
import type {
  Source,
  SourceChapter,
  SourceHost,
  SourceLine,
  SourceNovel,
  SourceSearchResult,
  SourceSection,
} from "@riwaq/extension-api";

export default function createSource(_host: SourceHost): Source {
  return {
    canHandle(_url: string): boolean {
      // Cheap and synchronous — no host.fetch here. Typically:
      //   try { return new URL(url).hostname === "example.com"; }
      //   catch { return false; }
      throw new Error("not implemented");
    },

    async getHomeSections(): Promise<SourceSection[]> {
      throw new Error("not implemented");
    },

    async search(_query: string, _page?: number): Promise<SourceSearchResult> {
      // If the site renders every match on one page, ignore _page and
      // always return hasMore: false — see the README's note on
      // extensions/kolnovel for why that is correct, not lazy.
      throw new Error("not implemented");
    },

    async getNovel(_url: string): Promise<SourceNovel> {
      throw new Error("not implemented");
    },

    async getChapterContent(_chapter: SourceChapter): Promise<SourceLine[]> {
      throw new Error("not implemented");
    },
  };
}
`;

const STRINGS_TS = `import type { Locale } from "@riwaq/extension-api";

/** Strings this extension synthesises itself, for cases the site leaves
 *  unlabelled (a volume with no title, a section with no heading, ...).
 *  Extensions ship their own copy — they cannot reach the app's message
 *  catalogue. Replace "placeholder" with real keys as you need them; both
 *  locales are required so this satisfies Record<Locale, ...> below. */
const CATALOG = {
  en: { placeholder: "Placeholder" },
  ar: { placeholder: "Placeholder" },
} satisfies Record<Locale, Record<string, string>>;

export function strings(locale: Locale) {
  const dict = CATALOG[locale] ?? CATALOG.en;
  return (key: keyof typeof CATALOG.en, params?: Record<string, string | number>) =>
    dict[key].replace(/\\{(\\w+)\\}/g, (m, k) => (params && k in params ? String(params[k]) : m));
}
`;

function testTs(id: string): string {
  return `import { describe, expect, it } from "vitest";
import createSource from "../src/index";
import { createTestHost } from "@riwaq/extension-api/testing";

// Every method on the scaffolded Source still throws "not implemented".
// As you implement one for real, delete its assertion below and replace it
// with a real test against fixture HTML saved under tests/fixtures/ — read
// fixtures with fileURLToPath(import.meta.url) + path.join, never
// \`new URL(...)\`, which resolves against the wrong base under this repo's
// vitest setup (see extensions/cenele/tests/cenele.test.ts for the working
// pattern).

describe("${id}: createSource", () => {
  it("constructs a Source from a host", () => {
    expect(() => createSource(createTestHost())).not.toThrow();
  });

  it("canHandle is not implemented yet", () => {
    const source = createSource(createTestHost());
    expect(() => source.canHandle("https://example.com/")).toThrow("not implemented");
  });

  it("getHomeSections is not implemented yet", async () => {
    const source = createSource(createTestHost());
    await expect(source.getHomeSections()).rejects.toThrow("not implemented");
  });

  it("search is not implemented yet", async () => {
    const source = createSource(createTestHost());
    await expect(source.search("query")).rejects.toThrow("not implemented");
  });

  it("getNovel is not implemented yet", async () => {
    const source = createSource(createTestHost());
    await expect(source.getNovel("https://example.com/novel/1")).rejects.toThrow(
      "not implemented",
    );
  });

  it("getChapterContent is not implemented yet", async () => {
    const source = createSource(createTestHost());
    await expect(
      source.getChapterContent({ id: 1, title: "t", url: "https://example.com/c/1", lines: [] }),
    ).rejects.toThrow("not implemented");
  });
});
`;
}

export interface ScaffoldOptions {
  /** Defaults to <repoRoot>/extensions. */
  extensionsDir?: string;
}

export interface ScaffoldResult {
  dir: string;
}

/**
 * Scaffolds extensions/<id>. Throws (naming the problem) rather than
 * writing anything when `id` isn't kebab-case or the directory already
 * exists.
 */
export function scaffoldExtension(id: string, options: ScaffoldOptions = {}): ScaffoldResult {
  const extensionsDir = options.extensionsDir ?? DEFAULT_EXTENSIONS_DIR;

  if (!KEBAB_CASE_RE.test(id)) {
    throw new Error(
      `"${id}" is not kebab-case (lowercase letters, digits, hyphens, e.g. "my-site").`,
    );
  }

  const dir = join(extensionsDir, id);
  if (existsSync(dir)) {
    throw new Error(`extensions/${id} already exists.`);
  }

  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });

  writeFileSync(join(dir, "manifest.json"), manifestJson(id));
  writeFileSync(join(dir, "icon.png"), Buffer.from(PLACEHOLDER_ICON_PNG_BASE64, "base64"));
  writeFileSync(join(dir, "src/index.ts"), INDEX_TS);
  writeFileSync(join(dir, "src/strings.ts"), STRINGS_TS);
  writeFileSync(join(dir, `tests/${id}.test.ts`), testTs(id));

  return { dir };
}

function printUsage(): void {
  console.error("Usage: pnpm new-extension <id>");
  console.error('  <id> must be kebab-case, e.g. "my-site" — it becomes extensions/<id>.');
}

function main(): void {
  const id = process.argv[2];
  if (!id) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  let result: ScaffoldResult;
  try {
    result = scaffoldExtension(id);
  } catch (err) {
    console.error(`new-extension: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    return;
  }

  const rel = relative(REPO_ROOT, result.dir);
  console.log(`Scaffolded ${rel}`);
  console.log("");
  console.log("Next steps:");
  console.log(`  1. Edit ${rel}/manifest.json — name, baseUrl, language, description, author.`);
  console.log(`  2. Replace the placeholder ${rel}/icon.png with a real 128x128 PNG.`);
  console.log(`  3. Implement each method in ${rel}/src/index.ts, one at a time.`);
  console.log(`  4. Capture fixture HTML from the live site into ${rel}/tests/fixtures/ and`);
  console.log(`     replace the matching stub assertion in ${rel}/tests/${id}.test.ts.`);
  console.log("  5. pnpm typecheck && pnpm test && pnpm validate && pnpm build");
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) main();
