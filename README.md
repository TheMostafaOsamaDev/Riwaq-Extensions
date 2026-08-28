# Riwaq Extensions

Source extensions for [Riwaq](https://github.com/TheMostafaOsamaDev/Riwaq-ebook-reader), a
novel-reading app. This repo builds, validates and publishes those extensions; it is not
part of the app itself.

## Contents

1. [What this is](#what-this-is)
2. [Using it](#using-it)
3. [How an extension works](#how-an-extension-works)
4. [Quick start](#quick-start)
5. [The `Source` interface](#the-source-interface)
6. [Manifest reference](#manifest-reference)
7. [The `host` API](#the-host-api)
8. [Testing](#testing)
9. [Rules](#rules)
10. [Publishing](#publishing)
11. [A worked example](#a-worked-example)

## What this is

A **source extension** is code that knows how to browse and scrape one novel website (or
a small family of them under one theme) — its homepage, its search, a novel's chapter
list, a chapter's text. Riwaq doesn't ship any of this built in. Instead it downloads
extensions at runtime from a **repo**: a plain static folder containing an
`index.min.json` catalogue plus one subfolder per extension (its bundled code, its
manifest, its icon).

The app adds a repo by URL (**Store → Repos**), fetches its catalogue, and lets the user
install, update or remove individual extensions from it. Once installed, the app loads an
extension's bundle and calls into it through the `Source` interface described below —
the extension never talks to the network, a rendering engine, or the filesystem
directly; every capability it has arrives through an injected `host` object.

This repo is that publishing pipeline for one particular catalogue: two extensions today
(`extensions/cenele`, `extensions/kolnovel`), the `@riwaq/extension-api` contract package
they're built against, and the scripts and CI that validate, bundle and publish them.

## Using it

The official catalogue is published at:

```
https://themostafaosamadev.github.io/Riwaq-Extensions/
```

Add it in the app under **Store → Repos → Add Repo**. It carries no special privilege
beyond being there by default — it's an ordinary repo entry like any other, and you can
remove it.

**Anyone can host their own repo.** The layout is just `index.min.json` plus the
subfolders it references, served as static files — `pnpm build` produces exactly that in
`dist/`. Fork this repo, change what's in `extensions/`, point CI (or a manual `pnpm
build` + upload) at your own static host, and give people your URL instead. See
[Publishing](#publishing) for how the official catalogue does it.

## How an extension works

An extension is two layers:

- **Extension code** — the TypeScript in `extensions/<id>/src/`. It implements the
  `Source` interface: parse this HTML, decide what a chapter's paragraphs are, build a
  search-results grid. It's ordinary, side-effect-free-ish parsing code.
- **`host`** — an object the app injects into your extension's factory function at
  construction time. It is the *only* way extension code can reach the network, a
  headless renderer, or PDF parsing. Your code never calls `fetch` directly, never
  touches `window`, and never imports anything from the app or from Tauri.

```
extensions/<id>/
├── manifest.json      # catalogue metadata — see Manifest reference
├── icon.png            # 128×128 PNG
├── src/
│   ├── index.ts        # export default (host: SourceHost) => Source
│   └── strings.ts       # this extension's own small locale catalogue
├── tests/
│   ├── <id>.test.ts
│   └── fixtures/        # HTML saved from the live site — see Testing
└── README.md            # site quirks, selectors, gotchas (recommended — see cenele/kolnovel)
```

The one rule everything else follows from: **capability only via `host`.** A handful of
pure, capability-free helpers (`parseHtml`, `absoluteUrl`, `textOf`, `attrOf`,
`sanitizeText`) travel with your bundle from `@riwaq/extension-api` instead, because
parsing text you've already fetched needs no authority. Everything else — `host.fetch`,
`host.fetchBytes`, `host.renderAndExtract`, `host.pdf.extractChapter` — is capability the
app grants at runtime, not something your code can reach on its own.

## Quick start

```bash
pnpm install
pnpm new-extension my-site
```

This scaffolds `extensions/my-site/`: a manifest stub, a placeholder icon, a
`src/index.ts` with every required `Source` method already wired up and throwing `not
implemented`, a starter `src/strings.ts`, and a test file already using
`createTestHost`. Run `pnpm typecheck && pnpm test` right now and both pass — the
scaffold compiles, and its stub test file exercises every "not implemented" method.

`pnpm validate` and `pnpm build` deliberately do **not** pass yet: the manifest's
`name`, `author` and `description` still carry literal `"TODO: ..."` placeholders, and
`scripts/manifest.ts` refuses any manifest field that still contains one. Without that
check, an accidentally-merged scaffold would validate, build and publish cleanly as an
installable extension literally named `"TODO: Display Name"`. Replace those fields with
real values (step 1 below) and `pnpm validate && pnpm build` pass too, with `my-site`
sitting alongside `cenele` and `kolnovel` in the output.

From there:

1. Edit `extensions/my-site/manifest.json` — real `name`, `baseUrl`, `language`,
   `description`, `author` (see [Manifest reference](#manifest-reference)).
2. Replace `extensions/my-site/icon.png` with a real 128×128 PNG.
3. Implement `canHandle` first, then `getHomeSections`, `search`, `getNovel`,
   `getChapterContent` — one at a time. Save real HTML from the live site into
   `tests/fixtures/` as you go and replace each stub assertion in
   `tests/my-site.test.ts` with a real test against it (see [Testing](#testing)).
4. `pnpm test` — fixture tests only, no network.
5. `pnpm build` — bundles your extension and writes `dist/index.min.json`.
6. `pnpm dev-repo` — serves `dist/` at `http://localhost:8787`. Add that URL as a repo
   in the app and install your extension from it to try it against the real site.

Before opening a PR, also run `pnpm typecheck` and `pnpm validate` — see
[Rules](#rules) and the PR template for the full checklist.

## The `Source` interface

Your `src/index.ts` default-exports a factory: `(host: SourceHost) => Source`. The
object it returns is evaluated fresh per session; don't assume it survives across app
restarts (cache what you need in closure state, not on disk).

```ts
interface Source {
  canHandle(url: string): boolean;
  getHomeSections(): Promise<SourceSection[]>;
  search(query: string, page?: number): Promise<SourceSearchResult>;
  getNovel(url: string): Promise<SourceNovel>;
  getChapterContent(chapter: SourceChapter): Promise<SourceLine[]>;

  // optional:
  readonly hasLazyVolumes?: boolean;
  getVolumeChapters?(novelUrl: string, volume: SourceVolume): Promise<SourceChapter[]>;
  searchChapters?(novelUrl: string, query: string): Promise<SourceChapter[]>;
  resolveImage?(ref: string): Promise<{ bytes: Uint8Array; mimeType: string; extension: string } | null>;
}
```

A `Source` carries no name, icon, version or description of its own — there is no `meta`
field on it. That catalogue-level data lives only in `manifest.json`; the host reads it
separately and pairs it with the `Source` instance your factory builds. Don't try to
return that information from `createSource` — the interface has nowhere to put it.

| Method | Required | Receives | Returns | Notes |
|---|---|---|---|---|
| `canHandle` | yes | a URL | `boolean` | Cheap, synchronous. Does this look like one of your site's pages? |
| `getHomeSections` | yes | — | `SourceSection[]` | One entry per homepage row, in order. |
| `search` | **yes** | `query`, 1-based `page?` | `SourceSearchResult` | See below — this is the one search interaction. |
| `getNovel` | yes | the novel's index/series URL | `SourceNovel` | Full metadata + chapter listing, without chapter bodies. |
| `getChapterContent` | yes | a `SourceChapter` | `SourceLine[]` | Populates one chapter's body. |
| `hasLazyVolumes` | no | — | `boolean` | Set `true` when `getNovel` returns volumes with empty `chapters[]` and chapters are loaded per-volume on demand. |
| `getVolumeChapters` | only if `hasLazyVolumes` | novel URL, a `SourceVolume` | `SourceChapter[]` | Populates one volume the UI expanded. |
| `searchChapters` | no | novel URL, query | `SourceChapter[]` | In-novel chapter search, if the site has one. |
| `resolveImage` | no | an opaque ref | bytes/mimeType/extension or `null` | Only for image `SourceLine`s whose `content` isn't a directly-fetchable URL (e.g. an image pulled out of a PDF). |

**`search` is required, and there is no suggestion API.** The app has exactly one search
interaction: the user types and presses Enter, and `search(query, page)` fills the
results grid. There is no as-you-type suggest endpoint anywhere in this interface — don't
wire one up even if the site has one. If your site renders every match on a single page
(no real pagination), ignore the `page` argument entirely and always return `hasMore:
false` — `extensions/kolnovel` does exactly this, and its `README.md` explains why: two
different pagination URL forms both return HTTP 500 on the live site, so honoring a
"next page" click would just be a broken link. Don't guess at this — check what your
site's own pagination actually does before deciding.

### Data shapes

The shapes these methods pass around, trimmed to their fields (see
`packages/extension-api/src/types.ts` for the full doc comments):

| Shape | Fields |
|---|---|
| `NovelCard` | `url`, `title`, `coverUrl?`, `subtitle?`, `badges?: string[]` |
| `SourceSection` | `id`, `title`, `cards: NovelCard[]`, `viewMoreUrl?` |
| `SourceSearchResult` | `cards: NovelCard[]`, `hasMore: boolean`, `query`, `page` |
| `SourceNovel` | `title`, `author`, `originalTitle?`, `language`, `direction: "ltr" \| "rtl"`, `coverUrl?`, `description?`, `tags: string[]`, `status?`, `meta: SourceNovelMeta[]`, `volumes: SourceVolume[]` |
| `SourceNovelMeta` | `label`, `value`, `url?` — free-form key/value rows (translator, year, type, …) |
| `SourceVolume` | `id`, `title`, `chapters: SourceChapter[]`, `chapterCount?`, `key?` (opaque token for `getVolumeChapters`) |
| `SourceChapter` | `id`, `title`, `url`, `lines: SourceLine[]` (empty until `getChapterContent` runs) |
| `SourceLine` | `type: "text" \| "image"`, `content: string` |

## Manifest reference

Every extension ships an `extensions/<id>/manifest.json`. `scripts/manifest.ts` is the
single source of truth for what's accepted — this table mirrors every rule it enforces,
plus one call-out below the table for a convention it does *not* enforce.

| Field | Type | Required | Rule | Example |
|---|---|---|---|---|
| `id` | string | yes | kebab-case (lowercase letters, digits, hyphens) and **must equal the directory name** under `extensions/` | `"cenele"` |
| `name` | string | yes | non-empty | `"فضاء الروايات"` |
| `version` | string | yes | valid [semver](https://semver.org) | `"1.0.0"` |
| `apiVersion` | number | yes | must be exactly `1` (the current `API_VERSION`) | `1` |
| `language` | string | yes | non-empty BCP-47-ish tag | `"ar"` |
| `baseUrl` | string | yes | must be an `https:` URL | `"https://cenele.com"` |
| `icon` | string | yes | must be **literally** `"icon.png"` — a PNG file next to `manifest.json` | `"icon.png"` |
| `description` | object | yes | a locale map; **must include an `en` key** — a description without `en` is rejected outright | `{ "en": "…", "ar": "…" }` |
| `author` | string | yes | non-empty | `"Riwaq"` |

**128×128 is a convention, not something `validateManifest` checks.** The rule above is
real: `icon` must literally be the string `"icon.png"`. The *pixel dimensions* of that
file are never read — a 512×512 (or any other size) `icon.png` passes `pnpm validate` and
`pnpm build` without complaint. 128×128 is what every extension in this repo actually
ships, what `pnpm new-extension` generates, and what its own test asserts by decoding the
`IHDR` chunk — so treat it as the size to use, just don't expect the tooling to catch it
if you don't.

A real one, `extensions/cenele/manifest.json`:

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

`pnpm validate` runs every rule above against every extension without bundling anything —
run it first when a manifest is misbehaving; it fails fast with the exact field and
reason. `pnpm build` runs the same validation before it bundles.

## The `host` API

```ts
interface SourceHost {
  fetch(url: string, options?: FetchOptions): Promise<FetchResponse>;
  fetchBytes(url: string, options?: FetchOptions): Promise<Uint8Array>;
  renderAndExtract<T = unknown>(url: string, options: RenderExtractOptions): Promise<T>;
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
  readonly locale: "en" | "ar";
  readonly pdf: {
    extractChapter(bytes: Uint8Array, options: {
      chapterUrl: string;
      novelTitle?: string;
      mintImageRef: (img: ExtractedImage) => string;
    }): Promise<SourceLine[]>;
  };
}
```

- **`fetch(url, options?)`** — a GET/POST/PUT/DELETE/HEAD request. `options.headers` and
  `options.body` work as you'd expect. Returns `{ status, text, headers }` — the body is
  already UTF-8 decoded text. Use this for ordinary HTML/JSON pages and AJAX endpoints.
- **`fetchBytes(url, options?)`** — the same, but returns raw `Uint8Array` bytes instead
  of decoded text. Use this for images and PDFs.
- **`renderAndExtract(url, options)`** — loads `url` in a real, JS-executing rendering
  engine, waits for `options.waitForSelector` or `options.waitForPredicate`, then runs
  `options.script` in that page and returns whatever JSON-serializable value it produces.
  For pages whose content only appears after client-side JS runs. **Desktop only** —
  don't make an extension depend on it if it needs to work on every platform the app
  ships on; prefer `fetch` wherever the data is in the initial HTML.
- **`log(level, message)`** — structured logging into the app's own log, not `console`.
- **`locale`** — `"en"` or `"ar"`, the UI's current language. Extensions cannot reach the
  app's message catalogue, so use this to pick from your own `strings.ts` catalogue for
  the handful of strings you synthesize yourself (a volume with no title, a section with
  no heading). See `extensions/kolnovel/src/strings.ts` for the pattern.
- **`pdf.extractChapter(bytes, options)`** — parses a downloaded PDF's pages into
  `SourceLine[]`. `options.mintImageRef` is called once per image the PDF contains; it
  returns an opaque ref string you attach to an image `SourceLine`, and your extension's
  optional `resolveImage(ref)` hands the bytes back out later. `pdf.js` is far too heavy
  to bundle per-extension, so the host owns the one shared instance — never parse PDF
  bytes yourself. See `extensions/kolnovel/src/index.ts` for a full PDF-fallback flow.

## Testing

Every extension gets fixture-driven parser tests: save real HTML from the live site into
`tests/fixtures/`, then assert the shape your parser produces from it. No test reaches
the network — `@riwaq/extension-api/testing` exports `createTestHost`, a `SourceHost`
backed entirely by fixtures you provide:

```ts
const host = createTestHost({
  responses: { "https://example.com/novel/1": novelHtml }, // exact URL or substring match
  byteResponses: { "https://example.com/cover.jpg": coverBytes },
  locale: "en",
});
```

Fixtures are **derived from** real markup captured from the live site, not invented from
whole cloth: every element and attribute a fixture contains should be copied verbatim
from a page the site actually served, then trimmed down to just what your parser reads.
The verbatim part is what matters, not the trimming — a hand-invented fixture only ever
proves your parser agrees with its own author's assumptions about the site's markup,
which is exactly the failure mode a fixture test exists to catch; copying real markup and
cutting it down still lets a redesign of the parts your parser *does* read show up as a
failing test, before a user hits it live.

Trimming does give something up: a full, untrimmed capture would also catch a change to
markup your parser doesn't currently read (e.g. a wrapper element it ignores today that
later gains significance), which a trimmed fixture by definition cannot. The fixtures
under `extensions/*/tests/fixtures/` in this repo are exactly this trade-off already
made — a few-hundred-byte to few-KB skeleton, not the hundreds of KB a real Madara/
WordPress page actually weighs, but every tag, class and attribute in them was copied
from a real capture and only re-indented for readability, not invented.

**Read fixture files with `fileURLToPath(import.meta.url)` + `path.join`, never
`new URL(...)`.** This suite runs under `environment: "happy-dom"` (see
`vitest.config.ts`), and happy-dom's patched global `URL` silently resolves a relative
`new URL(href, base)` against its fake `window.location` instead of the `file:` base you
gave it — you'd get a bogus `http://localhost:3000/...` path instead of your fixture.
`fileURLToPath` on the test file's own `import.meta.url` sidesteps that entirely. Every
existing extension follows this; copy it rather than re-deriving it:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");
const novelHtml = readFileSync(join(FIXTURES_DIR, "novel.html"), "utf8");
```

`pnpm test` runs every extension's suite plus the contract package's and the scripts'
own tests. `pnpm test:watch` re-runs on save.

## Rules

- **Capability only via `host`.** No `fetch`/`XMLHttpRequest`, no `window`, no Node or
  Tauri APIs in your extension code — anything that needs the network, a renderer, the
  filesystem, or PDF parsing goes through `host`.
- **No app imports.** Only import your own code and `@riwaq/extension-api` — nothing from
  the app, Tauri, or Node. Nothing mechanically stops you from adding another npm
  dependency, but review and the 512 KB bundle ceiling below both exist to catch it: at
  runtime there is only `host` and whatever you bundled yourself, nothing the app
  provides ambiently.
- **Search is Enter-only.** Implement `search(query, page)`; there is no suggest/
  autocomplete method anywhere in the interface, and adding one yourself does nothing —
  the app never calls it.
- **Bump the version on every code change.** `scripts/check-version-bump.ts` runs in CI
  on every PR and fails it if an already-published extension's files changed but its
  manifest `version` didn't move — a stale version means a host that treats `(id,
  version)` as an immutable pair would never see your new code.
- **Icon is a 128×128 PNG named exactly `icon.png`.** Only the filename is validated (see [Manifest reference](#manifest-reference)) — 128×128 is convention, matching what `pnpm new-extension` generates.
- **Keep bundles small.** `scripts/build.ts` refuses to bundle anything over 512 KB
  minified. Going over almost always means a heavy dependency slipped in that belongs on
  `host` instead — `pdf.js` is the canonical example: PDF parsing is `host.pdf`, never
  something an extension bundles for itself.

## Publishing

`.github/workflows/ci.yml` runs on every PR: `pnpm validate`, `pnpm typecheck`, `pnpm
test`, `pnpm build`, then the version-bump check above. Nothing is published from a PR.

`.github/workflows/publish.yml` runs on every push to `main`: the same build, then a
plain `git` sequence (no third-party action) that creates a fresh **orphan** commit from
`dist/`'s contents and force-pushes it to the `repo` branch. GitHub Pages serves that
branch's root — that is the exact code and catalogue the app downloads and executes.
Every publish replaces the branch's history outright; it isn't an append.

> **One-time setup a maintainer has to do by hand.** After `publish.yml` runs for the
> first time and the `repo` branch exists, go to **Settings → Pages** and set **Source**
> to **"Deploy from a branch"**, branch **`repo`**, folder **`/`** (root). Nothing in CI
> can do this for you — it's a one-time repository setting, not a workflow step — and
> until it's done, the branch has commits but GitHub Pages isn't serving them, so the
> official repo URL 404s and no app can add it.

**Protect the `repo` branch.** Because every publish force-pushes a brand-new orphan
commit, this branch never accumulates history — there is nothing to diff a bad push
against, so a tampered commit wouldn't show up as a rewrite the way it would on a normal
branch. The app downloads and *executes* whatever sits there. Turning on branch
protection (or a ruleset) for `repo` is the cheap mitigation for that, and is worth doing
before this repo is relied on by real users — **but the ruleset must explicitly permit
force pushes from the `github-actions[bot]` identity (or from Actions generally) while
denying everyone/everything else.** `publish.yml` force-pushes `repo` on every single run
(see the step above) — a ruleset that blocks force pushes outright fails every publish,
and the likely next move is a maintainer disabling protection entirely to unblock
publishing, which is strictly worse than never having turned it on. The goal is "only CI
can push here, and only by force," not "nothing can force-push here."

**Review policy.** Bundles are built by CI from reviewed source and are never uploaded
pre-built — a PR is a diff of source code, and what gets published is always CI's own
build of exactly that source, not something a contributor produced locally and handed
over.

**`baseUrl` is a label, not a sandbox.** It's validated as an `https:` URL and published
in the manifest, but nothing in `@riwaq/extension-api` or the host contract scopes
`host.fetch`, `host.fetchBytes` or `host.renderAndExtract` to it — an extension whose
manifest declares `baseUrl: "https://cenele.com"` is not prevented from calling
`host.fetch("https://evil.example")`. Human review of the source diff — what a PR
actually calls those methods with — is the real control here, not the manifest field.

## A worked example

A small, complete extension for a fictional static site at `https://example-novels.test`
— one page fetched, one parser, one test. (This is illustrative; it isn't shipped in
`extensions/`. Run it through `pnpm new-extension` if you want a real starting point.)

**`manifest.json`**

```json
{
  "id": "example-novels",
  "name": "Example Novels",
  "version": "1.0.0",
  "apiVersion": 1,
  "language": "en",
  "baseUrl": "https://example-novels.test",
  "icon": "icon.png",
  "description": { "en": "A worked example — not a real extension." },
  "author": "Riwaq"
}
```

**`src/index.ts`** — the factory, with `getNovel` as the one fully worked parser (the
other required methods follow the identical `host.fetch` → `parseHtml` → read shape):

```ts
import {
  absoluteUrl,
  parseHtml,
  sanitizeText,
  textOf,
  type Source,
  type SourceHost,
} from "@riwaq/extension-api";

const BASE_URL = "https://example-novels.test";

export default function createSource(host: SourceHost): Source {
  return {
    canHandle(url) {
      try {
        return new URL(url).hostname === new URL(BASE_URL).hostname;
      } catch {
        return false;
      }
    },

    async getNovel(url) {
      const resp = await host.fetch(url);
      const doc = parseHtml(resp.text);

      const chapters = Array.from(doc.querySelectorAll(".chapter-list a")).map((a, i) => ({
        id: i + 1,
        title: sanitizeText(a.textContent),
        url: absoluteUrl(a.getAttribute("href") ?? "", url),
        lines: [],
      }));

      return {
        title: textOf(doc, "h1.title") ?? "Untitled",
        author: textOf(doc, ".author") ?? "Unknown",
        language: "en",
        direction: "ltr" as const,
        tags: Array.from(doc.querySelectorAll(".tags a")).map((a) => sanitizeText(a.textContent)),
        meta: [],
        volumes: [{ id: 1, title: "Chapters", chapters }],
      };
    },

    // getHomeSections, search and getChapterContent follow the same
    // host.fetch(url) -> parseHtml(resp.text) -> read shape as getNovel above.
    async getHomeSections() {
      throw new Error("not implemented — see getNovel above for the pattern");
    },
    async search(_query) {
      throw new Error("not implemented — see getNovel above for the pattern");
    },
    async getChapterContent(_chapter) {
      throw new Error("not implemented — see getNovel above for the pattern");
    },
  };
}
```

**`tests/fixtures/novel.html`** — saved HTML (from a real site, this would be captured
with the browser's "Save Page As" or a `curl`, not hand-written):

```html
<!doctype html>
<html>
  <body>
    <h1 class="title">The Long Road</h1>
    <div class="author">A. Writer</div>
    <div class="tags"><a>fantasy</a><a>adventure</a></div>
    <ul class="chapter-list">
      <li><a href="/novels/the-long-road/1">Chapter 1: Departure</a></li>
      <li><a href="/novels/the-long-road/2">Chapter 2: The Crossing</a></li>
    </ul>
  </body>
</html>
```

**`tests/example-novels.test.ts`** — one test, using `createTestHost` and the
fixture-reading convention from [Testing](#testing):

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import createSource from "../src/index";
import { createTestHost } from "@riwaq/extension-api/testing";

const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");
const novelHtml = readFileSync(join(FIXTURES_DIR, "novel.html"), "utf8");

describe("getNovel", () => {
  it("parses title, author, tags and the chapter list from the saved fixture", async () => {
    const host = createTestHost({
      responses: { "https://example-novels.test/novels/the-long-road": novelHtml },
    });
    const source = createSource(host);

    const novel = await source.getNovel("https://example-novels.test/novels/the-long-road");

    expect(novel.title).toBe("The Long Road");
    expect(novel.author).toBe("A. Writer");
    expect(novel.tags).toEqual(["fantasy", "adventure"]);
    expect(novel.volumes[0].chapters).toEqual([
      {
        id: 1,
        title: "Chapter 1: Departure",
        url: "https://example-novels.test/novels/the-long-road/1",
        lines: [],
      },
      {
        id: 2,
        title: "Chapter 2: The Crossing",
        url: "https://example-novels.test/novels/the-long-road/2",
        lines: [],
      },
    ]);
  });
});
```

This `manifest.json`, `src/index.ts` exactly as printed above (stubs included), the
fixture and the test were extracted verbatim into a scratch `extensions/example-novels/`
directory and run through `pnpm typecheck`, `pnpm test`, `pnpm validate` and `pnpm
build` — all four passed — before the scratch directory was deleted again. What's on
this page is what actually compiles, not an earlier, fuller draft that got trimmed for
space.

For a complete extension with every method implemented against a real site — AJAX
endpoints, selector tables, nonce handling, decoy filtering, everything site-specific —
read `extensions/cenele/` and `extensions/kolnovel/` in this repo. They're real, working
extensions, not documentation; their own `README.md`s cover the site-specific detail this
worked example leaves out.
