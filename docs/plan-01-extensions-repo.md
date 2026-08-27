# Riwaq Extensions Repo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `Riwaq-Extensions` into a repo that builds, tests and publishes source extensions as downloadable artifacts, and document it well enough that a stranger can ship one.

**Architecture:** A pnpm workspace. `packages/extension-api` is the frozen contract every extension imports — types plus pure helpers, with all *capability* arriving through an injected `host` object. `extensions/<id>/` are the sources; esbuild bundles each to a single self-contained ESM file. CI publishes `dist/` to a `repo` branch on GitHub Pages, fronted by an `index.min.json` catalogue carrying a SHA-256 per bundle.

**Tech Stack:** TypeScript, pnpm workspaces, esbuild, Vitest, happy-dom, GitHub Actions.

**Spec:** `docs/design.md` (copied from the Riwaq-reader repo; sections *Architecture*, *The three extensions*, *Repo index & distribution*, *Testing*, *README outline*)

**Repo:** `/Users/themostafaosama/Desktop/my-work/Riwaq-Extensions` — freshly cloned, empty, remote `git@github.com:TheMostafaOsamaDev/Riwaq-Extensions.git`.

**Source material:** the three extensions currently live in the Riwaq-reader repo at
`/Users/themostafaosama/Desktop/my-work/Riwaq-reader`. Read them from the merged
default branch, never from the working tree (which holds unrelated in-flight work):

```bash
git -C /Users/themostafaosama/Desktop/my-work/Riwaq-reader show origin/main:src/sources/extensions/cenele.ts
```

Files you will read this way: `src/sources/types.ts` (317 lines), `src/sources/host.ts` (148),
`src/sources/pdf/pdfChapter.ts` (328), and `src/sources/extensions/{cenele,kolnovel,kolnovel-pro,kolnovel-theme}.ts`
(1076 / 94 / 176 / 608).

## Global Constraints

- **`apiVersion` is `1`.** Every manifest declares it; the host refuses a major mismatch.
- **Capability only through `host`.** An extension may not import `@tauri-apps/*`, touch
  `window.__TAURI__`, `fetch`, `localStorage`, or the filesystem. Network, headless
  rendering, logging, locale and PDF parsing all arrive on the injected `host`.
- **No app internals.** Extensions must not import from the Riwaq-reader app. The
  `makeTr` / `Locale` i18n coupling is cut: use `host.locale` plus a strings map local
  to the extension.
- **Search is required and Enter-only.** `Source.search(query, page?)` is mandatory.
  `searchSuggest` does not exist. Sources rendering all matches on one page ignore
  `page` and return `hasMore: false`.
- **Manifest fields:** `id`, `name`, `version` (semver), `apiVersion`, `language`
  (BCP-47), `baseUrl`, `icon`, `description` (locale map, `en` required), `author`.
- **Index paths are relative to `index.min.json`** so a fork or mirror needs no URL edits.
- **Icons are 128×128 PNG.**
- **A code change requires a version bump.** CI enforces it.
- Node 20+, pnpm 9+. Test: `pnpm test`. Typecheck: `pnpm typecheck`. Build: `pnpm build`.
- Conventional-commit prefixes. Commit at the end of every task.

---

### Task 1: Repo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `.gitignore`, `.editorconfig`, `.npmrc`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: a workspace where `pnpm typecheck` and `pnpm test` run and pass with zero
  packages. Scripts `build`, `test`, `typecheck`, `validate` exist at the root.

- [ ] **Step 1: Root manifest**

```json
{
  "name": "riwaq-extensions",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsx scripts/build.ts",
    "validate": "tsx scripts/validate.ts",
    "typecheck": "tsc --noEmit -p tsconfig.base.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "dev-repo": "tsx scripts/dev-repo.ts"
  },
  "devDependencies": {
    "@types/node": "^22.7.0",
    "esbuild": "^0.24.0",
    "happy-dom": "^15.7.4",
    "tsx": "^4.19.0",
    "typescript": "~5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Workspace + tsconfig + vitest**

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "extensions/*"
```

`tsconfig.base.json` — `strict`, `noUnusedLocals`, `noUnusedParameters`, `module`/`moduleResolution` set to `bundler`, `target` ES2022, `lib` `["ES2022","DOM"]`, `types: ["node"]`, and `paths` mapping `@riwaq/extension-api` to `packages/extension-api/src/index.ts` so the workspace typechecks before anything is published.

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Extension parsers need DOMParser; the whole suite is parser tests.
    environment: "happy-dom",
    include: ["packages/**/*.test.ts", "extensions/**/*.test.ts", "scripts/**/*.test.ts"],
  },
  resolve: {
    alias: { "@riwaq/extension-api": new URL("./packages/extension-api/src/index.ts", import.meta.url).pathname },
  },
});
```

`.gitignore`: `node_modules/`, `dist/`, `*.tsbuildinfo`, `.DS_Store`.

- [ ] **Step 3: Install and verify**

Run: `pnpm install && pnpm typecheck && pnpm test`
Expected: install succeeds; typecheck clean; vitest reports "No test files found" and exits 0 (pass `--passWithNoTests` in the script if your vitest version exits non-zero).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm workspace"
```

---

### Task 2: The `@riwaq/extension-api` contract

The single package every extension imports. Split by authority: pure helpers are
bundled from here; anything needing real capability lives on `host`.

**Files:**
- Create: `packages/extension-api/package.json`, `tsconfig.json`
- Create: `packages/extension-api/src/{index.ts,types.ts,dom.ts,testing.ts}`
- Create: `packages/extension-api/src/dom.test.ts`

**Interfaces:**
- Consumes: Task 1's workspace.
- Produces, all exported from `@riwaq/extension-api`:
  - types `Source`, `SourceHost`, `SourceMetadata`, `NovelCard`, `SourceSection`,
    `SourceSearchResult`, `SourceNovel`, `SourceNovelMeta`, `SourceVolume`,
    `SourceChapter`, `SourceLine`, `FetchOptions`, `FetchResponse`,
    `RenderExtractOptions`, `ExtractedImage`, `Locale`
  - helpers `parseHtml(html)`, `absoluteUrl(href, base)`, `textOf(root, sel)`,
    `attrOf(root, sel, attr)`, `sanitizeText(raw)`
  - `API_VERSION = 1`
  - from `@riwaq/extension-api/testing`: `createTestHost(options)`

- [ ] **Step 1: Port the types**

Copy `src/sources/types.ts` from Riwaq-reader's `origin/main` into
`packages/extension-api/src/types.ts`, then make exactly these changes:

1. Delete `import type { MsgKey } from "../i18n";`.
2. In `SourceMetadata`, delete the `descriptionKey?: MsgKey` field and change
   `description?: string` to `description?: Record<string, string>` — a locale map,
   `en` required by convention. Update its doc comment accordingly.
3. Add to `SourceHost`:
   ```ts
     /** UI language the host is currently rendering in. Extensions use this for
      *  the handful of strings they synthesise themselves (volume/chapter
      *  fallback titles, section headings a site does not label). Extensions
      *  ship their own copy — they cannot reach the app's message catalogue. */
     readonly locale: Locale;

     /** PDF chapter extraction. pdf.js is far too heavy to bundle per extension,
      *  so the host owns the single instance and exposes it here. Sources whose
      *  chapters ship as PDFs call this instead of parsing bytes themselves. */
     readonly pdf: {
       extractChapter(
         bytes: Uint8Array,
         options: {
           chapterUrl: string;
           novelTitle?: string;
           mintImageRef: (img: ExtractedImage) => string;
         },
       ): Promise<SourceLine[]>;
     };
   ```
4. Add `export type Locale = "en" | "ar";` and, lifted verbatim from
   `src/sources/pdf/pdfChapter.ts`:
   ```ts
   export interface ExtractedImage {
     bytes: Uint8Array;
     mimeType: string;
     extension: string;
   }
   ```
5. Add `export const API_VERSION = 1;`.
6. Keep `SourceUnsupportedError` and `SourceUrlError`.
7. Confirm `search` is required and `searchSuggest` absent — it already is on
   `origin/main`, but verify rather than assume.
8. **Remove `readonly meta: SourceMetadata` from the `Source` interface.** Catalogue
   metadata now has exactly one home: `manifest.json`. Leaving it on the instance too
   is what produced the app's existing split brain, where views had to resolve icons
   via `getSourceMeta(id)` because the constructed instance's own `meta` lacked
   store-facing fields. `SourceMetadata` stays exported — the host builds one from the
   manifest and pairs it with the instance — but an extension no longer declares it.
   Note this in the design doc's contract section.

- [ ] **Step 2: Port the pure helpers**

`packages/extension-api/src/dom.ts` — lift `parseHtmlDocument`, `absolutizeUrl`,
`textOf`, `attrOf` from Riwaq-reader's `src/sources/host.ts` (lines ~122-148), renaming
the first two to `parseHtml` and `absoluteUrl`. Add `sanitizeText`, lifted from
`cenele.ts`:

```ts
/** Collapse all whitespace runs to single spaces and trim. Returns "" for
 *  nullish input, so callers can treat a missing node and an empty node alike. */
export function sanitizeText(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.replace(/\s+/g, " ").trim();
}
```

Do NOT port `createHost` — that is the app's job (Plan 3).

- [ ] **Step 3: The test host**

`packages/extension-api/src/testing.ts`. This is what makes extensions testable
without the app, and what contributors use:

```ts
import type { ExtractedImage, Locale, SourceHost, SourceLine } from "./types";

export interface TestHostOptions {
  /** Map of URL (or a substring of one) to the response body to return. Lookup
   *  prefers an exact match, then the first key the URL contains. */
  responses?: Record<string, string>;
  /** Bytes for fetchBytes, keyed the same way. */
  byteResponses?: Record<string, Uint8Array>;
  locale?: Locale;
  /** Collects every request the extension made, so a test can assert on the
   *  URL, method and body an extension sent — not just what it parsed. */
  calls?: Array<{ url: string; method: string; body?: string }>;
}

/** A SourceHost backed by fixtures. Every capability either serves a canned
 *  response or throws a clear error, so a test never reaches the network. */
export function createTestHost(options: TestHostOptions = {}): SourceHost {
  const { responses = {}, byteResponses = {}, locale = "en", calls = [] } = options;

  const lookup = <T,>(table: Record<string, T>, url: string, kind: string): T => {
    if (url in table) return table[url];
    const key = Object.keys(table).find((k) => url.includes(k));
    if (key === undefined) {
      throw new Error(
        `createTestHost: no ${kind} fixture for ${url}. Known keys: ${Object.keys(table).join(", ") || "(none)"}`,
      );
    }
    return table[key];
  };

  return {
    locale,
    async fetch(url, opts) {
      calls.push({ url, method: opts?.method ?? "GET", body: opts?.body });
      return { status: 200, text: lookup(responses, url, "text"), headers: {} };
    },
    async fetchBytes(url, opts) {
      calls.push({ url, method: opts?.method ?? "GET", body: opts?.body });
      return lookup(byteResponses, url, "bytes");
    },
    async renderAndExtract() {
      throw new Error(
        "createTestHost: renderAndExtract is not available in tests. Extensions that need it cannot be unit-tested — prefer static fetch.",
      );
    },
    log() {},
    pdf: {
      async extractChapter(): Promise<SourceLine[]> {
        throw new Error(
          "createTestHost: pdf.extractChapter is not stubbed. Pass a fake host explicitly if your test needs it.",
        );
      },
    },
  };
}
```

- [ ] **Step 4: Barrel export**

`packages/extension-api/src/index.ts` re-exports everything from `./types` and
`./dom`. `testing.ts` is reached via the package's `./testing` export condition,
declared in `packages/extension-api/package.json` — keep it out of the main barrel so
test helpers never end up in a shipped bundle.

- [ ] **Step 5: Test the helpers**

`packages/extension-api/src/dom.test.ts` — cover `parseHtml` returning a queryable
Document, `absoluteUrl` resolving a relative href against a base, `textOf`/`attrOf`
returning null on no match, and `sanitizeText` collapsing whitespace and handling
null/undefined. Then cover `createTestHost`: it serves an exact-match fixture, serves
a substring match, records calls including method and body, and throws a *named*
error listing known keys when a fixture is missing.

- [ ] **Step 6: Verify and commit**

Run: `pnpm typecheck && pnpm test`
Expected: clean, all tests pass.

```bash
git add -A
git commit -m "feat(api): the extension contract — types, DOM helpers, test host"
```

---

### Task 3: Build and publish pipeline

**Files:**
- Create: `scripts/build.ts`, `scripts/validate.ts`, `scripts/dev-repo.ts`
- Create: `scripts/manifest.ts` (shared schema + loader)
- Create: `scripts/manifest.test.ts`, `scripts/build.test.ts`

**Interfaces:**
- Consumes: `@riwaq/extension-api`'s `API_VERSION`.
- Produces:
  - `scripts/manifest.ts`: `interface ExtensionManifest`,
    `validateManifest(raw, source): ExtensionManifest` (throws with the offending
    field named), `loadManifest(dir)`
  - `scripts/build.ts`: bundles every `extensions/*` into `dist/<id>/index.js`,
    copies `manifest.json` and `icon.png`, and writes `dist/index.min.json`
  - `dist/index.min.json` shape:
    ```jsonc
    { "name": "Riwaq Official Extensions", "apiVersion": 1,
      "extensions": [ { "id","name","version","apiVersion","language","baseUrl",
                        "description","author","code","icon","sha256","size" } ] }
    ```

- [ ] **Step 1: Manifest schema + validator**

Write `validateManifest` to reject, each with a message naming the field: a missing or
non-kebab-case `id`; an `id` that does not match its directory name; a non-semver
`version`; an `apiVersion` that is not the integer `1`; a missing `name`, `language`,
`baseUrl` or `author`; a `baseUrl` that is not `https:`; a `description` that is not an
object or lacks an `en` key; an `icon` that is not `icon.png`.

- [ ] **Step 2: Test the validator first**

`scripts/manifest.test.ts` — one test per rejection above asserting the thrown message
names the offending field, plus one accepting a fully valid manifest. Write these
before the implementation and watch them fail.

- [ ] **Step 3: The bundler**

`scripts/build.ts` uses esbuild's JS API per extension:
`{ entryPoints: ["extensions/<id>/src/index.ts"], bundle: true, format: "esm",
   platform: "browser", target: "es2022", minify: true, legalComments: "none",
   outfile: "dist/<id>/index.js" }`.

`@riwaq/extension-api` is **bundled in, not external** — the pure helpers must travel
with the extension since the host does not provide them. After bundling, compute
`sha256` over the emitted file with `node:crypto`, record `size`, copy `manifest.json`
and `icon.png`, and assemble `dist/index.min.json` with `code`/`icon` paths written
**relative to the index** (`<id>/index.js`, `<id>/icon.png`).

Fail the build, naming the extension, if: its manifest is invalid; `icon.png` is
missing; the bundle exceeds 512 KB (a bundle that large almost certainly means a heavy
dependency slipped in that belongs on `host`); or two extensions share an `id`.

- [ ] **Step 4: Test the build output**

`scripts/build.test.ts` — run the real build against a tiny throwaway fixture
extension created in a temp directory, then assert: `dist/index.min.json` parses; its
`extensions[]` length matches the input; each entry's `sha256` equals a freshly
computed hash of the emitted file; `code`/`icon` are relative (no leading `/`, no
`http`); the emitted `index.js` is valid ESM with a default export. Clean up the temp
directory afterwards.

- [ ] **Step 5: The local dev repo server**

`scripts/dev-repo.ts` — serve `dist/` over `node:http` on port 8787 with permissive
CORS, so a contributor adds `http://localhost:8787` as a repo in the app and iterates
live. Print the URL on start. This is the loop the README documents; it must actually
work.

- [ ] **Step 6: Verify and commit**

Run: `pnpm typecheck && pnpm test`

```bash
git add -A
git commit -m "feat(build): bundle extensions and emit a hashed repo index"
```

---

### Task 4: Port the Cenele extension

**Files:**
- Create: `extensions/cenele/{manifest.json,icon.png,README.md}`
- Create: `extensions/cenele/src/index.ts`
- Create: `extensions/cenele/src/strings.ts`
- Create: `extensions/cenele/tests/cenele.test.ts`
- Create: `extensions/cenele/tests/fixtures/{novel.html,search.html}`

**Interfaces:**
- Consumes: `@riwaq/extension-api` (types, `parseHtml`, `absoluteUrl`, `sanitizeText`),
  and `createTestHost` from `@riwaq/extension-api/testing`.
- Produces: `export default function createSource(host: SourceHost): Source`.

- [ ] **Step 1: Copy the source**

```bash
git -C /Users/themostafaosama/Desktop/my-work/Riwaq-reader show \
  origin/main:src/sources/extensions/cenele.ts > extensions/cenele/src/index.ts
```

Also copy the two fixtures and the extension's test file from
`origin/main:src/sources/extensions/__fixtures__/cenele-novel.html`,
`…/cenele-search.html` and `…/cenele.test.ts` — they were built against the live site
and are the regression anchor for a site that has already broken once.

- [ ] **Step 2: Rewrite the imports**

Replace the app-internal imports at the top of `src/index.ts`:

```ts
import {
  absoluteUrl,
  parseHtml,
  sanitizeText,
  type NovelCard,
  type Source,
  type SourceChapter,
  type SourceHost,
  type SourceLine,
  type SourceNovelMeta,
  type SourceSearchResult,
  type SourceSection,
  type SourceVolume,
} from "@riwaq/extension-api";
import { strings } from "./strings";
```

Then rename call sites: `parseHtmlDocument` → `parseHtml`, `absolutizeUrl` →
`absoluteUrl`. Delete the file's local `sanitizeText` definition in favour of the
imported one.

- [ ] **Step 3: Cut the i18n coupling**

Delete `import { makeTr, type Locale } from "../../i18n";` and the `currentUiLocale()`
helper (it read `document.documentElement.lang`, which an extension has no business
touching). Create `extensions/cenele/src/strings.ts`:

```ts
import type { Locale } from "@riwaq/extension-api";

/** The handful of strings this extension synthesises itself, for the cases the
 *  site leaves unlabelled. Extensions ship their own copy — they cannot reach
 *  the app's message catalogue. Values match what Riwaq shipped before the
 *  split, so imported books keep their existing titles. */
const CATALOG = {
  en: { volumeFallback: "Volume {n}", chapterNoTitleFallback: "{n} - No Title" },
  ar: { volumeFallback: "المجلد {n}", chapterNoTitleFallback: "{n} - بلا عنوان" },
} satisfies Record<Locale, Record<string, string>>;

export function strings(locale: Locale) {
  const dict = CATALOG[locale] ?? CATALOG.en;
  return (key: keyof typeof CATALOG.en, params?: Record<string, string | number>) =>
    dict[key].replace(/\{(\w+)\}/g, (m, k) => (params && k in params ? String(params[k]) : m));
}
```

Replace the two call sites (around the old lines 188 and 1051) with
`strings(host.locale)("volumeFallback", { n })` and
`strings(host.locale)("chapterNoTitleFallback", { n: fallbackId })`. Note both are
inside module-level functions today — thread `host.locale` in as a parameter rather
than reaching for a module global.

- [ ] **Step 4: Export the factory**

Change `export function createCeneleSource(host: SourceHost): Source` to
`export default function createSource(host: SourceHost): Source`, and delete the `meta`
object literal from the returned Source — Task 2 removed that field from the interface,
so `manifest.json` is now its only home. Everything the deleted literal held (`id`,
`name`, `baseUrl`, `language`, `version`) must appear in the manifest you write in
Step 5; check them off one by one so nothing is lost in the move.

- [ ] **Step 5: Manifest, icon and README**

`extensions/cenele/manifest.json`:
```json
{
  "id": "cenele",
  "name": "فضاء الروايات",
  "version": "1.0.0",
  "apiVersion": 1,
  "language": "ar",
  "baseUrl": "https://cenele.com",
  "icon": "icon.png",
  "description": {
    "en": "Arabic translations of Chinese and Korean web novels.",
    "ar": "موقع فضاء الروايات يوفر روايات صينية وكورية مترجمة إلى العربية."
  },
  "author": "Riwaq"
}
```

Copy the icon from `origin/main:src/assets/source-icons/cenele.png`; confirm it is
128×128 and re-render it if not.

`README.md` — port the selector/quirk notes from Riwaq-reader's
`docs/store-feature/cenele.md` (already corrected in Phase 1): the `nhvNovelV2` config
with `postId` + `chaptersNonce`, the two AJAX actions, the `.nhv-novel-*` metadata
selectors, the search URL forms, and the anti-piracy decoy filter.

- [ ] **Step 6: Rewire the tests onto the test host**

Update the ported test file to import from `@riwaq/extension-api` and, in addition to
the existing pure-parser tests, add at least one test that drives the extension
end-to-end through `createTestHost` — e.g. `createSource(host).search("سيد")` returns
the expected cards, and the recorded `calls` show the correct URL was requested. That
is the test that proves the port actually works as an extension, not just that its
parsers survived the move.

- [ ] **Step 7: Verify and commit**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: clean; `dist/cenele/index.js` exists and `dist/index.min.json` lists cenele.

```bash
git add -A
git commit -m "feat(cenele): port the extension onto the public API"
```

---

### Task 5: Port and merge the KolNovel extensions

`kolnovel` and `kolnovel-pro` now target the same site (`free.kolnovel.com`
301-redirects to `kolnovel.com`). They become one extension.

**Files:**
- Create: `extensions/kolnovel/{manifest.json,icon.png,README.md}`
- Create: `extensions/kolnovel/src/{index.ts,theme.ts,strings.ts}`
- Create: `extensions/kolnovel/tests/kolnovel.test.ts`, plus fixtures

**Interfaces:**
- Consumes: `@riwaq/extension-api`, `@riwaq/extension-api/testing`.
- Produces: `export default function createSource(host: SourceHost): Source` handling
  `kolnovel.com`, `www.kolnovel.com`, `free.kolnovel.com` and `kolnovel.online`.

- [ ] **Step 1: Copy the sources**

`kolnovel-theme.ts` → `extensions/kolnovel/src/theme.ts` (it stays a private module of
this extension). `kolnovel-pro.ts` → `extensions/kolnovel/src/index.ts` — **Pro is the
base**, because its chapter path is a superset: inline `.epcontent` HTML with the
`ts_ln_dl_url` PDF-token fallback. Read `kolnovel.ts` too, but only to confirm it adds
nothing Pro lacks.

- [ ] **Step 2: Merge `canHandle`**

```ts
    canHandle(url) {
      try {
        const h = new URL(url).hostname.toLowerCase();
        // free.kolnovel.com 301s to kolnovel.com and kolnovel.online is a
        // mirror; both are accepted so URLs already saved in a user's library
        // keep resolving after the merge.
        return (
          h === "kolnovel.com" ||
          h === "www.kolnovel.com" ||
          h === "free.kolnovel.com" ||
          h === "kolnovel.online"
        );
      } catch {
        return false;
      }
    },
```

This satisfies the design doc's carried requirement that exactly one extension owns
every KolNovel host.

- [ ] **Step 3: Route the PDF path through the host**

Delete `import { extractPdfLines, type ExtractedImage } from "../pdf/pdfChapter";`.
`ExtractedImage` now comes from `@riwaq/extension-api`; the call becomes
`host.pdf.extractChapter(bytes, { chapterUrl, novelTitle, mintImageRef })`. Keep
`resolveImage` and the `imageStore` map exactly as they are — the host reads images
back through that method.

- [ ] **Step 4: Same import rewrite and i18n cut as Task 4**

Apply Task 4 Steps 2-4 to both `index.ts` and `theme.ts`. `theme.ts` needs two more
strings — copy the values from Riwaq-reader's catalogues:
`trendingFallback` (EN "Trending" / AR "الرائج") and
`hotUpdatesFallback` (EN "Hot updates" / AR "تحديثات رائجة"), alongside
`volumeFallback` and `chapterNoTitleFallback`.

- [ ] **Step 5: Manifest, icon, README**

`id` is `kolnovel`, `name` `"ملوك الروايات"`, `baseUrl` `https://kolnovel.com`,
`version` `1.0.0`. Icon from `origin/main:src/assets/source-icons/kolnovel.png`.
README ports `docs/store-feature/kolnovel.md`, and must record: search is unpaginated
and **always returns `hasMore: false`** because every pagination URL returns HTTP 500;
the site 500s on broad queries; and the PDF-token chapter fallback.

- [ ] **Step 6: Tests**

Port `kolnovel-theme.test.ts` and add the end-to-end `createTestHost` test as in Task
4 Step 6. Add one test asserting `canHandle` returns true for all four hosts and false
for an unrelated domain — that is the regression guard for the merge.

- [ ] **Step 7: Verify and commit**

Run: `pnpm typecheck && pnpm test && pnpm build`

```bash
git add -A
git commit -m "feat(kolnovel): port and merge the free and pro extensions"
```

---

### Task 6: CI

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/publish.yml`
- Create: `scripts/check-version-bump.ts`, `scripts/check-version-bump.test.ts`

**Interfaces:**
- Consumes: `pnpm build`, `pnpm test`, `pnpm typecheck`, `loadManifest`.
- Produces: a `repo` branch containing `dist/`, served by GitHub Pages.

- [ ] **Step 1: Version-bump check**

`scripts/check-version-bump.ts` — for each extension whose files changed between the
merge base and HEAD, compare its manifest `version` against the copy on the `repo`
branch's `index.min.json`. Exit non-zero, naming the extension, when the code changed
and the version did not. Skip cleanly when the `repo` branch does not exist yet (first
publish). Unit-test the comparison logic with fabricated inputs — do not require a
live git repo in the test.

- [ ] **Step 2: PR workflow**

`.github/workflows/ci.yml` on `pull_request`: checkout with `fetch-depth: 0`, pnpm +
Node 20 with a pnpm store cache, `pnpm install --frozen-lockfile`, then `pnpm
typecheck`, `pnpm test`, `pnpm build`, `pnpm exec tsx scripts/check-version-bump.ts`.
Upload `dist/` as an artifact so a reviewer can inspect a bundle.

- [ ] **Step 3: Publish workflow**

`.github/workflows/publish.yml` on push to the default branch: the same build, then
publish `dist/` to the `repo` branch. Use a plain git checkout of an orphan `repo`
branch rather than a third-party action, so the whole publish step is auditable:
copy `dist/` into a clean worktree of `repo`, commit, force-push. Include a
`.nojekyll` file so GitHub Pages serves paths beginning with an underscore.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "ci: validate on PRs, publish the repo index on main"
```

Note: enabling GitHub Pages for the `repo` branch is a one-time setting in the repo's
web UI — record it in the README rather than trying to automate it.

---

### Task 7: README and contributor guide

The deliverable the user asked for. It must be good enough that a stranger ships an
extension from it.

**Files:**
- Create: `README.md`, `CONTRIBUTING.md`, `.github/pull_request_template.md`
- Create: `scripts/new-extension.ts` (scaffold command)

**Interfaces:**
- Consumes: everything above.
- Produces: `pnpm new-extension <id>` scaffolding a working extension skeleton.

- [ ] **Step 1: The scaffold command**

`scripts/new-extension.ts` — prompt-free, takes an id argument, creates
`extensions/<id>/` with a manifest stub, a placeholder icon, a `src/index.ts`
implementing every required method with `throw new Error("not implemented")`, a
`src/strings.ts`, and a test file already wired to `createTestHost`. Refuse a
non-kebab-case id or an id that already exists. Add `"new-extension": "tsx
scripts/new-extension.ts"` to the root scripts.

- [ ] **Step 2: Write the README**

Sections, in order:
1. **What this is** — a repo of source extensions for the Riwaq reader, and how the app
   consumes it (add the repo URL in Store → Repos).
2. **Using it** — the official repo URL, and that anyone may host their own.
3. **How an extension works** — the two-layer picture (extension code ↔ `host`), and
   the rule that all capability arrives through `host`.
4. **Quick start** — `pnpm install`, `pnpm new-extension my-site`, implement, `pnpm
   test`, `pnpm build`, `pnpm dev-repo`, add `http://localhost:8787` in the app.
5. **The `Source` interface** — every method, what it receives, what it must return,
   and which are optional (`getVolumeChapters`, `searchChapters`, `resolveImage`).
   State plainly that `search` is required and there is no suggestion API.
6. **Manifest reference** — a table of every field with type, required-ness and an example.
7. **The `host` API** — `fetch`, `fetchBytes`, `renderAndExtract` (desktop only),
   `log`, `locale`, `pdf.extractChapter`.
8. **Testing** — fixture-driven parser tests plus `createTestHost`, and why fixtures
   are captured from the live site.
9. **Rules** — capability only via `host`; no app imports; search is Enter-only; bump
   the version on every code change; 128×128 PNG icon; keep bundles small.
10. **Publishing** — CI builds and pushes to the `repo` branch; the one-time Pages setting.
11. **A worked example** — a short, complete extension for a simple static site,
    showing manifest, factory, one parser and one test.

- [ ] **Step 3: CONTRIBUTING and PR template**

`CONTRIBUTING.md` stays short and points at the README for the technical guide: how to
open a PR, what CI checks, the review policy (bundles are built by CI from reviewed
source and never uploaded pre-built), and how to report a broken extension.
The PR template checklist: version bumped, tests added, fixtures captured from the
live site, `pnpm build` passes, README updated if behaviour changed.

- [ ] **Step 4: Verify the guide is true**

Follow your own quick start end to end: run `pnpm new-extension test-site`, confirm it
scaffolds and that `pnpm test` and `pnpm build` both still pass with it present, then
delete it. A quick start that does not work is worse than none.

- [ ] **Step 5: Commit and push**

```bash
git add -A
git commit -m "docs: README, contributor guide and extension scaffold"
git push -u origin main
```

---

## Done when

- `pnpm install && pnpm typecheck && pnpm test && pnpm build` all pass from a clean clone.
- `dist/index.min.json` lists exactly two extensions (`cenele`, `kolnovel`), each with a
  correct SHA-256 and relative `code`/`icon` paths.
- No extension imports anything outside `@riwaq/extension-api`.
- `pnpm dev-repo` serves a catalogue the app can actually add.
- A stranger can follow the README and ship an extension.

## Follow-on

**Plan 3** — the app side: `src/extensions/` runtime (repos, install, loader, catalog),
the registry rewrite with the id-alias table (`kolnovel-pro` → `kolnovel`), first-run
reconciliation, and the Extensions UI. Start it with the blob-URL `import()` spike on
macOS and Android — the one mechanism in the design that is still unproven.
