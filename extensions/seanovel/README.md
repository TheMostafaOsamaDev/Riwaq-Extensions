# SeaNovel — `extensions/seanovel`

Site: <https://seanovel.org> (بحر الروايات)

Korean, Chinese and Japanese web novels translated into Arabic. Novel pages
live at `/novels/<slug>`, chapters at `/novels/<slug>/chapters/<id>`. The
site serves its data through a JSON API rather than server-rendered HTML:
`GET /api/novels` returns the entire catalogue (every novel, no
pagination) in one call. Novel detail and chapter content are implemented
against that same API in later tasks.

## Capabilities

| Method                | Supported | Notes |
|-----------------------|-----------|-------|
| `canHandle`           | ✓         | matches `seanovel.org` and `www.seanovel.org` |
| `getHomeSections`     | ✓         | three rows built from the catalogue: latest, popular, completed |
| `search`              | ✓         | filters the catalogue locally and paginates the result itself |
| `getNovel`            | not yet   | |
| `getChapterContent`   | not yet   | |

This extension is scaffolded via `pnpm new-extension seanovel`; `getNovel`
and `getChapterContent` still throw `"not implemented"` and are filled in
by the tasks that follow in this plan.

## `canHandle`

Accepts `https://seanovel.org/...` and `https://www.seanovel.org/...` —
any path, since only the hostname is checked. Anything else, or a string
that isn't a valid URL at all, returns `false` rather than throwing.

## The catalogue: `getHomeSections` and `search`

`GET /api/novels` returns a flat JSON array of every novel on the site —
no query params, no pagination; the server ignores whatever you pass it
and always returns the whole thing. Both `getHomeSections` and `search`
fetch this once per `Source` instance and derive their results from it in
memory:

- `getHomeSections` builds three rows — `latest` (sorted by
  `last_updated`, newest first), `popular` (sorted by `chapters_count`,
  most first) and `completed` (`status === "completed"`) — each capped at
  `PAGE_SIZE` (24) cards and dropped entirely if empty.
- `search` lowercases the query and matches it against `title_ar`,
  `title_original` and `slug`, then slices the filtered list into pages of
  `PAGE_SIZE` itself and reports `hasMore` from what's left over. Since
  the site does no filtering or paging of its own, both are entirely this
  extension's responsibility.

The catalogue fetch is memoised **per `Source` instance**, not at module
scope: each call to `createSource(host)` gets its own cache, so two
instances (e.g. one per test, or a reloaded extension) never share one
another's catalogue. The cost is one extra `/api/novels` fetch per
instance — cheap, and worth it to avoid an instance silently serving
another instance's data.

## i18n

`src/strings.ts` ships this extension's own fallback strings, keyed off
`host.locale` (`"en" | "ar"`). It cannot reach the app's message
catalogue. No fallback keys are needed yet — they'll be added as the
site's discovery/search/novel/chapter parsing needs them.
