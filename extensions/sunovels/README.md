# Sun Novels — `extensions/sunovels`

Site: <https://sunovels.com> (شمس الروايات)

Arabic site hosting translated and original web novels. Unlike its sibling
`extensions/cenele` and `extensions/kolnovel`, this site exposes **no JSON
API** — every `/api/*` path 404s, and its `/dev` route is a changelog, not
documentation. Everything here is scraped from server-rendered HTML.

## Status

`canHandle`, `slugFromUrl`, `getNovel`, `getVolumeChapters` and
`getChapterContent` are implemented. `getHomeSections` and `search` still
throw `"not implemented"` and will be filled in by later tasks against
fixture HTML captured from the live site.

## Capabilities

| Method                | Supported | Notes |
|-----------------------|-----------|-------|
| `canHandle`           | ✓         | exact hostname-set membership — `sunovels.com`, `www.sunovels.com` |
| `getHomeSections`     | —         | not implemented yet |
| `search`              | —         | not implemented yet |
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
