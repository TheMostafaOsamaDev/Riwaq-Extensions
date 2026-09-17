# Cenele Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the repo a committed way to prove an extension still works against its live site, refresh cenele's fixtures to today's markup, and parse the two homepage sections it currently ignores.

**Architecture:** A `scripts/probe.ts` harness drives any extension against its real site through a network-backed `SourceHost`, so "is this still working?" stops being guesswork. Cenele's parser then gains the two unparsed home sections, pinned by fixtures captured from the live page.

**Tech Stack:** TypeScript, tsx, Vitest + happy-dom, esbuild.

**Spec:** `docs/design.md` (this repo) and `Riwaq-reader/docs/superpowers/specs/2026-09-17-extensions-integration-design.md` §6.

## Global Constraints

- **Worktree:** `/Users/themostafaosama/Desktop/my-work/RiwaqExt-cenele`, branch `fix/cenele-refresh`.
- **No Claude/AI attribution** in any commit message or PR body.
- **Version bump is mandatory.** CI fails any extension whose source changed without a `manifest.json` version bump, compared against the `repo` branch.
- **Bundle ceiling 512 KB.** `scripts/build.ts` enforces it; nothing heavy may be added to an extension.
- **Extensions may only reach the network through `host`.** No direct `fetch`, no Node built-ins in extension source.
- **`API_VERSION` is 1** and must not change — this plan adds no contract surface.

## Findings this plan is built on (verified 2026-09-17)

Recorded because they contradict the original assumption that cenele was broken:

- Driving the repo's current `extensions/cenele` against the live site passes **every** method: `getHomeSections` (2 sections / 15 cards), `search` (12 cards, `hasMore: true`), `getNovel` (full metadata, 11 tags, 6 meta rows), `getVolumeChapters` (600 chapters), `getChapterContent` (215 lines), `searchChapters`.
- **No Cloudflare challenge occurred.** `https://cenele.com/cont/…` returns HTTP 200 with no `cf-mitigated` header, for both a browser UA and the app's own UA. The 2026-08-28 managed challenge is not currently active.
- Challenge handling is therefore **not this extension's job** — it moved into the reader's `host.fetch` (see the reader plan, Tasks 2–3). This extension keeps calling plain `host.fetch`.
- The homepage carries `section.nhv-newseries` and `div.nhv-gems-lb` (a 6-novel leaderboard). The parser handles neither, so real novels never reach the Store.

---

### Task 1: A committed live-probe harness

**Files:**
- Create: `scripts/probe.ts`
- Create: `scripts/probe.config.ts`
- Modify: `package.json` (add the `probe` script)
- Modify: `README.md` (document it under contributor tooling)

**Interfaces:**
- Produces: `pnpm probe <extension-id> [query]`, printing a PASS/FAIL line per `Source` method.

- [ ] **Step 1: Add the probe config**

A separate vitest config so the probe never runs in the real suite — it hits the network and depends on live sites.

```ts
// scripts/probe.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["scripts/probe.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // Live pages carry ad and analytics tags plus the site's own bundles.
    // happy-dom executes inline <script> on insert and that code throws
    // outside a real browser, surfacing as a bogus parse failure.
    // Extensions only ever READ the parsed tree — cenele reads nhvNovelV2
    // out of a script's textContent, it never runs it — so turning
    // evaluation off changes nothing an extension can observe.
    environmentOptions: {
      happyDOM: {
        settings: {
          disableJavaScriptEvaluation: true,
          disableJavaScriptFileLoading: true,
          disableCSSFileLoading: true,
          disableComputedStyleRendering: true,
        },
      },
    },
  },
  resolve: {
    alias: {
      "@riwaq/extension-api/testing": new URL("../packages/extension-api/src/testing.ts", import.meta.url).pathname,
      "@riwaq/extension-api": new URL("../packages/extension-api/src/index.ts", import.meta.url).pathname,
    },
  },
});
```

- [ ] **Step 2: Write the harness**

```ts
// scripts/probe.ts
//
// Drives a real extension against its live site through a network-backed
// SourceHost, so "does this extension still work?" is answered by the site
// rather than by saved fixtures. Fixtures catch a parser regression; only
// this catches the site changing underneath us.
//
//   pnpm probe cenele
//   pnpm probe cenele "سيد"
//
// Transport is curl rather than global fetch: under happy-dom (which the
// extensions need for DOMParser) `fetch` is happy-dom's own CORS-enforcing
// implementation and refuses every cross-origin read. curl also gives real
// cookie-jar semantics via -b/-c, which is exactly what SourceHost.fetch
// promises — cenele's WordPress nonces are session-scoped and break
// without it.
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { it } from "vitest";
import type { FetchResponse, Source, SourceHost } from "@riwaq/extension-api";

const execFileAsync = promisify(execFile);
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const JAR = join(mkdtempSync(join(tmpdir(), "riwaq-probe-")), "cookies.txt");

async function curl(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } | undefined) {
  const args = [
    "-sS", "--compressed", "--max-time", "60", "-L",
    "-b", JAR, "-c", JAR,
    "-A", UA,
    "-H", "Accept-Language: ar,en;q=0.8",
    "-D", "/dev/stderr",
    "-X", opts?.method ?? "GET",
  ];
  for (const [k, v] of Object.entries(opts?.headers ?? {})) args.push("-H", `${k}: ${v}`);
  if (opts?.body !== undefined) args.push("--data-raw", String(opts.body));
  args.push(url);

  const { stdout, stderr } = await execFileAsync("curl", args, {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });

  // -D writes one header block per redirect hop; the last one is the
  // response we actually got.
  const blocks = stderr.toString("utf8").split(/\r?\n\r?\n/).filter((b) => b.trim());
  const lines = (blocks.at(-1) ?? "").split(/\r?\n/);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return {
    status: Number(lines[0]?.match(/HTTP\/[\d.]+\s+(\d+)/)?.[1] ?? 0),
    headers,
    body: stdout as unknown as Buffer,
  };
}

const host: SourceHost = {
  locale: "ar",
  async fetch(url, opts): Promise<FetchResponse> {
    const r = await curl(url, opts);
    return { status: r.status, text: r.body.toString("utf8"), headers: r.headers };
  },
  async fetchBytes(url, opts) {
    return new Uint8Array((await curl(url, opts)).body);
  },
  async renderAndExtract() {
    throw new Error("renderAndExtract is not wired in the probe — prefer static fetch");
  },
  log(level, msg) {
    if (level === "error" || level === "warn") console.log(`  [${level}] ${msg}`);
  },
  pdf: {
    async extractChapter() {
      throw new Error("pdf.extractChapter is not wired in the probe");
    },
  },
};

const pass = (l: string, d: string) => console.log(`  PASS  ${l} — ${d}`);
const fail = (l: string, e: unknown) =>
  console.log(`  FAIL  ${l} — ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`);

const ID = process.env.PROBE_ID ?? "cenele";
const QUERY = process.env.PROBE_QUERY ?? "سيد";

it(`probes ${ID} against its live site`, { timeout: 300_000 }, async () => {
  const mod = await import(`../extensions/${ID}/src/index.ts`);
  const source: Source = mod.default(host);
  console.log(`\n=== ${ID} — live probe ===`);

  let novelUrl = "";
  try {
    const sections = await source.getHomeSections();
    pass("getHomeSections", `${sections.length} sections, ${sections.reduce((n, s) => n + s.cards.length, 0)} cards`);
    for (const s of sections) console.log(`        · ${s.title} (${s.cards.length})`);
    novelUrl = sections.flatMap((s) => s.cards)[0]?.url ?? "";
  } catch (e) {
    fail("getHomeSections", e);
  }

  try {
    const r = await source.search(QUERY, 1);
    pass("search", `${r.cards.length} cards, hasMore=${r.hasMore}`);
    if (!novelUrl) novelUrl = r.cards[0]?.url ?? "";
  } catch (e) {
    fail("search", e);
  }

  if (!novelUrl) return console.log("  SKIP  getNovel — no novel URL discovered");
  console.log(`  ----  novel: ${novelUrl}`);

  let novel: Awaited<ReturnType<Source["getNovel"]>>;
  try {
    novel = await source.getNovel(novelUrl);
    pass(
      "getNovel",
      `"${novel.title}" author="${novel.author}" vols=${novel.volumes.length} ` +
        `tags=${novel.tags.length} meta=${novel.meta.length} cover=${novel.coverUrl ? "yes" : "no"}`,
    );
  } catch (e) {
    return fail("getNovel", e);
  }

  let chapter = novel.volumes.flatMap((v) => v.chapters)[0];
  if (!chapter && source.getVolumeChapters) {
    try {
      const ch = await source.getVolumeChapters(novelUrl, novel.volumes[0]);
      pass("getVolumeChapters", `${ch.length} chapters`);
      chapter = ch[0];
    } catch (e) {
      fail("getVolumeChapters", e);
    }
  }
  if (!chapter) return console.log("  SKIP  getChapterContent — no chapter available");

  try {
    const lines = await source.getChapterContent(chapter);
    const text = lines.filter((l) => l.type === "text");
    pass("getChapterContent", `${lines.length} lines, ${text.reduce((n, l) => n + l.content.length, 0)} chars`);
  } catch (e) {
    fail("getChapterContent", e);
  }
});
```

- [ ] **Step 3: Add the script**

```json
"probe": "PROBE_ID=$npm_config_id vitest run --config scripts/probe.config.ts"
```

Simpler and shell-portable, add instead:

```json
"probe": "vitest run --config scripts/probe.config.ts"
```

and document invocation as `PROBE_ID=cenele pnpm probe`.

- [ ] **Step 4: Run it**

Run: `PROBE_ID=cenele pnpm probe`
Expected: PASS on every method (this is the baseline recorded above).

- [ ] **Step 5: Confirm the probe is excluded from the real suite**

Run: `pnpm test`
Expected: the same 143 tests as before — `scripts/probe.ts` must NOT appear. If it does, its filename matches `scripts/**/*.test.ts`; it does not, but confirm rather than assume.

- [ ] **Step 6: Commit**

```bash
git add scripts/probe.ts scripts/probe.config.ts package.json README.md
git commit -m "feat(tooling): probe an extension against its live site

Fixtures catch a parser regression; only a live run catches the site
changing underneath us. The harness drives any extension through a
network-backed SourceHost and prints a PASS/FAIL line per method.

Transport is curl because under happy-dom the global fetch is happy-dom's
own CORS-enforcing one and refuses every cross-origin read; curl's -b/-c
also gives the cookie-jar semantics SourceHost.fetch promises, which
cenele's session-scoped nonces depend on."
```

---

### Task 2: Parse the two ignored home sections

`getHomeSections` returns 2 sections today. The page also carries `section.nhv-newseries` and `div.nhv-gems-lb`, each listing real novels that never reach the Store.

**Files:**
- Modify: `extensions/cenele/src/index.ts` (the home-section parser, ~line 768)
- Modify: `extensions/cenele/tests/fixtures/home.html` (recapture)
- Modify: `extensions/cenele/tests/cenele.test.ts`
- Modify: `extensions/cenele/src/strings.ts` (fallback headings, if either section lacks one)

**Interfaces:**
- Consumes: the existing `parseHomeSections(doc: Document): SourceSection[]`.
- Produces: the same signature, now emitting up to 4 sections with stable ids `popular`, `newreleases`, `newseries`, `gems`.

- [ ] **Step 1: Recapture the home fixture from the live page**

```bash
curl -sS --compressed -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" \
  https://cenele.com/ -o extensions/cenele/tests/fixtures/home.html
```

Confirm it contains both new sections:

```bash
grep -c 'nhv-newseries\|nhv-gems-lb' extensions/cenele/tests/fixtures/home.html
```

- [ ] **Step 2: Write the failing tests**

```ts
// in extensions/cenele/tests/cenele.test.ts
it("parses the new-series slider as its own section", () => {
  const sections = parseHomeSections(parseHtml(homeFixture));
  const newseries = sections.find((s) => s.id === "newseries");
  expect(newseries).toBeDefined();
  expect(newseries!.cards.length).toBeGreaterThan(0);
  for (const card of newseries!.cards) {
    expect(card.url).toMatch(/^https:\/\/cenele\.com\/cont\//);
    expect(card.title).not.toBe("");
  }
});

it("parses the gems leaderboard as its own section", () => {
  const sections = parseHomeSections(parseHtml(homeFixture));
  const gems = sections.find((s) => s.id === "gems");
  expect(gems).toBeDefined();
  // The live board lists six ranked novels.
  expect(gems!.cards).toHaveLength(6);
  expect(gems!.cards[0].url).toMatch(/^https:\/\/cenele\.com\/cont\//);
});

it("never emits a section with zero cards", () => {
  // An empty section renders as a bare heading over blank space in the
  // Store, which reads as a bug rather than as "nothing here today".
  for (const s of parseHomeSections(parseHtml(homeFixture))) {
    expect(s.cards.length).toBeGreaterThan(0);
  }
});
```

- [ ] **Step 3: Run and watch them fail**

Run: `pnpm vitest run extensions/cenele`
Expected: the two new tests FAIL (`newseries` / `gems` undefined).

- [ ] **Step 4: Implement both parsers**

Extend the branch at `index.ts:768`. Cards come from anchors whose `href` is a `/cont/` URL, with the cover from the nearest `img` — the same shape the existing branches use:

```ts
} else if (sec.classList.contains("nhv-newseries")) {
  cards = parseSliderCards(sec);
  id = "newseries";
  title = heading || strings(host.locale)("sectionNewSeries");
} else if (sec.classList.contains("nhv-gems-lb")) {
  cards = parseGemsRows(sec);
  id = "gems";
  title = heading || strings(host.locale)("sectionGems");
}
```

```ts
/** The gems leaderboard: ranked rows, each an anchor to a /cont/ novel
 *  with its cover in `.nhv-gems-lb__novel-cover`. Rank and gem count are
 *  deliberately dropped — NovelCard has no field for either, and folding
 *  them into the subtitle would put a number where a translated title
 *  belongs. */
function parseGemsRows(sec: Element): NovelCard[] {
  const out: NovelCard[] = [];
  for (const row of Array.from(sec.querySelectorAll(".nhv-gems-lb__row--novel"))) {
    const link = row.querySelector('a[href*="/cont/"]') as HTMLAnchorElement | null;
    const href = link?.getAttribute("href");
    if (!href) continue;
    const title = sanitizeText(
      row.querySelector(".nhv-gems-lb__identity")?.textContent ?? link.textContent,
    );
    if (!title) continue;
    const img = row.querySelector(".nhv-gems-lb__novel-cover img") as HTMLImageElement | null;
    out.push({
      url: absoluteUrl(href, BASE_URL),
      title,
      coverUrl: coverFrom(img),
    });
  }
  return out;
}
```

Reuse the module's existing cover helper (the one the other branches use for `img.nhv-prog-img`, which reads `data-src` before `src` for lazy images) rather than adding a second one.

- [ ] **Step 5: Run and confirm PASS**

Run: `pnpm vitest run extensions/cenele`
Expected: all cenele tests PASS, count up by 3.

- [ ] **Step 6: Tamper-check**

Make `parseGemsRows` return `[]`. The gems test AND the "never emits a section with zero cards" test must both fail (the latter only if the empty section is still emitted — if it is correctly filtered out, only the gems test fails, which is also correct). Restore.

- [ ] **Step 7: Confirm against the live site**

Run: `PROBE_ID=cenele pnpm probe`
Expected: `getHomeSections` now reports 4 sections rather than 2.

- [ ] **Step 8: Bump the version and commit**

`extensions/cenele/manifest.json`: `"version": "1.1.0"` — a new capability, so minor.

```bash
git add extensions/cenele/src/index.ts extensions/cenele/src/strings.ts \
        extensions/cenele/tests/cenele.test.ts extensions/cenele/tests/fixtures/home.html \
        extensions/cenele/manifest.json
git commit -m "feat(cenele): parse the new-series and gems home sections

Both list real novels and neither was parsed, so they never reached the
Store — the homepage returned 2 sections where the site shows 4. Rank and
gem count are dropped rather than folded into the subtitle, which is
where a translated title belongs.

Home fixture recaptured from the live page so the new markup is pinned."
```

---

### Task 3: Refresh the remaining fixtures and document the site

**Files:**
- Modify: `extensions/cenele/tests/fixtures/novel.html`, `search.html`, `chapter.html`
- Modify: `extensions/cenele/README.md`

- [ ] **Step 1: Recapture the three remaining fixtures**

```bash
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
D=extensions/cenele/tests/fixtures
curl -sS --compressed -A "$UA" "https://cenele.com/cont/create-heaven-riwya/" -o $D/novel.html
curl -sS --compressed -A "$UA" "https://cenele.com/?s=%D8%B3%D9%8A%D8%AF&post_type=wp-manga" -o $D/search.html
curl -sS --compressed -A "$UA" "https://cenele.com/cont/create-heaven-riwya/%d8%a7%d9%84%d9%81%d8%b5%d9%84-1/" -o $D/chapter.html
```

- [ ] **Step 2: Run the suite against the fresh fixtures**

Run: `pnpm test`
Expected: PASS. **Any failure here is a real regression the old fixtures were hiding** — fix the parser, not the fixture.

- [ ] **Step 3: Confirm the decoy filter still bites**

The chapter fixture must still contain decoy paragraphs, or the filter's tests pass vacuously. Check:

```bash
grep -c "مسروقة" extensions/cenele/tests/fixtures/chapter.html
```

If zero, the site stopped emitting decoys in that chapter — capture a different chapter that still has them rather than deleting the tests, and note it in the README.

- [ ] **Step 4: Update the README**

Record, with today's date: the four home sections and their selectors; that chapter/novel pages are **not** currently behind a Cloudflare challenge, and that challenge handling belongs to the host's `fetch`, not this extension; and that `pnpm probe` is how to re-check the site.

- [ ] **Step 5: Commit**

```bash
git add extensions/cenele/tests/fixtures extensions/cenele/README.md
git commit -m "test(cenele): recapture fixtures from the live site

Pins today's markup for the novel page, search results and a chapter
body. Documents that /cont/ pages are not currently challenged and that
challenge handling is the host's job, so the next person does not
re-add a session transport the extension no longer needs."
```

---

### Task 4: Verify and open the PR

- [ ] **Step 1: Full gate**

Run: `pnpm validate && pnpm typecheck && pnpm test && pnpm build`
Expected: all pass; `dist/index.min.json` lists cenele at `1.1.0`.

- [ ] **Step 2: Confirm the version-bump gate is satisfied**

Run: `pnpm exec tsx scripts/check-version-bump.ts`
Expected: pass — cenele's source changed and its version moved.

- [ ] **Step 3: Live re-probe**

Run: `PROBE_ID=cenele pnpm probe`
Expected: PASS on every method, 4 home sections.

- [ ] **Step 4: Open the PR** — no Claude/AI attribution in title or body. State plainly that cenele was found working and what actually changed.

---

## Self-Review

**Spec coverage.** Spec §6 "cenele — refresh" listed porting `nhvNovelV2`, the `.nhv-novel-*` metadata and the search page. Verification showed **the repo already has all three** — the diff against the reader's copy is Biome formatting and import renames. The spec's remaining cenele item, dropping `sessionFetch` for plain `fetch`, is already true here and is handled host-side by the reader plan. What was left is the unparsed home sections plus fixture rot, which is what this plan does, plus the probe harness that made the finding possible.

**Placeholder scan.** No TBD/TODO. Task 2 Step 4 shows the gems parser in full and points at the existing cover helper by behaviour rather than restating it, so the two cannot drift.

**Type consistency.** `parseHomeSections(doc: Document): SourceSection[]` keeps its signature. `parseGemsRows` and `parseSliderCards` both return `NovelCard[]`, matching `SourceSection.cards`. Section ids `popular`/`newreleases`/`newseries`/`gems` are used identically in the parser and the tests.
