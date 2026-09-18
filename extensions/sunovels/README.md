# Sun Novels — `extensions/sunovels`

Site: <https://sunovels.com> (شمس الروايات)

Arabic site hosting translated and original web novels. Unlike its sibling
`extensions/cenele` and `extensions/kolnovel`, this site exposes **no JSON
API** — every `/api/*` path 404s, and its `/dev` route is a changelog, not
documentation. Everything here is scraped from server-rendered HTML.

## Status

`canHandle`, `slugFromUrl` and `getNovel` are implemented. `getHomeSections`,
`search` and `getChapterContent` still throw `"not implemented"` and will
be filled in by later tasks against fixture HTML captured from the live
site.

## Capabilities

| Method                | Supported | Notes |
|-----------------------|-----------|-------|
| `canHandle`           | ✓         | exact hostname-set membership — `sunovels.com`, `www.sunovels.com` |
| `getHomeSections`     | —         | not implemented yet |
| `search`              | —         | not implemented yet |
| `getNovel`            | ✓         | scrapes `/novel/<slug>`; declares `hasLazyVolumes` — see below |
| `getChapterContent`   | —         | not implemented yet |

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
this site is sparse (the fixture novel reports `chaptersCount: 1582`
while its newest chapter is numbered `1611`). Task 3's `getVolumeChapters`
is what actually walks the paginated chapter list; nothing here may
assume `chaptersCount` chapters means chapters `1..count` exist.

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
