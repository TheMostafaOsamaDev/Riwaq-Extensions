# Sun Novels — `extensions/sunovels`

Site: <https://sunovels.com> (شمس الروايات)

Arabic site hosting translated and original web novels. Unlike its sibling
`extensions/cenele` and `extensions/kolnovel`, this site exposes **no JSON
API** — every `/api/*` path 404s, and its `/dev` route is a changelog, not
documentation. Everything here is scraped from server-rendered HTML.

## Status

All seven `Source` methods are implemented: `canHandle`, `slugFromUrl`,
`getNovel`, `getVolumeChapters`, `getChapterContent`, `getHomeSections` and
`search`.

## Capabilities

| Method                | Supported | Notes |
|-----------------------|-----------|-------|
| `canHandle`           | ✓         | exact hostname-set membership — `sunovels.com`, `www.sunovels.com` |
| `getHomeSections`     | ✓         | scrapes `/` (NOT `/library`) — see below |
| `search`              | ✓         | one request to `/search?title=<query>` — see below |
| `getNovel`            | ✓         | scrapes `/novel/<slug>`; declares `hasLazyVolumes` — see below |
| `getVolumeChapters`   | ✓         | walks the paginated `.chaptersList` tab — see below |
| `getChapterContent`   | ✓         | scrapes `.chapter-content`, filtering a decoy paragraph trap — see below |

## `canHandle`

`canHandle` checks the parsed URL's hostname against an exact `Set`
(`sunovels.com`, `www.sunovels.com`) — not a substring, prefix or suffix
test. That distinction matters here: `"notsunovels.com".includes
("sunovels.com")` and the leading label of `"sunovels.com.evil.com"` are
both `true`, so a naive substring/suffix check would wrongly accept
hostnames that are not this site. `tests/sunovels.test.ts` pins both
near-miss cases (alongside the happy-path novel/chapter URLs and malformed
input) specifically to catch that class of bug; it was tampered against a
substring-check implementation to confirm it goes red.

## URL shape

Novel pages are `/novel/<slug>` and chapter pages are `/novel/<slug>/<n>`.
`slugFromUrl` (exported from `src/index.ts`) extracts `<slug>` from either
shape and throws `SourceUrlError` for any URL that isn't a novel page.

## A trap for later tasks: `.main-head` scoping

A novel page's **first `<h1>` is the site name**, not the novel's title —
observed headings read `h1 -> ["شمس الروايات", "Shadow Slave"]`, `h3 ->
["عبد الظل"]`. An unscoped `querySelector("h1")` would return the site's
own name and title every novel card after the website. Selectors that read
the novel's own headings must stay scoped to `.main-head h1` / `.main-head
h3`.

Also note that on this site `h1` is the **original**-language title and
`h3` is the **Arabic** one — the inverse of `extensions/seanovel`. Do not
carry that assumption across when implementing the novel-page parser.

`getNovel` (this task) implements exactly this: `title` reads `.main-head
h3` (falling back to `h1` when a novel has no Arabic-title element at
all), `originalTitle` reads `.main-head h1` unconditionally. Both are
exported and unit-tested directly as `parseNovelPage`.

## Novel detail: `getNovel`

`getNovel` fetches the novel page and maps `.main-head h1`/`h3` to
`originalTitle`/`title` (see the trap above), `figure.cover img[src]` to
an absolutised `coverUrl`, and every `a.tag` to `tags`. The page never
surfaces an author anywhere in its rendered markup, so `author` is always
`""` — never a literal `"Unknown"`; the host localises the empty case.

If `.main-head` is missing entirely, or is present but yields no title
text at all, `parseNovelPage` throws rather than returning a hollow
`SourceNovel` — a layout change, an anti-bot interstitial, or an error
page served with HTTP 200 must surface as a visible error, not a blank
"this novel has no title" card indistinguishable from a real one.

The site has no volume concept of its own — just one long, paginated
chapter list — so `getNovel` declares `hasLazyVolumes: true` and returns a
single pseudo-volume (`{ id: 1, chapters: [], chapterCount, key: slug }`).
`chapterCount` comes from `parseChaptersCount`, which regexes the page's
inline Next.js RSC payload (`self.__next_f.push(...)`) for
`chaptersCount":<n>` — that field is **not** in the rendered markup, and
it is **not** the novel's highest chapter number: chapter numbering on
this site is sparse (the fixture novels report `chaptersCount: 1582`
while their newest chapter is numbered `1611`). `getVolumeChapters` (see
below) is what actually walks the paginated chapter list; nothing here
may assume `chaptersCount` chapters means chapters `1..count` exist.

## Chapter list: `getVolumeChapters`

The chapter list lives behind a paginated tab —
`/novel/<slug>?activeTab=chapters&page=<n>` — rather than being inlined
in the novel page. Two facts, measured directly against the live site
and scoped to `.chaptersList`, drive the whole implementation:

- **`page` is 0-indexed and serves exactly 50 rows.** `page=0` returns
  chapters 1-50, `page=1` returns 51-100. A 1-indexed guess would
  silently drop the first fifty chapters of every novel.
- **Chapter numbering is sparse** (see the `chaptersCount`-vs-highest-
  number gap above), so the paginated list is the only correct source of
  which chapters exist — nothing may synthesise a list by counting `1`
  through `chaptersCount`.

**The trap:** the page header links the first and newest chapters on
**every single page** — a `nav.header-links` pair plus a `.intro` "last
chapter you read" link, both outside `.chaptersList` entirely. Collecting
chapter anchors from the whole document instead of scoping to
`.chaptersList` would duplicate the first and newest chapters into all
~32 pages of a long novel. `parseChapterRows(doc, slug)` scopes its query
to `.chaptersList` for exactly this reason, and
`tests/sunovels.test.ts` pins it with a fixture-derived check (not just a
row-count bound) that would fail if that scoping were ever dropped.

`getVolumeChapters(novelUrl, volume)` derives the page count from
`volume.chapterCount` (`Math.ceil(count / 50)`, at least 1) rather than a
hardcoded number — this bounds the *over*-counting case only (the real
list may run out before the computed page count is reached; that's fine,
see below). It does not cover *under*-counting: if the site has grown
past what `chapterCount` reported, the loop never attempts the later
pages at all, and nothing signals that either. Pages are fetched
**sequentially** — never concurrently; firing dozens of requests at once
at a third-party site invites rate-limiting for no gain on a list the
user is waiting to scroll — and the loop stops as soon as a page yields
no rows. It also de-duplicates by chapter URL across pages; that de-dup
is real, not theoretical, and is pinned by a test that forces two page
fetches to return genuinely overlapping rows (the two real captured
fixtures happen to be disjoint, so a test built only from them would not
have caught its removal).

**A missing chapter-list container is not the same as an empty one.**
`parseChapterRows` tells the two apart deliberately: `.chaptersList`
*present* but with no matching rows means this page genuinely has no more
chapters (the real end of the list) — return `[]`, and the loop above
stops there, correctly. `.chaptersList` *absent* entirely means the
response isn't a chapter-listing page at all — the same 200-status
"blocked" shape `getNovel`'s own tests exercise for a missing
`.main-head` — and `parseChapterRows` throws, naming the offending page's
URL, instead of returning `[]`. Without this distinction a transient
anti-bot block or CDN hiccup on, say, page 12 of 32 would look
identical to reaching the real end of the list, silently truncating a
1,500+-chapter novel to roughly a third of that with nothing anywhere
saying so.

The slug it builds URLs from comes from `volume.key` — set by `getNovel`
for exactly this call — not by re-deriving it from `novelUrl`, since the
two can diverge (a stale snapshot, a redirect). `slugFromUrl(novelUrl)`
is kept only as a fallback for a volume whose `key` is somehow absent.

## Chapter content: `getChapterContent`

`getChapterContent` fetches the chapter's own URL and reads its body from
`.chapter-content`, mapping each real paragraph to a `SourceLine`.

**The trap:** the site salts every real paragraph in `.chapter-content`
with a matching decoy sibling, `<p class="d-none">` — invisible on the
rendered page (`d-none` is a `display: none` utility class) but sitting
right in the markup, where a naive `querySelectorAll("p")` would collect
it right along with the real text. In the fixture captured for this task
the split was close to 1:1 (94 real paragraphs to 95 decoys), and every
decoy carries real, non-empty text — so an implementation that didn't
filter these out wouldn't add a little noise, it would roughly double the
chapter's line count and interleave garbage into every other line. Every
real paragraph observed so far is a bare `<p>` with no attributes at all,
so `parseChapterLines` tells the two apart with
`classList.contains("d-none")`, no content inspection needed. A handful of
real paragraphs are themselves genuinely empty (`<p></p>`, a blank-line
spacer between scenes); those are dropped the same way a missing
`textContent` would be, so they never surface as visible blank lines.

**Silent emptiness, again:** a missing `.chapter-content` and a present
container that parses to zero real lines (every paragraph a decoy, or the
real ones all empty) are both refused loudly, naming the offending
chapter URL — the same principle `parseNovelPage` and `parseChapterRows`
already apply to their own containers. Either failure mode, left
unguarded, would let the reader render a blank chapter indistinguishable
from the site legitimately having nothing there.

## Home sections: `getHomeSections`

`getHomeSections` scrapes `/` — the actual homepage — **not** `/library`.
This is worth calling out because `/library` is what a naive reading of
"browse novels" would reach for, and it's a real, server-rendered page,
but it has no section concept at all: it's one flat, paginated grid (see
below). The homepage is where the titled `section.home-section` rows
actually live — as of this task: "أشهر الروايات" (most popular), "روايات
إثارة" / "روايات يابانية" / "روايات كورية" (genre/origin rows) and "أحدث
الفصول" (latest chapters).

Each section's title comes from `.section-header h3`, deliberately scoped
rather than a bare `h3` — a card inside "أحدث الفصول" also uses `<h3>` for
its OWN title (see the card trap below), so an unscoped `querySelector
("h3")` would happen to still find the section's own heading first by
document order today, but only by luck. `viewMoreUrl` reads the section
header's own "المزيد" (more) link when it has one; "أحدث الفصول" doesn't,
so its `viewMoreUrl` is `undefined`.

**A card can be split across two anchors.** The "أحدث الفصول" rail wraps
each novel's cover in one bare `<a class="cover" href="/novel/<slug>">`
with no heading inside it at all, immediately followed by a SEPARATE
`<a href="/novel/<slug>">` that wraps only the `<h3>` title. `parseCardAnchor`
returns `null` for an anchor with no heading rather than a title-less
card, so `collectNovelCards` picks up the title from the second anchor
and skips the first — at the cost of that card's `coverUrl` staying
`undefined`, since the real cover lives on the anchor that got skipped.
This is a known, accepted gap for that one rail, not silently dropped:
`extensions/sunovels/tests/sunovels.test.ts` pins the exact behavior.

**Chapter links are excluded by path-segment count, not just a prefix
check.** A card anchor is `/novel/<slug>` (two path segments); a chapter
link is `/novel/<slug>/<n>` (three) and shares the same `/novel/` prefix
— "أحدث الفصول" links each novel's newest chapter right alongside its
novel anchors. `parseCardAnchor` requires exactly two segments so those
chapter links are never mistaken for cards.

**Cover images are lazy-loaded in the rendered DOM of every card grid.**
The static HTML `host.fetch` sees always carries `src="/placeholder.gif"`
for a card's `<img>` — confirmed against the live homepage, `/library`,
and search results alike. A novel's own detail page (`getNovel`,
`figure.cover img`) is NOT lazy this way; only the card grids are.
`parseCardAnchor` treats the literal placeholder the same as "no `<img>`
at all" (`coverUrl: undefined`) rather than shipping every card with the
same generic gif — see "The cover gap, restated honestly" below for what
IS actually available (a real image path per card, just not from the
rendered DOM) and why it isn't extracted here.

**A page with no recognizable sections at all is refused loudly**, naming
the URL — the same "silent emptiness is indistinguishable from the site
having nothing" principle `parseNovelPage`/`parseChapterRows`/
`parseChapterLines` already apply to their own containers.

**A single bad section is logged, not silently dropped.** A section that's
present but has no title, or that parsed to zero cards, is skipped so one
markup change to a single rail doesn't take the rest of the homepage down
— but `parseHomeSections` calls `host.log("warn", ...)` naming which
section was skipped and why (no title vs. zero cards are two different
messages) before moving on. `host` is threaded into `parseHomeSections`
for exactly this — the same shape `extensions/kolnovel`'s own
`parseHomeSections(doc, baseUrl, host)` already takes — since it is
otherwise a pure DOM reader with nothing else to log through.

**View-more links carry a query string on three of the five rails.**
`viewMoreUrl` absolutizes the section header's own "المزيد" link
verbatim, including any `?category=<value>` it carries (`روايات إثارة`
→ `/library?category=إثارة`, etc.) — only "أشهر الروايات" (bare
`/library`) and "أحدث الفصول" (no link at all) are the exceptions.

## Search: `/search?title=<query>`

The brief's own candidate param list — `?q=`, `?query=`, `?s=`, `?term=`
— was tried first, directly against the live site, and **all four**
rendered the identical empty `<ul class="grid-list"></ul>` results shell
regardless of query value. Rather than guess at a fifth name, the live
search FORM was driven directly (typed a query into the input, submitted
it) and the resulting URL read back: `?title=<query>`. That parameter
**does** render real matching novel cards from a plain `host.fetch`, no
client JS required — confirmed against multiple queries, including one
with zero matches (a real, empty `<ul class="grid-list"></ul>`, not an
error).

`search` is therefore a single request: `searchUrl(query)` builds
`/search?title=<query>`, `parseSearchResults` reads
`.searchSection ul.grid-list` the same way every other card grid in this
file is read (`collectNovelCards`, shared with `getHomeSections`). The
results page has **no pagination of its own at all** — no numeric pager
anywhere in the markup, and a live request with `&page=<n>` tacked on
returns byte-identical results — the same shape `extensions/kolnovel`'s
own search hits (every match on one page, no working "load more"), so
`search` ignores any notion of a page argument entirely and hardcodes
`hasMore: false` rather than trusting anything on the page for it. There
is nothing to memoise or walk: each query is one cheap, independent
request, not a multi-page scan — a materially different shape from the
fetch-the-whole-catalogue-once-and-filter-locally fallback this
extension's own earlier fix round had reached for before this endpoint
was found (walking a large paginated listing and caching the merged
result per `Source` instance), which no longer applies once the site's
own search endpoint does the matching server-side.

**An empty query is not the same "refuse loudly" case as a parse
failure.** This extension has settled, across every task so far, on
refusing loudly rather than returning hollow results when a page fails to
parse — but a query that legitimately matches nothing is a real, correct
empty result, and an empty query string is treated the same way:
`{ cards: [], hasMore: false, query: "", page: 1 }`, no request at all.
What DOES still throw is a search-results page whose grid
(`.searchSection ul.grid-list`) is missing entirely — the same "blocked/
errored despite HTTP 200" distinction `parseChapterRows` already draws
for `.chaptersList`. The genuine "nothing matched" shape (grid present,
zero rows — a real, captured query with no results) and the
blocked/malformed shape (grid missing) are structurally different and
both are pinned by fixtures: `tests/fixtures/search-empty.html` is a REAL
capture of the former; the latter is synthesized inline HTML in the test
file, the same way `parseNovelPage`/`parseChapterRows`/
`parseChapterLines`'s own "Access denied" tests already are (an actual
live block isn't reproducible on demand).

### Fixtures

- `tests/fixtures/home.html` — `/`, backs `getHomeSections`. Deliberately
  NOT named `library.html` per the brief's own suggested file list — see
  above for why `/library` doesn't back this method. Committed UNSTRIPPED
  (full `<head>`, every `<script>` tag intact) except for its two ad
  `<iframe>`s — see "happy-dom and fixture fidelity" below for why those
  two, specifically, still had to go.
- `tests/fixtures/search.html` — `/search?title=<query>`, a real query
  with real matches. Backs `search`/`parseSearchResults`. Fully
  unstripped, no exceptions needed (no ad iframes on this page).
- `tests/fixtures/search-empty.html` — `/search?title=<query>` for a query
  that matches nothing; the genuine "no results" shape. Also unstripped.

An earlier fix round on this task fetched, walked, and cached `/library`
(a flat, paginated catalogue) as a fallback data source for `search`; that
whole codepath — `libraryPageUrl`, `parseLibraryPageCount`,
`parseLibraryCards`, the per-instance catalogue memo, and the
`library.html`/`library-empty.html` fixtures backing them — is gone now
that `/search?title=` answers the same need in one request. Nothing in
the current implementation fetches `/library` at all; the site's own
"المزيد" links to it are just URLs this extension builds and hands to the
UI, never followed itself.

### happy-dom and fixture fidelity

A fixture captured straight off a live page is not inert under happy-dom
the way it is in a real browser's `DOMParser`: happy-dom EXECUTES an
inline `<script>` — including this Next.js site's own Suspense-boundary
replacement calls (`$RC(...)`) — the moment it's parsed into a Document,
even a detached one, and that throws because the parsed document has no
`defaultView` for the script to find its own elements against. An earlier
round of this task worked around this by stripping every `<script>` tag
(and emptying `<head>`) out of the committed fixtures — which was the
WRONG fix: it also destroyed the evidence needed to answer the cover-image
question below, and the claim "no parser reads anything out of a
`<script>` tag" it left behind in this README was false — `parseChaptersCount`
(`src/index.ts`) regexes `chaptersCount":` straight out of `novel.html`'s
own inline RSC payload script.

The correct, surgical fix lives in the repo ROOT `vitest.config.ts`:
`environmentOptions.happyDOM.settings.disableJavaScriptEvaluation` (plus
`disableJavaScriptFileLoading`/`disableCSSFileLoading`/
`disableComputedStyleRendering`, and `disableIframePageLoading` for this
extension's two ad iframes specifically — each of those, when disabled,
would otherwise try to dispatch a load-error against the same missing
`defaultView` and throw exactly the way the inline scripts did).
Extensions in this repo only ever READ the parsed tree — nothing here
executes a `<script>`'s contents — so turning evaluation off changes
nothing any extension can observe, and fixtures can now be captured and
committed as genuine, unedited live pages. This is repo-wide (it also
covers `extensions/cenele`'s and `extensions/kolnovel`'s own fixtures);
the full monorepo suite was re-run after this change and nothing moved.

The two ad `<iframe>`s on `home.html` are the one remaining exception:
`disableIframePageLoading` unconditionally calls the same error-dispatch
path regardless of setting value (there is no "handle as success" escape
for iframes the way there is for script/CSS file loading), so it throws
synchronously during parse either way. Those two iframes carry zero
information any parser reads; removing just them (not the scripts around
them) was the narrowest fix available.

### The cover gap, restated honestly

Every card grid this site renders — home sections, `/library`, search
results alike — serves its cover images lazy-loaded: the static markup
`host.fetch` sees always carries `src="/placeholder.gif"` for a card's
`<img>`. An earlier round of this task treated this as settling the
question ("covers only appear once client JS runs") — but that
conclusion rested on fixtures whose RSC payload had just been stripped
out, which is exactly the evidence that would have falsified it.

With unstripped fixtures, the real answer is: **covers ARE present, per
card, in the page's inline RSC payload** — confirmed live on both `/` and
`/search?title=`. A library card's payload entry reads (escaped exactly
as captured):

```
{\"href\":\"/novel/reverend-insanity\",\"children\":[[\"$\",\"$L25\",null,
{\"src\":\"/uploads/thumbnail_Gu_Daoist_Master_328fe7f8b7.jpg\",...}
```

— the real `/uploads/...` path, sitting right next to the same card's
`href` and title, in a fixed, escaped-JSON-ish shape (`\"key\":\"value\"`,
matching Next.js's Flight/RSC wire format). Counts checked directly
against the unstripped fixtures: the homepage's RSC payload carries
exactly as many `href`/`src` pairs as the rendered DOM (111 unique novel
hrefs, 54 real `/uploads/...` paths for the ~52 cards that have one) — no
HIDDEN extra rows beyond what's rendered, so this is not a "cheaper
catalogue" either, just the same data with a real image path instead of
the placeholder.

`collectNovelCards`/`parseCardAnchor` still only read the rendered DOM,
so every card this extension returns — from all five home rails and
every search result — has `coverUrl: undefined` today. That is a real,
sized gap: extracting the cover would mean parsing the RSC payload's own
wire format (matching an anchor's `href` to the nearest `src` in the same
JSON-ish object, not a DOM query) and threading that data into
`collectNovelCards` alongside the parsed document. Not implemented in
this round — flagged here as a scoped follow-up, with the exact shape
above, rather than left as a vague "todo" or, worse, a false claim that
it can't be done.

## Fetch-only, no ambient authority

The only network access anywhere in this extension is via `host.fetch` /
`host.fetchBytes` (once later tasks add calls) — there is no direct
`fetch` and no bundled Node dependency.

## i18n

`src/strings.ts` ships this extension's own fallback strings, keyed off
`host.locale`. `allChapters` titles `getNovel`'s single pseudo-volume in
the UI's current locale (the site has no label of its own to read, since
it has no volume concept at all). More keys will be added as later tasks
need them (e.g. an untitled chapter).
