# Sun Novels — `extensions/sunovels`

Site: <https://sunovels.com> (شمس الروايات)

Arabic site hosting translated and original web novels. Unlike its sibling
`extensions/cenele` and `extensions/kolnovel`, this site exposes **no JSON
API** — every `/api/*` path 404s, and its `/dev` route is a changelog, not
documentation. Everything here is scraped from server-rendered HTML.

## Status

This is the scaffold task. Only `canHandle` and the `slugFromUrl` helper
are implemented; every other `Source` method (`getHomeSections`, `search`,
`getNovel`, `getChapterContent`) still throws `"not implemented"` and will
be filled in by later tasks against fixture HTML captured from the live
site.

## Capabilities

| Method                | Supported | Notes |
|-----------------------|-----------|-------|
| `canHandle`           | ✓         | exact hostname-set membership — `sunovels.com`, `www.sunovels.com` |
| `getHomeSections`     | —         | not implemented yet |
| `search`              | —         | not implemented yet |
| `getNovel`            | —         | not implemented yet |
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

## Fetch-only, no ambient authority

The only network access anywhere in this extension is via `host.fetch` /
`host.fetchBytes` (once later tasks add calls) — there is no direct
`fetch` and no bundled Node dependency.

## i18n

`src/strings.ts` ships this extension's own fallback strings, keyed off
`host.locale`. It currently only has the scaffold's placeholder entry;
real fallback keys will be added as later tasks need them (e.g. an
untitled volume or chapter).
