# Cenele — `extensions/cenele`

Site: <https://cenele.com> (فضاء الروايات)

Theme: Madara WordPress theme with a custom **novelhub** child theme.
The novelhub child theme replaces the chapter listing with a JS-driven
accordion that loads each volume over AJAX. Search runs through the
site's normal WordPress results page — not a live-suggest dropdown; per
the host contract this extension has one search interaction: type,
Enter, results grid.

## Capabilities

| Method                | Supported | Endpoint |
|-----------------------|-----------|----------|
| `getHomeSections`     | ✓         | GET `/` — parse `section.nhv-section` and `section.nhv-gems-lb` blocks |
| `search`              | ✓         | GET `/?s=<q>&post_type=wp-manga` (page 1) or `/page/<N>/?s=<q>&post_type=wp-manga` (page N>1) — 12 results/page; `hasMore` from `.nav-links .nav-previous a` |
| `getNovel`            | ✓ + AJAX  | GET `/cont/<slug>/` + POST admin-ajax `nhv_manga_single_chapters_page` per volume |
| `searchChapters`      | ✓         | POST admin-ajax `nhv_search_manga_chapters` |
| `getChapterContent`   | ✓         | static GET; decoys stripped |

## Live-site status (checked 2026-09-18)

- **No Cloudflare challenge on `/cont/` today.** The host is fronted by
  Cloudflare (`server: cloudflare`, `cf-ray` on every response), but a plain
  GET to a `/cont/<slug>/` novel or chapter page — no cookies, no prior
  visit — returns the real page directly (`HTTP/2 200`, real HTML, no
  "Just a moment…" interstitial). Cloudflare challenge handling, if the site
  ever turns it on for these paths, is the **host's** `fetch` implementation's
  job (session cookies, JS-challenge solving, etc.), not this extension's —
  **don't re-add a session/cookie-jar transport here** on the strength of an
  old incident; check the live site first (see the probe command below).
  `scripts/probe.ts`'s own transport already does carry a per-run cookie jar
  for the AJAX endpoints' nonces, which is unrelated to Cloudflare.
- **Re-check anytime with the live probe:** `PROBE_ID=cenele pnpm probe`
  drives the real extension against the real site end to end
  (`getHomeSections` → `search` → `getNovel` → `getVolumeChapters` →
  `getChapterContent` → `searchChapters`) and exits non-zero if any method
  fails. Prefer it over re-reading this file when in doubt — a live status
  note is a photograph, not a promise.
- **Home sections actually live on this date** (see the "Homepage section
  shapes" table below for selectors): the gems leaderboard ("لوحة الجواهر",
  6 cards), the new-series slider ("الأكثر شهرة حاليا", 5 cards) and new
  releases ("إصدارات جديدة", 10 cards). `nhv-popular` and `nhv-manual`
  are coded and unit-tested but rendered zero cards on this date's homepage
  and so were silently dropped by `parseHomeSections`' empty-section filter
  — not a bug, just nothing currently populating those two slots.

## Search

Page 1 is `GET https://cenele.com/?s=<q>&post_type=wp-manga`; page N>1
takes a `/page/<N>/` prefix in front of the same query string
(`searchUrl` in `src/index.ts`). The site returns 12 results per page.
`parseSearchPage` reads each `.row.c-tabs-item__content` row for its
title, cover, original-title subtitle ("رواية …") and genre badges, and
derives `hasMore` from the presence of `.nav-links .nav-previous a` — the
theme is RTL, so the "previous" slot holds the *older* (i.e. next) page
link, and there is no numeric pager on this template.

## AJAX endpoints

All three custom endpoints live under `wp-admin/admin-ajax.php` and
follow the WordPress AJAX convention:

```
POST /wp-admin/admin-ajax.php
Content-Type: application/x-www-form-urlencoded
action=<NAME>&nonce=<NONCE>&… other args
```

### `nhv_manga_single_chapters_page`

POST. Two modes:

**Meta-only** — discover the volume list of a novel:

```
action=nhv_manga_single_chapters_page
nonce=<CHAPTERS_NONCE>
manga_id=<POST_ID>
meta_only=1
→ { success: true, volumes: [{num, label, count}, …], mixed: bool }
```

**Volume page** — fetch one paginated slice of one volume's chapters:

```
action=nhv_manga_single_chapters_page
nonce=<CHAPTERS_NONCE>
manga_id=<POST_ID>
volume=<INT>     # 0 means "no volume"
page=<INT>       # 1-based
per_page=50
→ { success: true, html: "<li data-chapter-id=… ><a href=… >TITLE</a>…</li> …",
    page, per_page, has_more, total, volumes, mixed }
```

The HTML response is a sequence of `<li>` blocks; we parse them with
`parseHtml` into `SourceChapter[]`. `getNovel` paginates per volume
until `has_more === false`.

### `nhv_search_manga_chapters`

POST. In-novel chapter search — drives a chapter-search input a host UI
may show above the volumes accordion (see `Source.searchChapters` in
`@riwaq/extension-api`).

```
action=nhv_search_manga_chapters
nonce=<CHAPTERS_NONCE>           # same nonce as the chapters endpoint
manga_id=<POST_ID>
query=<TEXT>
limit=80
→ { success: true, items: [{id, title, title_html, url, time}, …],
    html: "<li>…</li>…" }
```

We use `items` (the structured array) rather than `html`.

## Nonces

WordPress generates per-session, per-action nonces. They are embedded
in inline scripts on every page render.

The novel page exposes `var nhvNovelV2 = {ajaxurl:"…", nonce:"<HEX>",
postId:"<INT>", chaptersNonce:"<HEX>", …}`. This replaced the older
`nhvMangaSingleAjax` config when the site redesigned its novel page —
the `extractNovelConfig` doc comment in `src/index.ts` points here by
name, so keep this table in sync with that function. A stale version of
this contract (still describing `nhvMangaSingleAjax`) is exactly what
broke chapter fetching before this extension was repaired against the
live site.

| Field                      | Belongs to | Used for |
|----------------------------|------------|----------|
| `nhvNovelV2.chaptersNonce` | `nhv_manga_single_chapters_page` and `nhv_search_manga_chapters` (they share it) | sent as `nonce` on both chapter actions |
| `nhvNovelV2.postId`        | same two actions | sent as `manga_id` |
| `nhvNovelV2.nonce`         | `nhv_novel_v2_section` (tab-content action) | **not used by this extension** — a different nonce; never send it as `chaptersNonce` |

We cache `postId` and `chaptersNonce` inside the per-novel cache built
during `getNovel`; `extractNovelConfig` re-derives both from the novel
page on a cache miss (e.g. `getVolumeChapters` called after a host
restart, before `getNovel` has re-run for this session).

## Homepage section shapes

Five section variants `parseHomeSections` knows how to read. Four are
`<section class="nhv-section nhv-X">` with a heading at
`<h3 class="nhv-title">…</h3>`; the gems leaderboard is a bare
`<section class="nhv-gems-lb">` outside that family, with its own `<h2>`
heading instead. `SourceSection.id` is the class name below (stable across
runs — see the "stabilize home-section ids" note in git history), not a
document-order index.

| Class             | Id            | Cards under                    | Notes | Live 2026-09-18? |
|-------------------|---------------|---------------------------------|-------|-------------------|
| `nhv-popular`     | `popular`     | `a.nhv-pitem`                   | views-count `.nhv-badge`, title `.nhv-ptitle` | no (0 cards that day) |
| `nhv-newseries`   | `newseries`   | `article.nhv-feature`           | longer cards with description + chips; captioned "الأكثر شهرة حاليا" on the live page today | **yes** (5 cards) |
| `nhv-manual`      | `manual`      | `.nhv-manual__capsule`          | author-picks capsules — no description | no (0 cards that day) |
| `nhv-newreleases` | `newreleases` | `article.nhv-nrRow`             | latest-chapter rows; subtitle is the latest chapter; captioned "إصدارات جديدة" | **yes** (10 cards) |
| `nhv-gems-lb`     | `gems`        | `.nhv-gems-lb__row--novel`      | ranked leaderboard; cover class sits on the `<img>` itself, not a wrapper; rank/gem-count are deliberately dropped (no `NovelCard` field fits); captioned "لوحة الجواهر" | **yes** (6 cards) |

Other `nhv-section` variants (theme A/B tests, ad blocks) get skipped
silently — `parseHomeSections` filters anything that returns no cards, which
is also why `popular`/`manual` didn't show up in the 2026-09-18 live check
above even though the parser for them is live and unit-tested. Re-run
`PROBE_ID=cenele pnpm probe` to see what's live today.

## Novel-page selectors

The site redesigned its novel-page markup; these are the current
selectors (see `parseNovelPage` in `src/index.ts`).

| Field           | Selector |
|-----------------|----------|
| Title           | `.nhv-novel-title` |
| Original title  | `.nhv-novel-kicker`, stripped of its leading "رواية " prefix |
| Cover image     | `.nhv-novel-cover img` |
| Genres          | `.nhv-novel-genres a` |
| Tags            | `.nhv-novel-tags a` (genres + tags are flattened into one `tags` array — a host UI is expected to treat both the same way) |
| Status          | `.nhv-novel-status strong` |
| Meta rows       | `.nhv-novel-meta > div`, each `<div><span>label</span><strong>value</strong></div>` |
| Author          | meta row labeled `مؤلف` / `كاتب` / `author` / `writer` |
| Synopsis        | `.nhv-novel-synopsis` — only its `<p>` children; the container also holds `<h2>` title-repeat boilerplate (the live fixture ships two — an Arabic one before the paragraphs, an English one after; older captures saw a trailing `<h3>` of promo copy instead) that must not leak into the description |
| Volume shells   | none — the redesigned page ships no volume markup; `extractVolumeShells` always returns `[]` and `getNovel` gets the canonical volume list from the `meta_only=1` AJAX call instead |
| Manga config    | inline `var nhvNovelV2 = {…}` (regex-extracted) — see Nonces above |

## Chapter-body decoy stripping

Chapter pages mix legitimate paragraphs with anti-piracy decoys
hidden by inline CSS. Detection markers used by `isDecoyElement`:

- `aria-hidden="true"` — definitive
- `data-nosnippet="true"` — definitive
- `role="presentation"` — definitive
- inline `style="position:absolute;…"` plus any of: `opacity:0`,
  `width:0`, `width:1px`, `height:0`, `height:1px`,
  `transform:scale(0.0…)`, `filter:blur`, `pointer-events:none`
- `translate="no"` **plus** one of the style markers above
  (`translate="no"` is legitimate on real text in other contexts;
  paired with the style it's a decoy)

We `.remove()` matching elements before walking paragraphs, so a real
`<p>` containing a nested decoy `<span>` is preserved with its real
text intact.

`looksLikePiracyDecoy` is a final-line keyword check for paragraphs
that slip past the structural filter. It matches on a site-name keyword
paired with one of the boilerplate verbs ("مسروقة" or, in the current
wording, "يسرق"), a combination unique enough to never hit real content.

**It matches against `normalizeDecoyText(text)`, never the raw string,
and that is not optional.** The decoys are obfuscated at the character
level three different ways at once — Arabic presentation forms in place
of the ordinary letters, tatweel (U+0640) between letters, and
zero-width/bidi controls — and for a long time this check normalized
only the third of those, which made it match nothing the live site
emitted. `normalizeDecoyText` applies `NFKC` (which also decomposes the
`لا` presentation ligature), then strips tatweel, then strips the
zero-width class. If the keyword list is ever extended, spell the new
keyword the ordinary way and let the normalizer do the work — do not
try to write the obfuscated form out.

Two independent live-site runs back these numbers — neither figure below
is invented, and each is attributed to where it was recorded:

- A sample run against `chapter-0-0` (the chapter flagged as "chapters
  with tricks") pruned 174 decoy elements and surfaced 52 clean text
  lines — recorded in Riwaq-reader's `docs/store-feature/cenele.md`,
  the doc this README was ported from.
- A separate live-site investigation on 2026-08-27, recorded in this
  repo's `docs/design.md` ("Field findings — 2026-08-27" → cenele.com),
  re-ran the decoy filter against a live chapter and found 15 decoy
  elements stripped and 65 clean paragraphs kept, with no boilerplate
  survivors.
- `tests/fixtures/chapter.html` is a third, currently-committed data
  point (chapter 1 of `create-heaven-riwya`, captured 2026-09-18): 20
  elements match `isDecoyElement` (5 `aria-hidden`, 15 `data-nosnippet`),
  but — unlike the two runs above — **none of them sit inside or replace a
  `<p>`.** All 217 `<p>` elements in this chapter are real prose; the
  theme now renders every decoy as a `<section>`/`<span>` *sibling*
  dropped between paragraphs, never nested inside one and never a `<p>`
  itself. Sampled across 11 chapters from 2 different novels during this
  refresh, every single one showed the same shape (0 whole-`<p>` decoys,
  0 decoys nested inside a real `<p>`, 100% of matches sitting as
  siblings). `extractChapterLines` only ever reads `p, img`, so on
  content shaped like this, removing these siblings or not makes **no
  difference to the extracted lines** — the structural filter still runs
  (defense-in-depth, and correct behavior if the theme reverts to nesting
  decoys again, which is exactly what the two runs above show it used to
  do), but no chapter captured during this refresh actually depends on it.

**The live decoy wording changed since the two runs above, too.** As of
2026-09-18, the boilerplate text switched from the literal word "مسروقة"
("stolen") to "يـسـرـق" ("steals"), and it is now *always*
tatweel-obfuscated (a `ـ` character inserted between every letter, not the
zero-width joiners `looksLikePiracyDecoy`'s own comment describes) — e.g.
`هـٰـذَا اﻟـتـطـبـيـق يـسـرـق مِـن مـوـقـع وـتـطـبـيـق فــضـاـء
اﻟـرـوـاـيـاـت`. No unhidden decoy paragraph turned up in any of the 11
chapters sampled, so `looksLikePiracyDecoy` never actually fires against
live content in the extraction path right now — it's kept as
defense-in-depth for a decoy that
slips past the structural filter (its own dedicated unit tests still
exercise it directly), and `extractChapterLines`'s test file keeps a
synthetic snippet exercising that whole integration path (nested decoy,
whole-`<p>` decoy, and the keyword net) so none of it goes untested just
because the live site doesn't happen to need it at the moment. If a future
re-check finds unhidden "مسروقة" decoys again, or finds "يسرق" ones
slipping past the structural filter, extend the keyword regex rather than
assuming the old one still matches what ships. The test suite pins the
net against the capture's own decoy string (see `liveDecoyText` in
`tests/cenele.test.ts`) precisely so "the keywords no longer match what
ships" fails loudly instead of passing silently.

**Dedup is adjacency-only, not whole-chapter.** `extractChapterLines` used
to dedup repeated text/images against every line seen anywhere earlier in
the chapter. The 2026-09-18 `create-heaven-riwya` chapter-1 capture
surfaced a real bug from that: it contains three separate, unrelated
one-word paragraphs that are all exactly "لكن…" ("But…"), and the old
whole-chapter dedup collapsed all three into one, silently dropping two
real lines from an imported book. It now only dedups a line against the
one immediately before it — enough to catch the site's actual failure mode
(the same `<p>`/`<img>` rendered twice in a row, a copy-paste artifact in
its markup) without discarding a legitimate repeated beat that isn't
adjacent. See `extractChapterLines`'s own comment and its test file's
adjacent-vs-non-adjacent cases.

## URL handling

Cenele uses Arabic in path segments — percent-encoded when emitted
from AJAX and the volume HTML. `host.fetch` is expected to pass the URL
through to the underlying HTTP client unmodified so the encoding is
preserved. We pass URLs through `absoluteUrl(href, base)` (from
`@riwaq/extension-api`) to normalize, but **don't** decode the path —
the server expects the encoded form.

## Fetch-only

Cenele only uses `host.fetch` — no `host.renderAndExtract` — so it has
no headless-render dependency and works on any host that implements the
static-fetch capability.
