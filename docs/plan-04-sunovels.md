# Sun Novels (شمس الروايات) Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `sunovels` extension for `https://sunovels.com` covering home, search, novel detail and chapter content.

**Architecture:** A Next.js App Router site with no JSON API, so this is an HTML scraper throughout. The chapter list is paginated 50 at a time behind a `page` query parameter that plain server-rendered fetches honour, so the extension declares lazy volumes and pulls the pages only when the user expands the chapter list.

**Tech Stack:** TypeScript, `@riwaq/extension-api`, Vitest + happy-dom, esbuild.

**Spec:** `Riwaq-reader/docs/superpowers/specs/2026-09-17-extensions-integration-design.md` §6.

## Global Constraints

- **Worktree:** `/Users/themostafaosama/Desktop/my-work/RiwaqExt-sunovels`, branch `feat/sunovels`.
- **No Claude/AI attribution** in any commit message or PR body.
- **Extensions reach the network only through `host`.** No direct `fetch`, no Node built-ins.
- **Bundle ceiling 512 KB**, enforced by `scripts/build.ts`.
- **`apiVersion` is 1.**
- **Extensions ship their own strings** via `src/strings.ts` keyed off `host.locale`.
- **`author` is `""` when unknown**, never a literal "Unknown".
- **Fixtures are saved HTML**, committed under `tests/fixtures/`. Tests never touch the network.

## Site map (verified 2026-09-17)

| Need | URL | Notes |
|---|---|---|
| Novel detail | `/novel/<slug>` | Server-rendered |
| Chapter list | `/novel/<slug>?activeTab=chapters&page=<n>` | **`page` is 0-indexed**, 50 per page |
| Chapter body | `/novel/<slug>/<chapterNumber>` | `.chapter-content` |
| Catalogue | `/library` | |
| Search | `/search` | |

**There is no JSON API.** `/api/novel/<slug>`, `/api/novels` and friends all 404. `/dev` is a changelog page, not API documentation.

Selectors confirmed against the live novel page:

| Field | Selector | Note |
|---|---|---|
| original title | `.main-head h1` | e.g. "Shadow Slave" |
| Arabic title | `.main-head h3` | e.g. "عبد الظل" — **inverted vs seanovel**, where `h1` is Arabic |
| cover | `figure.cover img` | `src` is site-relative (`/uploads/…`) |
| tags / genres | `a.tag` | |
| chapter rows | `.chaptersList` | each row links `/novel/<slug>/<n>` |
| chapter title | `.chapter-title` | |
| chapter date | `.chapter-update` | |
| chapter body | `.chapter-content` | `<p>` children |

Two findings that shape the design:

1. **Chapter numbers have gaps.** The novel above reports `chaptersCount: 1582` while its newest chapter is numbered **1611**. Enumerating `1..count` would therefore both miss real chapters and request numbers that do not exist. The paginated list is the only correct source — never synthesise chapter numbers.
2. **Pagination works without the RSC token.** The site fetches `…&page=1&_rsc=<token>` when the user clicks, but a plain fetch of `…&page=1` returns the same server-rendered rows. Page 31 returns a short page, consistent with ~1583 chapters over 32 pages. No special transport is needed.

---

### Task 1: Scaffold and `canHandle`

**Files:**
- Create: `extensions/sunovels/manifest.json`, `icon.png`, `src/index.ts`, `src/strings.ts`, `README.md`
- Create: `extensions/sunovels/tests/sunovels.test.ts`

**Interfaces:**
- Produces: `export default function createSource(host: SourceHost): Source`; `BASE_URL = "https://sunovels.com"`; `slugFromUrl(url): string`.

- [ ] **Step 1: Scaffold** — `pnpm new-extension sunovels`

- [ ] **Step 2: Fill the manifest**

```json
{
  "id": "sunovels",
  "name": "شمس الروايات",
  "version": "1.0.0",
  "apiVersion": 1,
  "language": "ar",
  "baseUrl": "https://sunovels.com",
  "icon": "icon.png",
  "description": {
    "en": "Arabic translated and original web novels, updated daily.",
    "ar": "روايات ويب مترجمة ومؤلفة بالعربية، بتحديثات يومية."
  },
  "author": "Riwaq"
}
```

- [ ] **Step 3: Save a 128×128 `icon.png`** from the site's favicon.

- [ ] **Step 4: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { createTestHost } from "@riwaq/extension-api/testing";
import createSource from "../src/index";

const source = createSource(createTestHost());

describe("canHandle", () => {
  it("accepts novel and chapter URLs", () => {
    expect(source.canHandle("https://sunovels.com/novel/shadow-slave")).toBe(true);
    expect(source.canHandle("https://sunovels.com/novel/shadow-slave/12")).toBe(true);
    expect(source.canHandle("https://www.sunovels.com/novel/x")).toBe(true);
  });

  it("rejects other sites and malformed input", () => {
    expect(source.canHandle("https://seanovel.org/novels/x")).toBe(false);
    expect(source.canHandle("nonsense")).toBe(false);
  });
});
```

- [ ] **Step 5: Run and watch it fail** — `pnpm vitest run extensions/sunovels`

- [ ] **Step 6: Implement**

```ts
const BASE_URL = "https://sunovels.com";
const HOSTS = new Set(["sunovels.com", "www.sunovels.com"]);

function canHandle(url: string): boolean {
  try {
    return HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Both `/novel/<slug>` and `/novel/<slug>/<n>` yield <slug>. */
function slugFromUrl(url: string): string {
  const m = new URL(url).pathname.match(/^\/novel\/([^/]+)/);
  if (!m) throw new SourceUrlError(`Sun Novels: ${url} is not a novel page URL.`);
  return decodeURIComponent(m[1]);
}
```

- [ ] **Step 7: Run, confirm PASS, commit**

```bash
git add extensions/sunovels
git commit -m "feat(sunovels): scaffold the extension"
```

---

### Task 2: Novel detail

**Files:**
- Modify: `extensions/sunovels/src/index.ts`
- Create: `extensions/sunovels/tests/fixtures/novel.html`
- Modify: `extensions/sunovels/tests/sunovels.test.ts`

**Interfaces:**
- Produces: `getNovel(url): Promise<SourceNovel>`; `hasLazyVolumes = true`; `parseChaptersCount(html): number`.

- [ ] **Step 1: Capture the fixture**

```bash
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
curl -sS --compressed -A "$UA" https://sunovels.com/novel/shadow-slave \
  -o extensions/sunovels/tests/fixtures/novel.html
```

- [ ] **Step 2: Write the failing tests**

```ts
const novelHtml = readFileSync(new URL("./fixtures/novel.html", import.meta.url), "utf8");
const source = createSource(
  createTestHost({ responses: { "/novel/shadow-slave": novelHtml }, locale: "ar" }),
);

describe("getNovel", () => {
  it("takes the Arabic title from h3 and the original from h1", async () => {
    // Inverted relative to seanovel: here h1 is the ORIGINAL title.
    const novel = await source.getNovel("https://sunovels.com/novel/shadow-slave");
    expect(novel.title).toBe("عبد الظل");
    expect(novel.originalTitle).toBe("Shadow Slave");
  });

  it("absolutises the site-relative cover path", async () => {
    const novel = await source.getNovel("https://sunovels.com/novel/shadow-slave");
    expect(novel.coverUrl).toMatch(/^https:\/\/sunovels\.com\/uploads\//);
  });

  it("collects the tag chips", async () => {
    const novel = await source.getNovel("https://sunovels.com/novel/shadow-slave");
    expect(novel.tags.length).toBeGreaterThan(0);
    expect(novel.tags.every((t) => t.trim() !== "")).toBe(true);
  });

  it("declares one lazy volume carrying the real chapter count", async () => {
    expect(source.hasLazyVolumes).toBe(true);
    const novel = await source.getNovel("https://sunovels.com/novel/shadow-slave");
    expect(novel.volumes).toHaveLength(1);
    expect(novel.volumes[0].chapters).toEqual([]);
    expect(novel.volumes[0].chapterCount).toBe(1582);
  });

  it("is rtl Arabic", async () => {
    const novel = await source.getNovel("https://sunovels.com/novel/shadow-slave");
    expect(novel.language).toBe("ar");
    expect(novel.direction).toBe("rtl");
  });
});
```

- [ ] **Step 3: Run and watch them fail.**

- [ ] **Step 4: Implement**

```ts
/** The page's RSC payload carries the authoritative count. It is not in
 *  the rendered markup, and it is NOT the highest chapter number — this
 *  novel reports 1582 chapters whose newest is numbered 1611. */
function parseChaptersCount(html: string): number {
  const m = html.match(/chaptersCount\\?":\s*(\d+)/);
  return m ? Number.parseInt(m[1], 10) : 0;
}
```

`getNovel` fetches `/novel/<slug>`, parses with `parseHtml`, then maps:
`title ← .main-head h3` (falling back to `h1` when absent), `originalTitle ← .main-head h1`,
`coverUrl ← absoluteUrl(figure.cover img[src], BASE_URL)`, `tags ← [...a.tag].map(textContent)`,
`author: ""` (the page does not surface one), `language: "ar"`, `direction: "rtl"`,
and one volume `{ id: 1, title: strings(host.locale)("allChapters"), chapters: [], chapterCount: parseChaptersCount(resp.text), key: slug }`.

- [ ] **Step 5: Run, confirm PASS.**

- [ ] **Step 6: Tamper-check** — swap the h1/h3 mapping. The first test must fail. Restore.

- [ ] **Step 7: Commit**

```bash
git add extensions/sunovels
git commit -m "feat(sunovels): novel detail

h1 is the original title and h3 the Arabic one, which is the opposite of
seanovel — worth stating because getting it backwards still produces a
plausible-looking card. The chapter count comes from the page payload,
not from the highest chapter number: this novel has 1582 chapters whose
newest is numbered 1611."
```

---

### Task 3: Chapter list

**Files:**
- Modify: `extensions/sunovels/src/index.ts`
- Create: `extensions/sunovels/tests/fixtures/chapters-page0.html`, `chapters-page1.html`
- Modify: `extensions/sunovels/tests/sunovels.test.ts`

**Interfaces:**
- Consumes: `slugFromUrl`, `parseChaptersCount` (Task 2).
- Produces: `chapterPageUrl(slug, page): string`; `parseChapterRows(doc, slug): SourceChapter[]`; `getVolumeChapters(novelUrl, volume): Promise<SourceChapter[]>`.

- [ ] **Step 1: Capture two pages**

```bash
D=extensions/sunovels/tests/fixtures
curl -sS --compressed -A "$UA" "https://sunovels.com/novel/shadow-slave?activeTab=chapters&page=0" -o $D/chapters-page0.html
curl -sS --compressed -A "$UA" "https://sunovels.com/novel/shadow-slave?activeTab=chapters&page=1" -o $D/chapters-page1.html
```

- [ ] **Step 2: Write the failing tests**

```ts
describe("getVolumeChapters", () => {
  const host = createTestHost({
    responses: {
      "activeTab=chapters&page=0": readFileSync(new URL("./fixtures/chapters-page0.html", import.meta.url), "utf8"),
      "activeTab=chapters&page=1": readFileSync(new URL("./fixtures/chapters-page1.html", import.meta.url), "utf8"),
    },
    locale: "ar",
  });

  it("uses a 0-indexed page parameter", () => {
    expect(chapterPageUrl("shadow-slave", 0)).toBe(
      "https://sunovels.com/novel/shadow-slave?activeTab=chapters&page=0",
    );
  });

  it("parses only chapter-list rows, not the header's first/latest shortcuts", () => {
    // The page header links the first and newest chapters on EVERY page.
    // Counting those would duplicate chapter 1 into all 32 pages.
    const rows = parseChapterRows(parseHtml(page0Html), "shadow-slave");
    expect(rows.length).toBeLessThanOrEqual(50);
    expect(rows.filter((c) => c.url.endsWith("/1"))).toHaveLength(1);
  });

  it("returns the second page's chapters, not the first's", () => {
    const p0 = parseChapterRows(parseHtml(page0Html), "shadow-slave");
    const p1 = parseChapterRows(parseHtml(page1Html), "shadow-slave");
    expect(p1[0].url).not.toBe(p0[0].url);
  });

  it("gives every chapter a non-empty title and an absolute URL", () => {
    for (const c of parseChapterRows(parseHtml(page0Html), "shadow-slave")) {
      expect(c.title.trim()).not.toBe("");
      expect(c.url).toMatch(/^https:\/\/sunovels\.com\/novel\/shadow-slave\/\d+$/);
    }
  });

  it("walks every page and de-duplicates across them", async () => {
    const src = createSource(host);
    const chapters = await src.getVolumeChapters!("https://sunovels.com/novel/shadow-slave", {
      id: 1, title: "all", chapters: [], chapterCount: 100, key: "shadow-slave",
    });
    expect(new Set(chapters.map((c) => c.url)).size).toBe(chapters.length);
  });
});
```

- [ ] **Step 3: Run and watch them fail.**

- [ ] **Step 4: Implement**

```ts
const PER_PAGE = 50;

/** `page` is 0-indexed — the site's own pagination starts at 0, and a
 *  1-indexed guess silently skips the first fifty chapters. */
function chapterPageUrl(slug: string, page: number): string {
  return `${BASE_URL}/novel/${slug}?activeTab=chapters&page=${page}`;
}

function parseChapterRows(doc: Document, slug: string): SourceChapter[] {
  const list = doc.querySelector(".chaptersList");
  if (!list) return [];
  const out: SourceChapter[] = [];
  const seen = new Set<string>();
  for (const a of Array.from(list.querySelectorAll(`a[href^="/novel/${slug}/"]`))) {
    const href = a.getAttribute("href");
    if (!href || seen.has(href)) continue;
    const num = Number.parseInt(href.split("/").pop() ?? "", 10);
    if (!Number.isFinite(num)) continue;
    const title = sanitizeText(
      a.querySelector(".chapter-title")?.textContent ?? a.textContent,
    );
    if (!title) continue;
    seen.add(href);
    out.push({ id: num, title, url: absoluteUrl(href, BASE_URL), lines: [] });
  }
  return out;
}
```

`getVolumeChapters` derives the page count from `volume.chapterCount` (`Math.ceil(count / PER_PAGE)`, at least 1), fetches each page **sequentially** — 32 requests fired at once is abusive and invites rate-limiting — accumulates rows, de-duplicates by URL, and stops early if a page yields none.

- [ ] **Step 5: Run, confirm PASS.**

- [ ] **Step 6: Tamper-check** — change `chapterPageUrl` to `page + 1`. The 0-indexed test must fail. Then scope `parseChapterRows` to the whole document instead of `.chaptersList`; the "only chapter-list rows" test must fail. Restore both.

- [ ] **Step 7: Commit**

```bash
git add extensions/sunovels
git commit -m "feat(sunovels): paginated chapter list

page is 0-indexed and serves 50 rows; a 1-indexed guess silently drops
the first fifty chapters. Rows are read from .chaptersList only, because
the page header links the first and newest chapters on every page and
counting those duplicates chapter 1 across all 32 pages.

Pages are fetched sequentially rather than all at once — 32 concurrent
requests invites rate-limiting for no gain."
```

---

### Task 4: Chapter content

**Files:**
- Modify: `extensions/sunovels/src/index.ts`
- Create: `extensions/sunovels/tests/fixtures/chapter.html`
- Modify: `extensions/sunovels/tests/sunovels.test.ts`

- [ ] **Step 1: Capture the fixture**

```bash
curl -sS --compressed -A "$UA" https://sunovels.com/novel/shadow-slave/1 \
  -o extensions/sunovels/tests/fixtures/chapter.html
```

- [ ] **Step 2: Write the failing tests**

```ts
describe("getChapterContent", () => {
  it("returns the body paragraphs as text lines", async () => {
    const lines = await source.getChapterContent({
      id: 1, title: "الفصل 1", url: "https://sunovels.com/novel/shadow-slave/1", lines: [],
    });
    expect(lines.length).toBeGreaterThan(20);
    expect(lines.every((l) => l.type === "text")).toBe(true);
    expect(lines.every((l) => l.content.trim() !== "")).toBe(true);
  });

  it("throws a clear error when the body is missing", async () => {
    const empty = createSource(
      createTestHost({ responses: { "/novel/x/9": "<html><body></body></html>" } }),
    );
    await expect(
      empty.getChapterContent({ id: 9, title: "", url: "https://sunovels.com/novel/x/9", lines: [] }),
    ).rejects.toThrow(/chapter-content|chapter body/i);
  });
});
```

- [ ] **Step 3: Run and watch them fail.**

- [ ] **Step 4: Implement**

```ts
async getChapterContent(chapter: SourceChapter): Promise<SourceLine[]> {
  const resp = await host.fetch(chapter.url);
  const doc = parseHtml(resp.text);
  const root = doc.querySelector(".chapter-content");
  if (!root) {
    throw new Error(
      `Sun Novels: no chapter body (.chapter-content) at ${chapter.url}. ` +
        `The site layout may have changed.`,
    );
  }
  const lines: SourceLine[] = [];
  for (const p of Array.from(root.querySelectorAll("p"))) {
    const content = sanitizeText(p.textContent);
    if (content) lines.push({ type: "text", content });
  }
  if (lines.length === 0) {
    throw new Error(`Sun Novels: chapter body at ${chapter.url} parsed to zero lines.`);
  }
  return lines;
}
```

- [ ] **Step 5: Run, confirm PASS, commit**

```bash
git add extensions/sunovels
git commit -m "feat(sunovels): chapter content"
```

---

### Task 5: Home sections and search

**Files:**
- Modify: `extensions/sunovels/src/index.ts`, `src/strings.ts`
- Create: `extensions/sunovels/tests/fixtures/library.html`, `search.html`
- Modify: `extensions/sunovels/tests/sunovels.test.ts`

- [ ] **Step 1: Capture the fixtures and confirm the search parameter**

```bash
D=extensions/sunovels/tests/fixtures
curl -sS --compressed -A "$UA" "https://sunovels.com/library" -o $D/library.html
curl -sS --compressed -A "$UA" "https://sunovels.com/search?q=%D8%B9%D8%A8%D8%AF" -o $D/search.html
grep -c 'href="/novel/' $D/search.html
```

If `search?q=` renders no results server-side, try `?query=`, `?s=`, `?term=` and keep whichever returns novel links. Record the winner in the README. If none render server-side, implement `search` over `/library` filtered in memory, exactly as the seanovel extension does, and say so in the README.

- [ ] **Step 2: Write the failing tests**

```ts
describe("getHomeSections", () => {
  it("returns at least one section, all non-empty", async () => {
    const sections = await source.getHomeSections();
    expect(sections.length).toBeGreaterThan(0);
    for (const s of sections) expect(s.cards.length).toBeGreaterThan(0);
  });

  it("gives every card an absolute novel URL and a title", async () => {
    for (const card of (await source.getHomeSections()).flatMap((s) => s.cards)) {
      expect(card.url).toMatch(/^https:\/\/sunovels\.com\/novel\//);
      expect(card.title.trim()).not.toBe("");
    }
  });
});

describe("search", () => {
  it("finds a known novel and echoes the query", async () => {
    const r = await source.search("عبد", 1);
    expect(r.cards.length).toBeGreaterThan(0);
    expect(r.query).toBe("عبد");
    expect(r.page).toBe(1);
  });

  it("returns an empty result rather than throwing when nothing matches", async () => {
    const r = await source.search("zzzzzznomatch", 1);
    expect(r.cards).toEqual([]);
    expect(r.hasMore).toBe(false);
  });
});
```

- [ ] **Step 3: Run, implement, confirm PASS.**

Cards come from anchors matching `a[href^="/novel/"]` whose href has exactly two path segments (so chapter links are excluded), with the title from the card's heading and the cover from its `img`.

- [ ] **Step 4: Commit**

```bash
git add extensions/sunovels
git commit -m "feat(sunovels): home sections and search"
```

---

### Task 6: Document, verify and open the PR

- [ ] **Step 1: Write `extensions/sunovels/README.md`** — the site-map and selector tables above, plus the three traps: `page` is 0-indexed; chapter numbers are sparse so `chaptersCount` is not the highest number; `h1`/`h3` are original/Arabic, inverted relative to seanovel.

- [ ] **Step 2: Live probe**

Run: `PROBE_ID=sunovels PROBE_QUERY="عبد" pnpm probe`

Needs the harness from the cenele plan's Task 1. If that branch has not merged, copy `scripts/probe.ts` and `scripts/probe.config.ts` in locally and **do not commit them here** — they belong to that PR.

Expected: PASS on every method. Sanity-check that `getVolumeChapters` returns a count close to `chaptersCount`, not 50.

- [ ] **Step 3: Full gate**

Run: `pnpm validate && pnpm typecheck && pnpm test && pnpm build`
Expected: all pass; `dist/index.min.json` gains a `sunovels` entry under the 512 KB ceiling.

- [ ] **Step 4: Open the PR** — no Claude/AI attribution.

---

## Self-Review

**Spec coverage.** Spec §6 "sunovels.com — new" said to probe `/dev` for a documented JSON API and prefer it, else HTML selectors with saved fixtures. `/dev` turned out to be a changelog and no API exists, so the HTML path is taken as the spec's fallback directs. Required `Source` members: `canHandle` (Task 1), `getNovel` + `hasLazyVolumes` (Task 2), `getVolumeChapters` (Task 3), `getChapterContent` (Task 4), `getHomeSections` + `search` (Task 5). `searchChapters` is optional and omitted.

**Placeholder scan.** No TBD/TODO. Task 5 Step 1 contains the one genuinely open question — which query parameter the search page honours — written as an ordered list of candidates with a defined fallback that is already proven to work, so the task cannot stall.

**Type consistency.** `slugFromUrl` (Task 1) is used by Tasks 2 and 3. `parseChaptersCount` (Task 2) feeds `volume.chapterCount`, which `getVolumeChapters` (Task 3) reads back to compute its page count — the same field name on both sides. `chapterPageUrl(slug, page)` and `parseChapterRows(doc, slug)` are used only within Task 3. `PER_PAGE = 50` is defined once and used for the page-count derivation only.
