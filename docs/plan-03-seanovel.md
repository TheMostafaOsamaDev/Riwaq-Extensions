# Sea Novel (بحر الروايات) Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `seanovel` extension for `https://seanovel.org` covering home, search, novel detail and chapter content.

**Architecture:** The site is Next.js with a public read-only JSON API on its own origin, so this extension is an API client rather than an HTML scraper — except for chapter bodies, which are only available as rendered HTML. The whole catalogue arrives in one call, so search and the home rows are computed locally from it.

**Tech Stack:** TypeScript, `@riwaq/extension-api`, Vitest + happy-dom, esbuild.

**Spec:** `Riwaq-reader/docs/superpowers/specs/2026-09-17-extensions-integration-design.md` §6.

## Global Constraints

- **Worktree:** `/Users/themostafaosama/Desktop/my-work/RiwaqExt-seanovel`, branch `feat/seanovel`.
- **No Claude/AI attribution** in any commit message or PR body.
- **Extensions reach the network only through `host`.** No direct `fetch`, no Node built-ins.
- **Bundle ceiling 512 KB**, enforced by `scripts/build.ts`.
- **`apiVersion` is 1.**
- **Extensions ship their own strings** via `src/strings.ts` keyed off `host.locale` — they cannot reach the app's message catalogue.
- **`author` is `""` when unknown**, never a literal "Unknown" — the host localises the empty case at display time.
- **Fixtures are saved API/HTML responses**, committed under `tests/fixtures/`. Tests never touch the network; `pnpm probe` is the live check.

## Site map (verified 2026-09-17)

| Need | Endpoint | Shape |
|---|---|---|
| Whole catalogue | `GET /api/novels` | Array of 217 rows. **Query params are ignored** — `?q=`, `?search=`, `?title=` all return the full list. |
| Novel detail | `GET /api/novel/<slug>` | Object, below |
| Chapter body | `GET /novels/<slug>/chapters/<id>` | HTML — `article.reader-content` |
| Cover | `GET /api/novel/<slug>/cover?type=webp` | Image bytes |

`/api/novel/<slug>` fields: `slug`, `source_id`, `title_ar`, `title_original`, `origin`, `author`, `status`, `genres: string[]`, `chapters_count`, `last_updated`, `first_published_at`, `description`, `rating`, `has_volumes: boolean`, `initial_chapters` (first 10), `similar_novels`, `cover_version`, **`chapters`** — the complete list, `[{ id, title, date }]`.

A catalogue row (`/api/novels`) carries: `slug`, `title_ar`, `title_original`, `origin`, `author`, `status`, `genres`, `chapters_count`, `last_updated`.

Two consequences that shape the whole extension:

1. **No lazy volumes and no chapter pagination.** `chapters` holds all 3,180 entries for the largest novel in the one detail call, and `has_volumes` is `false`. `hasLazyVolumes` stays unset and `getNovel` returns one fully-populated pseudo-volume.
2. **Search is local.** The catalogue is one cheap call and the server ignores query params, so `search()` fetches it and filters in memory. Real pagination over the filtered list is then free and honest.

There is a `GET /api/novel/<slug>/chapters?offset=&limit=` endpoint (`{chapters,total,offset,limit,sort,hasMore}`), but it is redundant given the detail call and is not used. `GET /api/novel/<slug>/chapters/<id>` returns `403 {"error":"Invalid or expired token"}` — chapter bodies must come from the HTML page.

---

### Task 1: Scaffold the extension

**Files:**
- Create: `extensions/seanovel/manifest.json`, `icon.png`, `src/index.ts`, `src/strings.ts`, `README.md`
- Create: `extensions/seanovel/tests/seanovel.test.ts`

**Interfaces:**
- Produces: `export default function createSource(host: SourceHost): Source`; `BASE_URL = "https://seanovel.org"`.

- [ ] **Step 1: Scaffold**

Run: `pnpm new-extension seanovel`

- [ ] **Step 2: Fill the manifest**

```json
{
  "id": "seanovel",
  "name": "بحر الروايات",
  "version": "1.0.0",
  "apiVersion": 1,
  "language": "ar",
  "baseUrl": "https://seanovel.org",
  "icon": "icon.png",
  "description": {
    "en": "Korean, Chinese and Japanese web novels translated into Arabic.",
    "ar": "روايات كورية وصينية ويابانية مترجمة إلى العربية."
  },
  "author": "Riwaq"
}
```

- [ ] **Step 3: Save a 128×128 icon** at `extensions/seanovel/icon.png` from the site's own favicon.

- [ ] **Step 4: Write the failing `canHandle` test**

```ts
import { describe, expect, it } from "vitest";
import { createTestHost } from "@riwaq/extension-api/testing";
import createSource from "../src/index";

const source = createSource(createTestHost());

describe("canHandle", () => {
  it("accepts seanovel novel and chapter URLs", () => {
    expect(source.canHandle("https://seanovel.org/novels/shadow-slave")).toBe(true);
    expect(source.canHandle("https://seanovel.org/novels/shadow-slave/chapters/1")).toBe(true);
    expect(source.canHandle("https://www.seanovel.org/novels/x")).toBe(true);
  });

  it("rejects other sites", () => {
    expect(source.canHandle("https://cenele.com/cont/x/")).toBe(false);
    expect(source.canHandle("not a url")).toBe(false);
  });
});
```

- [ ] **Step 5: Run and watch it fail** — `pnpm vitest run extensions/seanovel`

- [ ] **Step 6: Implement `canHandle`**

```ts
const BASE_URL = "https://seanovel.org";
const HOSTS = new Set(["seanovel.org", "www.seanovel.org"]);

canHandle(url: string): boolean {
  try {
    return HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}
```

- [ ] **Step 7: Run, confirm PASS, and commit**

```bash
git add extensions/seanovel
git commit -m "feat(seanovel): scaffold the extension"
```

---

### Task 2: Catalogue — home sections and search

**Files:**
- Modify: `extensions/seanovel/src/index.ts`, `src/strings.ts`
- Create: `extensions/seanovel/tests/fixtures/novels.json`
- Modify: `extensions/seanovel/tests/seanovel.test.ts`

**Interfaces:**
- Produces: `fetchCatalogue(host): Promise<CatalogueRow[]>`; `cardFor(row): NovelCard`; `getHomeSections()`; `search(query, page)`.

- [ ] **Step 1: Capture the catalogue fixture**

```bash
curl -sS --compressed -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" \
  https://seanovel.org/api/novels -o extensions/seanovel/tests/fixtures/novels.json
```

- [ ] **Step 2: Write the failing tests**

```ts
const novelsFixture = readFileSync(new URL("./fixtures/novels.json", import.meta.url), "utf8");
const host = createTestHost({ responses: { "/api/novels": novelsFixture }, locale: "ar" });
const source = createSource(host);

describe("getHomeSections", () => {
  it("builds rows from one catalogue call", async () => {
    const sections = await source.getHomeSections();
    expect(sections.map((s) => s.id)).toEqual(["latest", "popular", "completed"]);
    for (const s of sections) expect(s.cards.length).toBeGreaterThan(0);
  });

  it("orders 'latest' by last_updated, newest first", async () => {
    const [latest] = await source.getHomeSections();
    const rows = JSON.parse(novelsFixture) as Array<{ title_ar: string; last_updated: string }>;
    const expected = [...rows]
      .sort((a, b) => Date.parse(b.last_updated) - Date.parse(a.last_updated))[0];
    expect(latest.cards[0].title).toBe(expected.title_ar);
  });

  it("puts only completed novels in the completed row", async () => {
    const rows = JSON.parse(novelsFixture) as Array<{ title_ar: string; status: string }>;
    const completedTitles = new Set(
      rows.filter((r) => r.status === "completed").map((r) => r.title_ar),
    );
    const section = (await source.getHomeSections()).find((s) => s.id === "completed")!;
    for (const card of section.cards) expect(completedTitles.has(card.title)).toBe(true);
  });
});

describe("search", () => {
  it("matches on the Arabic title", async () => {
    const r = await source.search("عبد الظل", 1);
    expect(r.cards.some((c) => c.title.includes("عبد الظل"))).toBe(true);
    expect(r.query).toBe("عبد الظل");
    expect(r.page).toBe(1);
  });

  it("matches on the original title too", async () => {
    const r = await source.search("Shadow Slave", 1);
    expect(r.cards.length).toBeGreaterThan(0);
  });

  it("paginates the filtered list and reports hasMore truthfully", async () => {
    // The server ignores query params, so paging is ours to do correctly.
    const all = await source.search("ا", 1);
    if (all.hasMore) {
      const two = await source.search("ا", 2);
      expect(two.cards.length).toBeGreaterThan(0);
      expect(two.cards[0].url).not.toBe(all.cards[0].url);
    }
  });

  it("returns an empty result rather than throwing when nothing matches", async () => {
    const r = await source.search("zzzzzzzznomatch", 1);
    expect(r.cards).toEqual([]);
    expect(r.hasMore).toBe(false);
  });
});
```

- [ ] **Step 3: Run and watch them fail.**

- [ ] **Step 4: Implement**

```ts
const PAGE_SIZE = 24;

interface CatalogueRow {
  slug: string;
  title_ar: string;
  title_original?: string;
  origin?: string;
  author?: string;
  status?: string;
  genres?: string[];
  chapters_count?: number;
  last_updated?: string;
}

/** The catalogue is one call and the server ignores query params, so it is
 *  fetched once per session and reused for both search and the home rows. */
let cataloguePromise: Promise<CatalogueRow[]> | null = null;

function fetchCatalogue(host: SourceHost): Promise<CatalogueRow[]> {
  cataloguePromise ??= (async () => {
    const resp = await host.fetch(`${BASE_URL}/api/novels`);
    const rows = JSON.parse(resp.text) as unknown;
    if (!Array.isArray(rows)) {
      throw new Error("Sea Novel: /api/novels did not return a list of novels.");
    }
    return rows as CatalogueRow[];
  })();
  return cataloguePromise;
}

const novelUrl = (slug: string) => `${BASE_URL}/novels/${slug}`;
const coverUrl = (slug: string) => `${BASE_URL}/api/novel/${slug}/cover?type=webp`;

function cardFor(row: CatalogueRow): NovelCard {
  return {
    url: novelUrl(row.slug),
    title: row.title_ar || row.title_original || row.slug,
    coverUrl: coverUrl(row.slug),
    subtitle: row.title_original || undefined,
    badges: row.genres?.slice(0, 3),
  };
}
```

`getHomeSections` builds three rows from the one catalogue: `latest` (by `last_updated` desc), `popular` (by `chapters_count` desc), `completed` (`status === "completed"`), each capped at `PAGE_SIZE` and each dropped entirely if empty. `search` lowercases and matches `title_ar`, `title_original` and `slug`, then slices page `n` and sets `hasMore` from the remaining length.

- [ ] **Step 5: Run, confirm PASS.**

- [ ] **Step 6: Tamper-check** — make `search` ignore `title_original`. The "matches on the original title" test must fail. Restore.

- [ ] **Step 7: Commit**

```bash
git add extensions/seanovel
git commit -m "feat(seanovel): home rows and search from the catalogue

The site serves its whole catalogue in one call and ignores query
params, so search filters locally and pages the filtered list honestly
rather than pretending the server did it."
```

---

### Task 3: Novel detail

**Files:**
- Modify: `extensions/seanovel/src/index.ts`
- Create: `extensions/seanovel/tests/fixtures/novel.json`
- Modify: `extensions/seanovel/tests/seanovel.test.ts`

**Interfaces:**
- Produces: `getNovel(url): Promise<SourceNovel>`; `slugFromUrl(url): string`.

- [ ] **Step 1: Capture the fixture**

```bash
curl -sS --compressed -A "…" https://seanovel.org/api/novel/shadow-slave \
  -o extensions/seanovel/tests/fixtures/novel.json
```

- [ ] **Step 2: Write the failing tests**

```ts
describe("getNovel", () => {
  it("maps the API's fields onto SourceNovel", async () => {
    const novel = await source.getNovel("https://seanovel.org/novels/shadow-slave");
    expect(novel.title).toBe("عبد الظل");
    expect(novel.originalTitle).toBe("Shadow Slave");
    expect(novel.author).toBe("Guiltythree");
    expect(novel.language).toBe("ar");
    expect(novel.direction).toBe("rtl");
    expect(novel.coverUrl).toContain("/api/novel/shadow-slave/cover");
    expect(novel.tags.length).toBeGreaterThan(0);
    expect(novel.description).toBeTruthy();
  });

  it("returns one fully-populated volume, not a lazy one", async () => {
    // chapters_count is 3180 and the detail call carries every entry, so
    // there is nothing to lazily fetch.
    expect(source.hasLazyVolumes).toBeFalsy();
    const novel = await source.getNovel("https://seanovel.org/novels/shadow-slave");
    expect(novel.volumes).toHaveLength(1);
    expect(novel.volumes[0].chapters.length).toBe(3180);
  });

  it("points each chapter at its own page URL", async () => {
    const novel = await source.getNovel("https://seanovel.org/novels/shadow-slave");
    const first = novel.volumes[0].chapters[0];
    expect(first.url).toBe("https://seanovel.org/novels/shadow-slave/chapters/0");
    expect(first.title).not.toBe("");
  });

  it("leaves author empty rather than inventing 'Unknown'", async () => {
    const bare = createSource(
      createTestHost({
        responses: {
          "/api/novel/x": JSON.stringify({
            slug: "x", title_ar: "بلا", genres: [], chapters: [], chapters_count: 0,
          }),
        },
      }),
    );
    expect((await bare.getNovel("https://seanovel.org/novels/x")).author).toBe("");
  });

  it("rejects a URL that is not a novel page", async () => {
    await expect(source.getNovel("https://seanovel.org/about")).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run and watch them fail.**

- [ ] **Step 4: Implement**

```ts
/** `/novels/<slug>` and `/novels/<slug>/chapters/<n>` both yield <slug>. */
function slugFromUrl(url: string): string {
  const m = new URL(url).pathname.match(/^\/novels\/([^/]+)/);
  if (!m) {
    throw new SourceUrlError(`Sea Novel: ${url} is not a novel page URL.`);
  }
  return decodeURIComponent(m[1]);
}
```

`getNovel` fetches `/api/novel/<slug>`, then maps: `title ← title_ar`, `originalTitle ← title_original`, `author ← author ?? ""`, `language: "ar"`, `direction: "rtl"`, `coverUrl ← coverUrl(slug)`, `description ← description`, `tags ← genres ?? []`, `status ← status`, and `meta` from `origin` and `chapters_count` as labelled rows via `strings(host.locale)`. Volumes are a single pseudo-volume whose `chapters` map each `{id,title}` to `{ id, title, url: ${BASE_URL}/novels/${slug}/chapters/${id}, lines: [] }`.

- [ ] **Step 5: Run, confirm PASS.**

- [ ] **Step 6: Tamper-check** — return `author: data.author ?? "Unknown"`. The author test must fail. Restore.

- [ ] **Step 7: Commit**

```bash
git add extensions/seanovel
git commit -m "feat(seanovel): novel detail from the JSON API

The detail call carries every chapter and reports has_volumes false, so
this returns one fully-populated volume and never declares lazy volumes."
```

---

### Task 4: Chapter content

Chapter bodies are the one thing the API will not serve — `/api/novel/<slug>/chapters/<id>` answers `403 {"error":"Invalid or expired token"}`. The rendered page is public, so parse that.

**Files:**
- Modify: `extensions/seanovel/src/index.ts`
- Create: `extensions/seanovel/tests/fixtures/chapter.html`
- Modify: `extensions/seanovel/tests/seanovel.test.ts`

- [ ] **Step 1: Capture the fixture**

```bash
curl -sS --compressed -A "…" https://seanovel.org/novels/shadow-slave/chapters/1 \
  -o extensions/seanovel/tests/fixtures/chapter.html
```

- [ ] **Step 2: Write the failing tests**

```ts
describe("getChapterContent", () => {
  it("returns the body paragraphs as text lines", async () => {
    const lines = await source.getChapterContent({
      id: 1, title: "الفصل 1", url: "https://seanovel.org/novels/shadow-slave/chapters/1", lines: [],
    });
    expect(lines.length).toBeGreaterThan(20);
    expect(lines.every((l) => l.type === "text")).toBe(true);
    expect(lines.every((l) => l.content.trim() !== "")).toBe(true);
  });

  it("drops the screen-reader SEO blurb", () => {
    // The first child of article.reader-content is a p.sr-only marketing
    // line ("you are reading chapter N of …"), not chapter text.
    return source
      .getChapterContent({ id: 1, title: "", url: ".../chapters/1", lines: [] })
      .then((lines) => {
        expect(lines[0].content).not.toMatch(/أنت تقرأ الفصل/);
      });
  });

  it("throws a clear error when the body is missing", async () => {
    const empty = createSource(createTestHost({ responses: { "/chapters/9": "<html><body></body></html>" } }));
    await expect(
      empty.getChapterContent({ id: 9, title: "", url: "https://seanovel.org/novels/x/chapters/9", lines: [] }),
    ).rejects.toThrow(/reader-content|chapter body/i);
  });
});
```

- [ ] **Step 3: Run and watch them fail.**

- [ ] **Step 4: Implement**

```ts
async getChapterContent(chapter: SourceChapter): Promise<SourceLine[]> {
  const resp = await host.fetch(chapter.url);
  const doc = parseHtml(resp.text);
  const root = doc.querySelector("article.reader-content");
  if (!root) {
    throw new Error(
      `Sea Novel: no chapter body (article.reader-content) at ${chapter.url}. ` +
        `The site layout may have changed.`,
    );
  }
  const lines: SourceLine[] = [];
  for (const p of Array.from(root.querySelectorAll("p"))) {
    // p.sr-only is an SEO blurb aimed at screen readers, not chapter text.
    if (p.classList.contains("sr-only")) continue;
    const content = sanitizeText(p.textContent);
    if (content) lines.push({ type: "text", content });
  }
  if (lines.length === 0) {
    throw new Error(`Sea Novel: chapter body at ${chapter.url} parsed to zero lines.`);
  }
  return lines;
}
```

- [ ] **Step 5: Run, confirm PASS.**

- [ ] **Step 6: Tamper-check** — drop the `sr-only` skip. The blurb test must fail. Restore.

- [ ] **Step 7: Commit**

```bash
git add extensions/seanovel
git commit -m "feat(seanovel): chapter content from the rendered page

The chapter API needs a token we do not have and 403s, but the rendered
page is public. The leading p.sr-only is an SEO blurb, not chapter text."
```

---

### Task 5: Document, verify and open the PR

- [ ] **Step 1: Write `extensions/seanovel/README.md`** — the endpoint table above, the three quirks (params ignored on `/api/novels`; chapters arrive whole in the detail call; chapter API 403s so bodies come from HTML), and how to re-capture each fixture.

- [ ] **Step 2: Live probe**

Run: `PROBE_ID=seanovel PROBE_QUERY="عبد" pnpm probe`

This needs the harness from the cenele plan's Task 1. If that branch has not merged yet, copy `scripts/probe.ts` and `scripts/probe.config.ts` in locally and **do not commit them here** — they belong to that PR, and committing them in both produces a conflict.

Expected: PASS on every method.

- [ ] **Step 3: Full gate**

Run: `pnpm validate && pnpm typecheck && pnpm test && pnpm build`
Expected: all pass; `dist/index.min.json` gains a `seanovel` entry under the 512 KB ceiling.

- [ ] **Step 4: Open the PR** — no Claude/AI attribution.

---

## Self-Review

**Spec coverage.** Spec §6 "seanovel.org — new": Next.js, server-rendered, static fetch and parse, with an API probed for first. The API exists and is better than scraping, so the extension uses it for everything except chapter bodies, which are token-gated. Every required `Source` member is implemented: `canHandle` (Task 1), `getHomeSections`/`search` (Task 2), `getNovel` (Task 3), `getChapterContent` (Task 4). `getVolumeChapters` and `searchChapters` are correctly absent — the first because nothing is lazy, the second because it is optional and the full chapter list is already in hand.

**Placeholder scan.** No TBD/TODO. Task 2 Step 4 and Task 3 Step 4 describe the mapping in prose after showing the non-obvious code (the memoised catalogue, the slug parser); the mappings are field-to-field and fully enumerated, with every source field named.

**Type consistency.** `CatalogueRow` (Task 2) is the shape of a `/api/novels` row and is used only there. `slugFromUrl` (Task 3) is reused by `getChapterContent` indirectly via `chapter.url`. `cardFor` returns `NovelCard`, matching `SourceSection.cards` and `SourceSearchResult.cards`. `coverUrl(slug)` is defined in Task 2 and used again in Task 3.
