# NovelBuddy — `extensions/novelbuddy`

Site: <https://novelbuddy.me> (mirrors: `novelbuddy.io`, `novelbuddy.com`)

English translations of Chinese, Korean and Japanese web novels, plus
English originals and a large "MTL" (machine-translated) shelf. The site is
a Next.js **pages-router** app: every page it serves embeds its complete
server-side data as JSON in `<script id="__NEXT_DATA__">`, so this extension
reads that JSON rather than scraping rendered markup wherever it can. The
one thing a page does *not* inline in full — a novel's chapter list — comes
from the site's own JSON API at `api.novelbuddy.me`, the same call the
site's client makes.

Everything is plain `GET`: no JavaScript, no token, no cookie, no
Cloudflare challenge (checked with the app's exact user agent through
`scripts/probe.ts`'s curl transport). `host.renderAndExtract` is never used.

## Capabilities

| Method              | Supported | Notes |
|---------------------|-----------|-------|
| `canHandle`         | ✓ | `novelbuddy.me`, `novelbuddy.io`, `novelbuddy.com`, each with or without `www.` |
| `getHomeSections`   | ✓ | the site's three novel rows: Trending, Popular Updates, Latest Updates (headings localised) |
| `search`            | ✓ | real server-side pagination, 24 per page, `hasMore` from the site |
| `getNovel`          | ✓ | one fully-populated volume holding every chapter (6,107 for Martial Peak); the list request is skipped while the title's `cv` is unchanged |
| `getChapterContent` | ✓ | three body shapes handled; site furniture stripped — see below |
| `searchChapters`    | ✓ | local filter over the list `getNovel` already fetched |
| `getVolumeChapters` | n/a | nothing is lazy: one API response carries the whole list |

## Endpoint map

| Request | Used by | What is read |
|---|---|---|
| `GET https://novelbuddy.me/home` | `getHomeSections` | `pageProps.trendingItems`, `pageProps.popularItems`, `pageProps.latest.items` |
| `GET https://novelbuddy.me/search?q=<q>[&page=<n>]` | `search` | `pageProps.ssrItems`, `pageProps.ssrPagination.has_next` |
| `GET https://novelbuddy.me/<slug>` | `getNovel`, `searchChapters` | `pageProps.initialManga` (metadata, title id, `cv`) |
| `GET https://api.novelbuddy.me/titles/<id>/chapters?cv=<cv>` | `getNovel`, `searchChapters` | `data.chapters[]` — every chapter, newest first; not re-requested while `cv` holds (see `getNovel`) |
| `GET https://novelbuddy.me/<slug>/<chapter-slug>` | `getChapterContent` | `pageProps.initialChapter.content` (an HTML fragment) |

`/_next/data/<buildId>/…json` routes exist too, but `buildId` changes on
every deploy and would have to be scraped first; the HTML pages carry the
same JSON for one request and never go stale.

## Quirks that cost real effort to discover

1. **No `/novel/` prefix — and `www.` loops forever.** A novel is
   `https://novelbuddy.me/<slug>`, a chapter `https://novelbuddy.me/<slug>/<chapter-slug>`.
   `/novel/<slug>` **404s** on the current site, but it is exactly the shape
   the old NovelBuddy on `novelbuddy.io` / `novelbuddy.com` used, and both of
   those domains now `301` to `novelbuddy.me` keeping the path. Meanwhile
   `https://www.novelbuddy.me/<anything>` answers `301` to **itself**
   (`curl -L` gives up after its redirect cap). So `slugFromUrl()` accepts all
   six hosts, drops a leading `novel/` (or `read/`, which the current site
   also routes) when something follows it, and every request is rebuilt on
   the bare `https://novelbuddy.me` host — a library entry saved from any
   mirror still loads.

2. **The novel page inlines only the newest 50 chapters.**
   `initialManga.chapters` is a 50-row window. The full table of contents
   comes from `api.novelbuddy.me/titles/<id>/chapters`, where `<id>` is the
   8-character title id (`initialManga.id`, e.g. `VYPGVZ8z`) — the API
   rejects a slug with *"Title ID must contain only alphanumeric
   characters"*. It returns **every** chapter in one response, no paging:
   3,229 rows for Shadow Slave (~810 KB), 6,107 for Martial Peak.

3. **Without `?cv=` the chapter list can be stale.** `cv` is the title's
   cache version (`initialManga.cv`) and the site's own client appends it.
   Measured on the same minute: 3,227 chapters without it, 3,229 with it
   (the API sits behind a CDN with `s-maxage=86400`). `chapterListUrl()`
   always sends it when the page has one.

4. **The list is newest-first, and `number` is not an id.** The API sorts
   newest first; `parseChapterList` reverses it (or leaves it, if the first
   row's `number` is already the smaller one). Chapter ids are 1-based
   positions, never the site's `number`: Martial Peak's first chapter has
   `number: 0`, and titles like "Chapter 331: Chapter 304: …" show numbering
   that repeats and skips.

5. **Three chapter-body shapes.** Over 73 chapters from 54 novels (first,
   middle and latest chapters; translated, original and MTL):
   - `<p>` paragraphs (most chapters);
   - a wrapper `<div>` holding a **bare text node** with the chapter heading
     (sometimes followed by `<strong>Editor: </strong>Henyee Translations`),
     *then* the `<p>`s;
   - machine-translated titles: bare text separated by `<br /><br />`, with
     **no `<p>` at all** — a `querySelectorAll("p")` reader returns nothing.

   `htmlToRawLines` therefore walks the whole fragment: a new line at every
   block element and every `<br>`, inline elements merged into their text,
   `<img>` as an image line (absolute URL; `data:` URIs skipped), and
   `<script>`/`<iframe>`/`<ins>` and similar skipped. Zero-width characters
   (Reverend Insanity puts a U+200C after nearly every word) and
   Private-Use-Area glyphs (the source site's font obfuscation — whole
   lines of U+E5E5 in some MTL chapters, tofu without that font) are
   removed. Each line remembers whether it sat inside a `<p>`, which the
   heading rule below needs.

6. **The site is slow and occasionally drops a connection.** Pages take
   1–21 s (a cold chapter list 20–30 s), and in a dozen sequential requests
   one stalled for 60 s; a few requests during development died with a TLS
   "connection reset by peer". Every request goes through `get()`, the
   shared `createFetcher` from `@riwaq/extension-api`: a thrown error or a
   `5xx` is retried with a backoff (1 s, then 2 s, jittered; 3 requests at
   most), a `429` pauses every request of the source for its `Retry-After`.
   A `4xx` is the site's real answer and is not retried.

## What `getChapterContent` strips

Applied by `chapterLinesFrom` to the lines `htmlToRawLines` produced
(`chapter.title` is passed in for the heading rule). The watermark, credit and
heading rules are the shared ones from `@riwaq/extension-api` (`stripWatermarks`,
`findCreditLines`, `isLeadingHeading` — see the repo README's "Shared helpers"); the
notices, navigation and end marker are this site's own:

| Line | Seen on | Rule |
|---|---|---|
| `Foll𝑜w current novℯls on ƒrēewebnoѵёl.cσm.`, `Updat𝓮d fr𝙤m ƒгeeweɓn૦vel.com.`, `…on fre(e)webno(v)el.𝒸𝑜𝘮`, `Visit frёewebnoѵel.ƈo๓ for the b𝘦st novel reading experience.` | chapters copied from freewebnovel.com (Shadow's Oath, Lord of Mysteries fan-fic, Overgeared, Martial Peak, …) | the **sentence** holding the domain is cut, anywhere; the line goes only if nothing else was on it — see below |
| `…Not until today at least.𝕗𝗿𝕖𝐞𝐰𝗲𝕓𝐧𝕠𝕧𝗲𝐥.𝚌𝐨𝚖` | the same watermark glued onto a real paragraph (Martial Peak) | a domain that stands as a sentence of its own goes alone; the story sentence stays |
| `Chapter 4566: One Too Many (Part 2)` | wrapper-`<div>` and MTL chapters, as a bare text node | first text line, outside a `<p>`, reading "Chapter N…" |
| `Chapter 6081, Disciplinary Hall` | the same heading inside a `<p>` (Martial Peak) | first text line equal to the chapter's own title, ignoring case and punctuation. Any other "Chapter N" paragraph stays |
| `A new text-to-speech function has been added. You can try clicking on the settings!` | the site's own notice, a bare `<div>` | anywhere |
| `If you find any errors ( Ads popup, … ), Please let us know < report chapter > …` | footer copied in with older scraped chapters (Martial Peak) | anywhere |
| `[Translator - Night]`, `[Proofreader - Gun]` | Shadow's Oath — at both ends *and* mid-body, where two source chapters were glued together | a whole bracketed role/name line, anywhere |
| `Editor: Henyee Translations`, `Author: Silavin`, `Translator: Skyfarrow Editor: Skyfarrow` | Complete Martial Arts Attributes, Martial Peak, Reverend Insanity | bare role/name lines, only among the first and last 4 text lines (or touching another credit there) — so a system panel's "Author: Unknown" mid-chapter stays |
| `Previous Chapter`, `Next Chapter`, `Previous Chapter \| Next Chapter` | navigation scraped in as a `<p>` (Against the Gods) | whole line, only among the first and last 4 text lines |
| `(End of this chapter)` | MTL chapters (the source's "本章完") | exact whole line, anywhere |

**The watermark matcher** is the shared `stripWatermarks`. freewebnovel spells
its domain with look-alike characters, a different mix on every chapter: the
matcher folds each line with NFKD (𝓮 𝕗 𝚌 𝒸 ē come back as ASCII) and a
confusables table (Cyrillic, Greek, small capitals), and turns whatever non-ASCII
letter or digit is *still* left (ƒ г ɓ ૦ σ ๓ …) into a wildcard, at most half of a
match's letters. A known aggregator name only counts with a TLD, disguised, or
wrapped in decoration, so a story that talks about "a free web novel" is untouched.
The cut runs from the start of the sentence holding the domain to its end — unless
the domain stands as a sentence of its own (glued onto the next word, or followed
by a new sentence), where only the domain goes.

Left in on purpose: author's and translator's notes ("Author's Note: …",
"TL note: …", "A/N: Join Patreon…") — they are the author's own words and no
shape tells a closing note from closing prose; MTL artefacts such as a
trailing "Omniscient Reader's Viewpoint Chapter 5"; translator footnotes.
Empty paragraphs and ad placeholder `<div>`s carry no text and vanish on
their own. A body that still yields zero text lines throws rather than
handing the reader a blank chapter.

## `getHomeSections`

`/home` renders five `<section>`s with an `<h2>`: Trending, Popular Updates,
XP Leaderboard, Latest Updates, Latest Lists. Only three hold novels, and the
page's `__NEXT_DATA__` carries each of those as an array of its own, so
`HOME_ROWS` reads them straight from `pageProps` — no markup is parsed:

| id | `pageProps` field | heading (`en`) | cards | `viewMoreUrl` |
|---|---|---|---|---|
| `trending` | `trendingItems` (50 items) | Trending | first 12, as the site shows | `/trending/manga` |
| `popular` | `popularItems` | Popular Updates | 10 | `/search?sort=views_today` |
| `latest` | `latest.items` | Latest Updates | 24 | none (the site has no "See all") |

The headings are the site's own English text, restated in `src/strings.ts`
(they live in the page markup, not in the arrays) and translated for `ar`.
XP Leaderboard and Latest Lists hold no novels; the "Top read" sidebar is a
re-cut of Popular Updates and the hero carousel has no heading, so none of
them becomes a row.

Card: `title ← name`, `coverUrl ← cover` (absolute,
`rs.novelbuddy.me/covers/…`, fetchable without a referer), `subtitle ←` the
newest chapter's name (else `displayChapters`, e.g. "3,229 chapters"),
`badges ←` first three genres. The card URL is rebuilt from the slug on the
canonical host. `trendingItems` ships no genres and an empty
`latestChapters`, so Trending cards carry the chapter count and no badges.
A page with no row at all throws.

## `search`

`/search?q=<query>&page=<n>` (page omitted for page 1) is server-rendered:
`ssrItems` holds 24 title objects and `ssrPagination` holds `page`,
`total_pages` and `has_next`. `hasMore` is `has_next === true` (every
response carries it). Asking past the end returns `ssrItems: []` with
`has_next: false`. Checked live: page 1 and page 2 of "martial" share no
card. An empty or blank query returns `{ cards: [], hasMore: false }`
without a request.

## `getNovel`

Two requests: the novel page, then the chapter list (quirks 2–4) — the
second only when needed. The app calls `getNovel` more than once for the
same novel (the detail view, then the importer), so the last list fetched is
kept as plain `{ title, url }` rows keyed by slug **and** `cv`: the novel page
is always fetched (fresh metadata, current `cv`), but while its `cv` matches
the kept rows the ~800 KB list request is skipped. A new chapter moves `cv`,
so the list is fetched again. Concurrent calls for the same list share one
in-flight request, and a failed request is not kept.

The rows are all that is kept. Every call builds **fresh** `SourceChapter`
objects from them, because the importer writes each chapter's text onto the
objects `getNovel` returned (`sourceChapter.lines = …`) and extensions share
the app's JS context — caching those objects would pin every imported
chapter's text in memory (~100 MB for a 6,000-chapter novel). One entry per
`Source` instance, closure state, never module state.

Field mapping from `initialManga`:

| `SourceNovel` | from |
|---|---|
| `title` | `name` |
| `originalTitle` | `displayAltName` / `altName`, only when it differs from `name` (`그림자 서약` for Shadow's Oath; Shadow Slave's alt name is "Shadow Slave" again, so none) |
| `author` | `authors[].name` joined with ", "; `""` when none |
| `coverUrl` | `cover` |
| `description` | `summary` — HTML (`<p>…<br />…</p>`) on some novels, plain text on others — flattened to paragraphs joined by blank lines |
| `tags` | `genres[].name` then `tags[].name`, case-insensitive duplicates dropped (Shadow Slave: 4 genres + 20 tags → 21) |
| `status` | `status` in the host's locale: `ongoing`, `completed`, `hiatus`, `cancelled` (the site's search-filter values; the novel page spells the first `OnGoing`) → Ongoing / Completed / Hiatus / Cancelled; anything else passes through with its first letter capitalised |
| `meta` | Type (`type.name`), Chapters (the list's length), Rating (`ratingValue`: `4.8 / 5 (37 ratings)`, only when `ratingsCount` > 0), Views, Bookmarks, Released (`releaseDate`), Last updated (`updatedAt`, date part) — each only when present |
| `volumes` | one volume, "All Chapters", every chapter, `chapterCount` set |

`stats.chaptersCount` is compared with the list's length and a mismatch is
logged at `warn` (not thrown — the chapters that did arrive are still a
readable book). A chapter-list failure (non-2xx, non-JSON, `success: false`,
no `data.chapters`) throws instead of returning a truncated book.

`buildNovel` holds the mapping as a pure function so the metadata-rich
Shadow Slave fixture can be tested without its 810 KB chapter list.

## `searchChapters`

The site has no in-novel chapter search, but `getNovel` already fetched the
whole list. `searchChapters` filters it by case-insensitive substring of the
title, using the rows `getNovel` kept (see above) when they are this novel's,
with no request at all. For any other novel it fetches the page and the list
the same way `getNovel` does. An empty query returns `[]`.

## Errors

Every error starts with `novelbuddy: ` (the manifest id) and names the URL:

- non-2xx page → `… <url> answered HTTP <status>.`
- no `__NEXT_DATA__` (challenge or error page) → `… has no __NEXT_DATA__ payload …`
- the payload lacks the expected prop → `… carried no novel data (pageProps.initialManga)`,
  `… carried no chapter text (pageProps.initialChapter.content)`,
  `… carried no results list (pageProps.ssrItems)`, with the page's own
  `httpError`/`initialError`/`chapterError` text appended when present
- home page with no rows → `… found no novel rows …`
- bad URL → `SourceUrlError`

Logging: `info` for `getHomeSections`, `search`, `getNovel`,
`searchChapters`; `debug` for `getChapterContent` and for retries.

## i18n

`src/strings.ts` carries `en` and `ar` for what this extension synthesises:
the three home row headings (`homeTrending`, `homePopularUpdates`,
`homeLatestUpdates` — the site's own English headings, translated), the
volume title (`allChapters`), a fallback chapter title (`chapterFallback`,
never seen needed), the `meta` row labels with the rating format
(`ratingValue`), and the four statuses (`statusOngoing`, `statusCompleted`,
`statusHiatus`, `statusCancelled`).

## Fixtures

All unedited captures (2026-10-29), taken with the app's user agent:

```
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
curl -sS --compressed -A "$UA" -o <file> <url>
```

| File | URL |
|---|---|
| `home.html` | `https://novelbuddy.me/home` |
| `search.html` / `search-page2.html` | `https://novelbuddy.me/search?q=shadow` / `…&page=2` |
| `search-empty.html` | `https://novelbuddy.me/search?q=zzqqxxnomatch` |
| `novel.html` | `https://novelbuddy.me/shadows-oath` (110 chapters, Korean alt title) |
| `chapters.json` | `https://api.novelbuddy.me/titles/eDkM6O8Q/chapters?cv=1742199221000` — take `id` and `cv` from `novel.html`'s `initialManga` |
| `novel-rich.html` | `https://novelbuddy.me/shadow-slave` (HTML summary, genres + tags) |
| `chapter.html` | `https://novelbuddy.me/shadows-oath/chapter-108` (bracketed credits at both ends and mid-body, a freewebnovel watermark line, TTS notice) |
| `chapter-heading.html` | `https://novelbuddy.me/complete-martial-arts-attributes/chapter-4895-dark-apparitions-drama-of-the-year-are-you-teaching-me-how-to-do-things-im-not-indulging-you-life-stain-2` (wrapper heading, `Editor:` credit) |
| `chapter-mtl.html` | `https://novelbuddy.me/mtl-cultivation-fishermen/chapter-1` (`<br>`-only body, end marker) |
| `chapter-scraped.html` | `https://novelbuddy.me/martial-peak/chapter-6106-blood-binding-seal` (bare heading, `Author:` credit, "report chapter" footer) |
| `chapter-glued.html` | `https://novelbuddy.me/martial-peak/chapter-6081-disciplinary-hall` (heading inside a `<p>`, watermark glued onto a story paragraph) |

Tests derive their expectations from the fixtures at test time (reading
`__NEXT_DATA__` with their own regex, not the extension's), so a re-capture
with different novels or counts needs no edits beyond the few literal row
titles and fixture-sanity checks.

## Live probe

```
PROBE_ID=novelbuddy PROBE_QUERY="shadow" pnpm probe
```

Expect it to take a minute: the chapter-list call alone is often 20–30 s.
