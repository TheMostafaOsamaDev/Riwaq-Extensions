# SeaNovel — `extensions/seanovel`

Site: <https://seanovel.org> (بحر الروايات)

Korean, Chinese and Japanese web novels translated into Arabic. Novel pages
live at `/novels/<slug>`, chapters at `/novels/<slug>/chapters/<id>`. The
site serves its data through a JSON API rather than server-rendered HTML:
`GET /api/novels` returns the entire catalogue in one call, and
`GET /api/novel/<slug>` returns one novel's full detail, including every
chapter. Chapter content is implemented against that same API in a later
task.

## Capabilities

| Method                | Supported | Notes |
|-----------------------|-----------|-------|
| `canHandle`           | ✓         | matches `seanovel.org` and `www.seanovel.org` |
| `getHomeSections`     | ✓         | three rows built from the catalogue: latest, popular, completed |
| `search`              | ✓         | filters the catalogue locally and paginates the result itself |
| `getNovel`            | ✓         | one fully-populated pseudo-volume — see below |
| `getChapterContent`   | not yet   | |

This extension is scaffolded via `pnpm new-extension seanovel`; `getChapterContent`
still throws `"not implemented"` and is filled in by the task that follows
in this plan.

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

## `getNovel`

`GET /api/novel/<slug>` returns one novel's full detail, including its
*entire* chapter list in the same response (`chapters`, matched exactly by
`chapters_count`) — there is no separate paginated chapter-listing
endpoint. `slugFromUrl(url)` extracts `<slug>` from either a novel URL
(`/novels/<slug>`) or one of its chapter URLs
(`/novels/<slug>/chapters/<id>`), throwing `SourceUrlError` for anything
else (e.g. `/about`).

Because the detail call already carries every chapter, `getNovel` always
returns exactly one fully-populated pseudo-volume (`id: 1`, titled via
`strings(locale)("volumeFallback", { n: 1 })`) — this extension never
declares lazy volumes (`hasLazyVolumes` is not set on the returned
`Source`), and there is no `getVolumeChapters`. Each chapter maps straight
through: `{ id, title } → { id, title, url: <BASE_URL>/novels/<slug>/chapters/<id>, lines: [] }`.

Field mapping: `title ← title_ar`, `originalTitle ← title_original`,
`author ← author ?? ""` (never the literal `"Unknown"` — many catalogue
rows have no author at all; the host localizes the empty case at display
time), `language: "ar"`, `direction: "rtl"`, `coverUrl` reuses the same
`/api/novel/<slug>/cover` helper `cardFor` uses, `tags ← genres ?? []`,
`status ← status`, `description ← description`. `meta` gets an `origin`
row (only when the API supplies one) and a `chapters_count` row (always),
both labelled via `strings(locale)`.

## Malformed API responses

Both JSON-fetching endpoints (`/api/novels` and `/api/novel/<slug>`) parse
their response body through a small guarded helper that reports the
endpoint path and the response's HTTP status in the thrown error, instead
of letting a non-JSON response (a CDN interstitial, a WAF block page, an
outage page, ...) surface as a bare, context-free `SyntaxError`. The
catalogue endpoint additionally checks that the parsed body is actually an
array, in case the API ever answers with an error-shaped JSON object
instead of the expected list.

## i18n

`src/strings.ts` ships this extension's own fallback strings, keyed off
`host.locale` (`"en" | "ar"`): `homeLatest`/`homePopular`/`homeCompleted`
label the three home-page rows, `volumeFallback` labels `getNovel`'s
pseudo-volume, and `metaOrigin`/`metaChapterCount` label its two synthesised
`meta` rows. It cannot reach the app's message catalogue.
