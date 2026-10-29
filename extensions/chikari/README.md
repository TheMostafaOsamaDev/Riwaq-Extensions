# chikari.moe — `extensions/chikari`

Site: <https://chikari.moe>

An English reading site that carries both web novels and comics (manga,
manhwa, manhua). **This extension covers the novels only.** The site was
also listed under `lightnovelworld.org`; that domain has since shut down and
now serves a "merged into chikari.moe" notice on every path (all of them 301
to `/`), so it is not a mirror and `canHandle` does not accept it.

The site is a SvelteKit SPA with no server-side rendering: every page's HTML
is the same ~25 KB shell, and all content arrives from a public JSON API
under `/api`. That API answers plain cookie-less `GET`s: no token, no
signature, no Cloudflare JS challenge. So this extension never parses
HTML. It calls the same endpoints the site's own client calls, found by
reading its `/_app/immutable/` chunks.

## Capabilities

| Method              | Supported | Notes |
|---------------------|-----------|-------|
| `canHandle`         | ✓ | exact host `chikari.moe` / `www.chikari.moe`, path `/novels/<slug>…` only |
| `getHomeSections`   | ✓ | the site's own novel rows from `/api/home?type=novel` |
| `search`            | ✓ | `/api/series` with `type=novel`; real offset pagination, `hasMore` from `total` |
| `getNovel`          | ✓ | detail + **every** page of the chapter list, one populated pseudo-volume |
| `getChapterContent` | ✓ | `/api/novels/<slug>/chapters/<n>/read`, split the way the site's reader splits it |
| `searchChapters`    | ✓ | the site's own in-novel search (`/chapters?q=`) |
| `getVolumeChapters` | n/a | absent on purpose: nothing is lazy (see `getNovel`) |

## Endpoint map

| Endpoint | Used by | Returns |
|---|---|---|
| `GET /api/home?type=novel` | `getHomeSections` | `{ rows: [{ slug, items: [card…] }], genres }`. Without `type=novel` it's comics only |
| `GET /api/series?q=<q>&type=novel&limit=36&offset=<n>` | `search` | `{ items: [card…], total, limit, offset }` |
| `GET /api/novels/<slug>` | `getNovel` | novel detail (below) |
| `GET /api/novels/<slug>/chapters?order=asc&limit=500&offset=<n>` | `getNovel` | `{ items: [{ number, title, volume, lang, created_at }], total, limit, offset }` |
| `GET /api/novels/<slug>/chapters?q=<q>&order=asc&limit=500&offset=<n>` | `searchChapters` | same shape, filtered by title |
| `GET /api/novels/<slug>/chapters/<number>/read` | `getChapterContent` | `{ number, title, body, locked, lock_reason, club_block, protected_window, prev_number, next_number, … }` |

A card row (home, search) is `{ id, slug, title, type, status, is_nsfw,
chapter_count, cover_url, latest_chapter, last_chapter_at, rating,
rating_count, views, medium }`. `medium` is `"novel"` or `"comic"`. Covers
are `https://cdn.chikari.moe/novels/<id>/cover.webp` (the site also serves
`cover_200/400/600.webp` thumbnails; we use the full one as given).

Unused but present: `/api/novels/search?q=` (the old quick-search: a bare
array capped at 20, no `offset`, so no pagination). Errors come back as JSON,
e.g. a missing novel or chapter is `404 {"detail": "Not Found"}`.

## URLs and chapter ids

- Novel: `https://chikari.moe/novels/<slug>`. Comics live at `/series/<slug>`
  and are rejected. `/novels` alone just redirects to `/`.
- Chapter: `https://chikari.moe/novels/<slug>/<number>`, where `<number>` is
  formatted exactly as the site's client does it: `String(number)`, so `12`
  and, for a half-chapter, `12.5`.
- **`SourceChapter.id` is the site's own chapter `number`**, not a 1..n
  index. Numbers are unique per novel but have gaps: First Immortal of the
  Sword lists 3124 chapters running to number 3131, and its row numbered
  500 is titled "Chapter 501". Using the site's number keeps ids stable when
  the site inserts or drops a chapter, and lets `searchChapters` return
  the same ids as `getNovel` without sharing any state.
  `getChapterContent` reads slug and number back out of `chapter.url`; it
  never rebuilds anything from `chapter.id`.
- Chapter titles are used verbatim. Some carry their own number ("Chapter
  1: The Hall of Mourning"), some don't ("Harem", "Volume 1 Prologue"),
  and some are just "Chapter 400:". An empty title falls back to "Chapter
  <n>", the same fallback the site uses.

## `getHomeSections`

`/api/home?type=novel` returns rows keyed by slug only. The headings live in
the site's client bundle, which maps `trending`, `popular`, `top-rated`,
`bingeable`, `recently-updated` and `recently-added` to "Trending",
"Popular", "Top Rated", "Complete & Bingeable", "Recently Updated" and
"Recently Added". Those strings are in `src/strings.ts` (en verbatim, plus
ar). The section `id` is the site's slug. A row whose slug isn't in that
table is skipped, which is what the site's own client does. The novel feed
currently sends five rows (no `bingeable`). Each card is also filtered to
`medium === "novel"` as a second guard against comics. `viewMoreUrl` is the
site's own "view all" link, `/search?sort=<sort>&type=novel`. Zero usable
rows throws: a home page that silently goes blank looks like the site being
empty, not like the API having changed.

## `search`

`/api/series` is the endpoint the site's own `/search` page uses (36 per
page there too). `type=novel` restricts it to novels. `sort` is left unset:
the default ranks by relevance (an exact title match first), and its order
is stable across offsets. Page *p* is `offset = (p-1)·36`, and `hasMore` is
`offset + items.length < total`. Verified live: "sword" gives 42 results
(36, then 6 with `hasMore: false`, no overlap). An empty or whitespace query
returns a hollow result without calling the site.

## `getNovel`

The detail and the first chapter page are fetched in parallel. The first
page's `total` gives the number of pages, and the rest go out four at a
time. `limit` is capped server-side at 500: `limit=1000` and `limit=5000`
both return 500. The detail's `chapters_head` / `chapters_tail` (ten rows
each) are ignored. Rows are de-duplicated by number (a chapter released
mid-pagination can shift a row across a page boundary). A row with no
numeric `number` is skipped with a warning, since the read endpoint is
addressed by number. If the collected count differs from `total`, that is
logged as a warning, not thrown.

**One fully-populated pseudo-volume, never lazy.** The site has no volumes:
every row's `volume` is `""` across every novel checked, light novels
included. The app's importer flattens `getNovel`'s volumes as returned and
never calls `getVolumeChapters`, so lazy volumes would import nothing.

| Field | From |
|---|---|
| `title` | `title` |
| `author` | `authors[]` with `role: "author"` (or all names if none has that role), joined; `""` when absent |
| `coverUrl` | `cover_url` |
| `description` | `description` (plain text with `\n\n` paragraphs) |
| `tags` | `genres[].name` only. The separate `tags[]` is NovelUpdates-style: 35 to 100+ per novel, alphabetical, some `is_spoiler`. Far too many for chips, so it is not surfaced |
| `status` | `releasing / completed / hiatus / cancelled / upcoming`, mapped to the site's own labels (localised) |
| `meta` | Chapters (`chapter_count`), Rating (`rating / 10 (rating_count)`, only when rated), Views, Year (when set), Last updated (`last_chapter_at` date), Alternative titles (when set) |

`alt_titles`, `year` and `type` were empty/`null`/`""` on every novel
sampled. They are handled but not relied on.

## `getChapterContent`

`body` is plain text. The reader (`nodes/36.*.js`) splits it on
`/\n\s*\n|\n/`, HTML-escapes each piece, and then re-enables only an inline
whitelist: `<em> <strong> <i> <b> <u> <s> <sup> <sub>` and `<br>`, with no
attributes. This extension mirrors that exactly. It splits the same way,
treats `<br>` as a line break, strips only those tags, and leaves every
other `<…>` alone, because to the reader that is literal text. Real example:
`The <Dark Exploration Records> was an opensource wiki.` Stripping all
tags would delete the story's own words. Adjacent tags glue words the way
the site displays them: `The<em>Myrrason Family.</em>` becomes
`TheMyrrason Family.`. Novels have no inline images (`reading_mode` is
`"text"`), so every line is a text line.

### Junk lines

The text is the scanlator's as uploaded, so some chapters carry plugs.
`isJunkLine` drops a line when it is:

- a link (`http(s)://`, `www.`) or a bare `name.com/.net/.org/.moe` domain
  (the TLD is matched lower-case so `time.Me` can't hit);
- a Ko-fi / "buy me a coffee" / Patreon plug (note `<strong>KO-FI</strong><strong>BUY ME A
  COFEE</strong>` becomes `KO-FIBUY ME A COFEE`, so these use no word
  boundaries; the hyphen in `Ko-fi` is required so the name "Kofi" survives);
- a Discord plug (`join our/the discord`, `in the discord`, `Discord:`,
  `discord server/link/channel`), not the plain noun ("discord between the sects");
- an "advance(d) chapters" / "Adv4nc3 Ch4pt3r" upsell;
- a translator-notes header (`Translator's Comments`, `Translator Notes: …`, `TL notes`);
- a credit line of at most 160 chars starting `Translator:`, `Editor:`,
  `Proofreader:`, `TL:`, `ED:` etc. ("Translator: AtlasStudios Editor: AtlasStudios").

Calibrated against ~85 chapters across ~75 novels. Every pattern is a
shape actually seen, and ordinary prose ("The coffee here is delicious.",
"…endless number of comments.", "he translated the …") is pinned as
surviving in the tests. Authors' own afterwords (thanks, schedules without
links) are original content and are kept. Scene breaks (`***`, `-`) are
kept.

### Locked chapters

The chapter list does **not** flag locked chapters. Only the read endpoint
does. Some novels hold back their newest *N* chapters as "early access for
supporters" (`locked: true, lock_reason: "early_access", protected_window: 8,
body: ""`). Genetic Ascension and Journey of the Fate-Destroying Emperor had
8 each on 2026-10-29. `getChapterContent` throws a branded error naming the
chapter and why (the site's own message: "The N newest chapters of X are
early access for supporters"). Those chapters still appear in `getNovel`,
as they do on the site, and become readable when the window moves on. A
`club_block` (reading-club-only chapter) throws similarly.

## Errors and the rate limiter

Every error is prefixed `chikari:`. `readJson` handles every endpoint the
same way:

- **429** with `{"code": "challenge_required"}`: the site's API client
  intercepts exactly this, opens a human-verification dialog, and retries.
  A plain HTTP client can't pass that, so the error says to wait and retry.
  It was **not** observed while building this. Roughly 200 chapter reads
  across one afternoon all got 200: sequential runs, ~85 reads at
  concurrency 6, and a 40-request burst at concurrency 8. It is still the
  main risk for a very large import at high concurrency.
- **404**: "`<what>` was not found".
- any other non-200: the endpoint and status.
- a 200 that isn't JSON, or JSON of the wrong shape: the endpoint and what
  was missing.

## Fixtures

All under `tests/fixtures/`, unedited captures (curl, the probe's UA)
taken 2026-10-29. Tests derive expectations from them at run time wherever
the value is just whatever the site said.

| File | URL |
|---|---|
| `home.json` | `/api/home?type=novel` |
| `search-p1.json`, `search-p2.json` | `/api/series?q=sword&type=novel&limit=36&offset=0` / `36` (42 results) |
| `search-none.json` | `/api/series?q=zzqqxxnotitle&type=novel&limit=36&offset=0` |
| `novel.json` | `/api/novels/swordmasters-youngest-son` (810 chapters) |
| `chapters-p1.json`, `chapters-p2.json` | its `/chapters?order=asc&limit=500&offset=0` / `500` |
| `chapter-search.json` | its `/chapters?q=Banquet&order=asc&limit=500&offset=0` |
| `chapter.json` | its chapter 400: `<strong>` headings and a Ko-fi plug |
| `chapter-credits.json` | `lord-of-the-mysteries` 5: a translator/editor credit line |
| `chapter-angle-brackets.json` | `got-dropped-into-a-ghost-story-still-gotta-work` 110: `<Dark Exploration Records>` |
| `chapter-notes.json` | `trash-of-the-counts-family` 929: a trailing translator's-comments block |
| `chapter-links.json` | `a-regressors-tale-of-cultivation` 75: Discord/support links and a TL note |
| `chapter-locked.json` | `genetic-ascension` 2496: early-access lock |
| `not-found.json` | `/api/novels/no-such-novel-zz` (HTTP 404) |

Tests that need a shape the site didn't happen to serve (a comic item in a
novel row, an untitled chapter, a club block) mutate an in-memory copy of a
parsed fixture. The files themselves are never edited.

## Live probe

```bash
PROBE_ID=chikari PROBE_QUERY="sword" NODE_OPTIONS=--no-experimental-webstorage pnpm probe
```

All five methods it exercises pass. On Linux, `scripts/probe.ts` itself
can't run as-is: it passes curl `-D /dev/stderr`, Node gives child
processes a socketpair as stderr, and `open()` on a socket fails, so every
request dies with `curl: (23)`. That is a harness issue, not an extension
one (macOS is unaffected).
