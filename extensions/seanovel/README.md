# SeaNovel — `extensions/seanovel`

Site: <https://seanovel.org> (بحر الروايات)

Korean, Chinese and Japanese web novels translated into Arabic, served by a
Next.js app. Novel pages live at `/novels/<slug>`, chapters at
`/novels/<slug>/chapters/<id>`. Most of this extension talks to the site's
own JSON API rather than scraping server-rendered HTML — except chapter
bodies, which the API refuses to serve (see "Three quirks" below).

## Capabilities

| Method                | Supported | Notes |
|-----------------------|-----------|-------|
| `canHandle`           | ✓         | matches `seanovel.org` and `www.seanovel.org` |
| `getHomeSections`     | ✓         | three rows built from the catalogue: latest, popular, completed |
| `search`              | ✓         | filters the catalogue locally and paginates the result itself |
| `getNovel`            | ✓         | one fully-populated pseudo-volume — see below |
| `getChapterContent`   | ✓         | from the rendered chapter page, not the API — see below |
| `getVolumeChapters`   | n/a       | absent on purpose: `getNovel` already returns every chapter, so nothing is ever lazy |
| `searchChapters`      | n/a       | absent on purpose: optional, and the full chapter list is already in hand from `getNovel` |

## Endpoint map

| Endpoint | Used by | Returns |
|---|---|---|
| `GET /api/novels` | `getHomeSections`, `search` | the entire catalogue, every novel, in one JSON array |
| `GET /api/novel/<slug>` | `getNovel` | one novel's full detail, including **every** chapter (`chapters: [{id, title}, ...]`) |
| `GET /api/novel/<slug>/cover?type=webp` | `cardFor`, `getNovel` | the novel's cover image |
| `GET /api/novel/<slug>/chapters/<id>` | *nothing* | 403s — see quirk 3 below; never called |
| `GET /novels/<slug>/chapters/<id>` (rendered HTML page) | `getChapterContent` | the chapter, server-rendered — the body lives in `article.reader-content` |

## Three quirks that cost real effort to discover

1. **The catalogue endpoint ignores query parameters entirely.** `GET
   /api/novels` always returns the whole catalogue — no `?q=`, `?page=`,
   or any other parameter changes the response. There is no
   server-side search or pagination to lean on: `search` and
   `getHomeSections` both fetch the catalogue once (memoised per `Source`
   instance, not at module scope — two instances never share one
   another's cache) and do all filtering, sorting and paging themselves,
   in memory.

2. **The detail endpoint carries every chapter, so nothing is lazy.**
   `GET /api/novel/<slug>` returns the complete chapter list
   (`chapters`) in the same response as the novel's metadata — there is
   no separate paginated chapter-listing call. `getNovel` therefore
   always returns exactly one fully-populated pseudo-volume; this
   `Source` never declares `hasLazyVolumes` and there is no
   `getVolumeChapters`. `chapters_count` is cross-checked against the
   actual length of the `chapters` array it received, and a mismatch is
   logged as a warning (not thrown) rather than silently truncating the
   book.

3. **The chapter API is token-gated, so chapter bodies come from HTML,
   not JSON.** `GET /api/novel/<slug>/chapters/<id>` — the endpoint you'd
   expect `getChapterContent` to use — responds `403` with
   `{"error":"Invalid or expired token"}`. It is never called. Instead,
   `getChapterContent` fetches the public, rendered page at
   `/novels/<slug>/chapters/<id>` and parses the chapter body out of
   `article.reader-content`'s `<p>` children, skipping paragraphs with
   class `sr-only` — screen-reader-only SEO copy, not chapter text. There
   are **two** of these per chapter, not one: a leading "you are reading
   chapter N of ..." blurb and a **trailing** "chapter N of ... ended,
   keep reading on seanovel.org..." blurb after the real body. Both are
   skipped by class (`p.classList.contains("sr-only")`), not by position
   — skipping only the first paragraph would leak the trailing blurb into
   the last line of every chapter.

   Also note: chapter ids are **non-contiguous and not all integers**
   (e.g. `1841.1`), so `getChapterContent` never parses, truncates, or
   rebuilds a chapter URL from `chapter.id` — it only ever fetches
   `chapter.url` exactly as given.

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

## `getChapterContent`

Fetches `chapter.url` (the rendered `/novels/<slug>/chapters/<id>` page —
never rebuilt from `chapter.id`, which is not reliably an integer) and
parses the DOM with `parseHtml`. The chapter body is
`article.reader-content`'s `<p>` children, run through `sanitizeText`;
paragraphs with class `sr-only` are skipped (see quirk 3 above — there
are two of them per chapter, one before the body and one after).

Failure modes are deliberately distinct, each with its own message, so a
site-layout change is diagnosable from the error alone rather than a bare
"chapter is empty":

- `article.reader-content` missing from the page at all → throws naming
  that selector specifically.
- the container exists but yields zero non-empty, non-`sr-only` lines →
  throws a separate "parsed to zero lines" error, rather than silently
  returning an empty chapter that looks like a successful, if short, read.

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

## Re-capturing the fixtures

`tests/fixtures/` holds three live captures, each read at test time (the
tests derive their expectations by parsing the committed fixture itself,
never from a hardcoded count) rather than pinned to what the site held on
capture day. All three were captured with the same user agent (the API
does not appear to require it, but the chapter page's Next.js SSR does
vary by client):

```
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
```

- **`novels.json`** — the whole catalogue:

  ```
  curl -sS --compressed -A "$UA" https://seanovel.org/api/novels \
    -o extensions/seanovel/tests/fixtures/novels.json
  ```

- **`novel.json`** — one novel's full detail (pick any real `<slug>` off
  the site; `shadow-slave` is the one currently committed):

  ```
  curl -sS --compressed -A "$UA" https://seanovel.org/api/novel/<slug> \
    -o extensions/seanovel/tests/fixtures/novel.json
  ```

- **`chapter.html`** — one rendered chapter page:

  ```
  curl -sS --compressed -A "$UA" https://seanovel.org/novels/<slug>/chapters/<id> \
    -o /tmp/seanovel-chapter-raw.html
  ```

  Do **not** commit that raw capture as-is. The full page is a Next.js
  SSR document with ~11 `<script src="/_next/static/chunks/...">` chunks
  for client hydration; happy-dom's `DOMParser` (what this repo's tests
  parse HTML with) tries to actually load each one and throws on the
  missing `window`/`fetch`, aborting the whole test file before a single
  test runs. Trim the raw capture down to just the
  `<article class="reader-content">...</article>` element — verbatim,
  including its real prose and both `sr-only` paragraphs — and wrap it in
  a minimal shell with **no** `<script>` or `<link>` tags:

  ```html
  <html><head><title>...</title></head><body><div id="__next">
    <!-- the extracted <article class="reader-content"> goes here, untouched -->
  </div></body></html>
  ```

  After trimming, re-run `pnpm test -- -t seanovel` and read the printed
  structural figures the tests derive from the new fixture (paragraph
  count, `sr-only` count, line-length range) — they are expected to
  change when the fixture changes; only a `sr-only` count of zero or a
  missing `article.reader-content` would indicate the capture or trim
  went wrong rather than the site's content simply being different.
