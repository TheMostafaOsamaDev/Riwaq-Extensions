# Novel Archive — `extensions/novelarchive`

Site: <https://novelarchive.st> (same site and API on <https://novelarchive.cc>)

A very large English archive — 270,000+ novels in its catalogue, web novels and
translations "archived from multiple sources". The pages are thin HTML shells that
fill themselves from a public JSON API under `/api` (the site's own
`assets/js/api.js` is the map of it). This extension talks only to that API: no HTML
is parsed anywhere, and nothing needs JavaScript, a cookie handshake or a
challenge — plain HTTP with the app's user agent gets every endpoint below. The
`challenge.xewdy.systems` script the pages load is a captcha widget for the site's
forms (ratings, downloads, requests), not a gate on reading.

## Capabilities

| Method              | Supported | Notes |
|---------------------|-----------|-------|
| `canHandle`         | ✓ | `novelarchive.st`, `novelarchive.cc`, and their `www.` forms |
| `getHomeSections`   | ✓ | the site's three home rows: Trending, Editor's Choice, Latest Updates |
| `search`            | ✓ | server-side, relevance-ranked, real pagination (`has_next`) |
| `getNovel`          | ✓ | metadata + **every** chapter in one call, one fully-populated volume |
| `getChapterContent` | ✓ | the archive's plain text, cleaned (see "Cleaning chapter text") |
| `searchChapters`    | ✓ | the site's own chapter filter (number or name contains the query) |
| `getVolumeChapters` | n/a | absent on purpose: nothing is lazy, the novel call carries every chapter |
| `resolveImage`      | n/a | the archive copy is text only (see "Not used: mirror sources") |

## Endpoint map

| Endpoint | Used by | Returns |
|---|---|---|
| `GET /api/novels/trending?limit=24` | `getHomeSections` | `{novels: [...]}` — the home page's trending carousel |
| `GET /api/novels/editors-choice?limit=24` | `getHomeSections` | `{novels: [...]}` — up to ~12 staff picks |
| `GET /api/novels/recently-updated?limit=24` | `getHomeSections` | `{novels: [...]}` — "Latest Updates" |
| `GET /api/novels?search=<q>&fuzzy=1&page=<n>&per_page=24` | `search` | `{novels, pagination: {page, total_pages, has_next, …}, search_info}` |
| `GET /api/novels/<id>` | `getNovel`, `searchChapters` | `{novel: {…, chapter_names: [...]}}` |
| `GET /api/novels/<id>/chapters/<n>?prefetch=1` | `getChapterContent` | `{novel, chapter: {number, name, content}, navigation}` |
| `GET /api/novels/<id>/cover?w=640&q=72&format=webp` | cover URLs | the cover image (the API hands this path out itself) |

Novel ids are 24-hex MongoDB ObjectIds. A novel row has the same shape in every list
endpoint and in `/api/novels/<id>`, except that `chapter_names` is always `[]` in
lists.

The URLs this source produces are the site's own page URLs, so any of them opens the
same thing in a browser:

- novel: `https://novelarchive.st/novel?id=<id>`
- chapter: `https://novelarchive.st/reader?novel=<id>&chapter=<n>`

`novelIdFromUrl` reads `id` or `novel` from the query string — the same two
parameters the site's novel page reads — so a novel URL, a reader URL, or either on
the `.cc` mirror all resolve. Anything else throws `SourceUrlError`.

## Quirks that cost real effort to discover

1. **Chapter `n` is position `n` in `chapter_names`.** The novel endpoint returns the
   names only, no numbers; the site's novel page numbers them `index + 1`
   (`namesToItems` in `novel-page.js`), and the chapter endpoint takes that number.
   Names are free-form and inconsistent (`"Chapter 1: Nightmare Begins"`, `"Chapter
   1 - 1"`, `"CH 1432"`, `"Epilogue"`, `"Vol 2 Chapter 7605: …"`), so nothing is ever
   parsed out of a name. A novel with no names at all falls back to `total_chapters`
   placeholders titled `"Chapter N"`, as the site does.

2. **The list can name chapters the archive does not have.** Lord of the Mysteries
   lists 1,438 names; the last four (`"Chapter 1435"` … `"Chapter 1438"`) answer
   `404 {"error":"Chapter does not exist"}`, and so do the novel's mirror sources —
   the site's own reader fails on them too. `getChapterContent` throws with the
   site's reason (`novelarchive: /api/novels/<id>/chapters/1435?prefetch=1 answered
   HTTP 404: Chapter does not exist.`); the importer turns that into a "failed to
   load" line for that one chapter. Every other novel checked (24 trending novels,
   first/middle/last chapter each) served all of its chapters.

3. **`?prefetch=1` on chapter reads.** It is the reader's own read-ahead form: the
   server skips counting a view and leaves out the novel's whole `chapter_names`
   list, which is most of the response for a long novel (27 KB of 37 KB for
   Shadow Slave's chapter 1). An import of thousands of chapters should neither
   inflate the site's view counts nor download the chapter list thousands of times.

4. **Search pagination has two traps.**
   - A page past the end is not empty: the API clamps it to the last page and serves
     that page again (`page=99` → `pagination.page: 4`). `search` compares the
     returned `pagination.page` with the one it asked for and returns an empty,
     `hasMore: false` result when they differ, instead of repeating cards.
   - Each page's match set is computed on its own: page 1 of `shadow` reports
     `total: 172`, page 2 reports `total: 196`, and one novel comes back on both. The
     source remembers the card URLs it has returned for the current query (per
     `Source` instance; page 1 resets it) and drops repeats from later pages.
   `hasMore` is `pagination.has_next`. Ranking is the server's: an exact title match
   comes first (`shadow slave` → Shadow Slave, then the fan-fics).

5. **The API is rate-limited and sometimes slow.** Every response carries
   `ratelimit-policy: 900;w=300` — 900 requests per 5 minutes per client — and one
   chapter is one request, so a long import can cross it when the site is answering
   quickly. A `429` is waited out for its `Retry-After` / `RateLimit-Reset` seconds
   (clamped to 1–300 s, 60 s when neither is usable) and retried up to 3 times, with
   a `warn` log each time, instead of failing every remaining chapter. During testing
   the API took 3–8 s per request, which keeps the importer's 4 workers well under
   the limit; requests also occasionally died with a TLS-handshake connection reset
   (roughly one in twenty), so a request that fails outright is retried twice (after
   1 s, then 2 s) before the error is reported.

6. **Home rows come from the API, not the server-rendered home page.** `/` does
   ship a server-rendered first paint of the hero and the rows, but it is a short,
   cached snapshot (1 hero novel, 2 picks, 4 updates); the site's `index-home.js`
   replaces it from the three endpoints above, and so does this source, asking for
   24 cards each. Editor's Choice has only about a dozen picks, several of them
   one-chapter MTL titles — that is what the site picks. The three rows load in
   parallel with `allSettled`, like the site: one failing row is logged at `warn`
   and left out; only all three failing throws.

## Not used: mirror sources

Some novels also exist in one or more "sources" (`GET /api/novels/<id>/sources`,
then `/sources/<source>/chapters` and `/sources/<source>/chapters/<n>`, which return
`content_html` with `<img>` tags). The site's novel page opens a novel flagged
`has_image_chapters` on its `preferred_source` mirror by default, because the main
archive stores text only. This source deliberately reads the main archive for every
novel instead:

- Mirror numbering does not line up with the archive. For *Got Dropped into a Ghost
  Story, Still Gotta Work* the archive has 635 chapters; the `fucknovelpia` mirror has
  374, its chapter 1 is the synopsis and cover, chapter 2 a table of contents, and
  chapter 3 the archive's chapter 1.
- Mirror text carries mojibake the archive copy does not.
- Falling back to a mirror for a missing archive chapter (as the site's reader does)
  would therefore risk silently serving the wrong chapter, and none of the missing
  chapters found (quirk 2) existed on a mirror anyway.

The cost: novels with `has_image_chapters: true` (common among Korean web novels)
import without their illustrations. Their text is complete.

## `getNovel` field mapping

| `SourceNovel` | API field |
|---|---|
| `title` | `title` (falls back to the id, never "Untitled") |
| `author` | `author`, with the site's placeholder `"Unknown"` mapped to `""` so the host localizes the empty case |
| `coverUrl` | `cover_url` → `novel_image` → `image_url`, made absolute; anything that is not a URL (the site's renderer also copes with inline base64) falls back to `/api/novels/<id>/cover` |
| `description` | `description` (plain text with blank-line paragraphs) |
| `tags` | `genres` split on commas, de-duplicated case-insensitively, minus the site's own non-genre categories (`NON_GENRE_TAGS` in `novel-page.js`: "Browse", "Completed Novels", …) and "Unknown" |
| `status` | `release_status` (or `ongoing`), capitalized: Ongoing / Completed / Hiatus |
| `meta` | Also known as (`associated_names`), Chapters, Views (`views_number`), Rating (`rating` / 5 with `rating_count`, only when rated), Latest release (`latest_release` unless "Unknown" — "Every 12.6 Day(s)", "15 hours ago", …), Updated (`updated_at` date) |
| `volumes` | one volume, "All Chapters", holding every chapter |

`language` is `"en"` and `direction` `"ltr"` for every novel. Some catalogue titles
are in other languages (the site's library has e.g. `[ES]` and `[PORTUGUESE-BRAZIL]`
uploads), but the API carries no per-novel language field to read.

The longest novel checked, *Poison Doctor's Cute Baby*, lists 8,754 chapters in a
~100 KB response — still one call, so there is nothing to make lazy.

## `getChapterContent`

Reads `chapter.url` back into `(novelId, n)` (it never trusts `chapter.id`), fetches
`/api/novels/<id>/chapters/<n>?prefetch=1`, and turns `chapter.content` into lines:

1. repair UTF-8 that was stored as Latin-1 (see below);
2. split on newlines — most novels separate paragraphs with a blank line, some with
   a single newline (the site renders those as `<br>`), so every non-empty line is a
   paragraph;
3. clean the lines (next section);
4. drop a leading `"Chapter N…"` line under 80 characters, exactly as the site's
   reader does (`trimLeadingHeading`), since it only repeats the chapter title.

A body that cleans down to nothing throws `chapter <n> of novel <id> has no text`
rather than returning an empty chapter that looks like a successful read.

## Cleaning chapter text (`src/clean.ts`)

The archive's text came from aggregator sites, and some of it still carries what
they stamped into it. Every rule exists because a live chapter showed it; a scan of
roughly 270 chapters across 100 novels (popular, longest, top-rated and newest)
found these:

| Leftover | Example (verbatim) | Handling |
|---|---|---|
| disguised watermark line | `Follow curr𝒆nt nov𝒆ls on fɾeeweɓnѳveɭ.com.` · `𝚏𝕣𝕖𝚎𝚠𝚎𝚋𝚗𝐨𝐯𝕖𝕝.𝕔𝐨𝕞` · `This chapter is updat𝙚d by f(r)eew𝒆bn(o)vel.com` | line dropped |
| watermark inside a story line | `The killing intent emanating °• N 𝑜 v 𝑒 l i g h t •° from them was intense.` · `their ◈ Nоvеlіgһт ◈ (Continue reading) children.` · `auzw.com "Ha." With a grin, …` · `"Black belt?" 𝐛𝐞𝗱𝗻𝐨𝐯𝗲𝗹.𝐜𝐨𝐦` | watermark cut out, story kept |
| promo tail on a story line | `\|Additional Boon: …\| ɪꜰ ʏᴏᴜ ᴡᴀɴᴛ ᴛᴏ ʀᴇᴀᴅ ᴍᴏʀᴇ ᴄʜᴀᴘᴛᴇʀs, ᴘʟᴇᴀsᴇ ᴠɪsɪᴛ Nove1Fire.net` | tail cut, system message kept |
| bracketed URL | `The [Liancheng www.wsx5.cn] branch of …` · `Fenglian [笔趣阁www.biqugeso.me] Ye Yu` | bracket group cut |
| aggregator promo line | `Remember [www.wuxiaspot.com] for one second, update fast, no pop-up window, free to read!` · `If you like the Dragon Emperor, please collect it: (www.novelbuddy.com) …` · `Table of Contents URL: https://www.mtlnovel.com/…` | line dropped |
| credits at the top | `Translator:` / `Nyoi-Bo Studio` / `Editor:` / `Nyoi-Bo Studio` · `Translator: Henyee Translations Editor: Henyee Translations` · `Proofread By:` / `Archbishop#750` · `TL: Hanguk` | dropped (first 8 lines only; a label alone takes its name line with it) |
| publisher notice | `This book is produced and distributed electronically by Zhangyue Technology authorized by Hongshu.com (Dejian)` / `all rights reserved` / `·` / `Infringement will be investigated` | block dropped |
| code fences | `` ```html `` … `` ``` `` | dropped |

How the watermark matching works:

- Each line is **folded** for matching: every character maps to one lowercase ASCII
  character where it has a look-alike — NFKD covers mathematical, fullwidth,
  Roman-numeral and accented letters (`𝒆`, `ｎ`, `Ⅰ`, `é`), and a table covers the
  Cyrillic, Greek, IPA and small-capital ones NFKD leaves alone (`о`, `ѳ`, `ɾ`,
  `ɓ`, `ɭ`, `ᴘ`, `ꜰ`, …). The fold keeps a per-character index map, so a match is
  cut out of the *original* line and the text around it is untouched.
- Brands are matched letter by letter with an optional space or parenthesis between
  letters (`N o v e l i g h t`, `f(r)eewebn(o)vel`) and the usual digit swaps
  (`Nove1Fire`). The list is in `BRANDS`; add to it when a new one turns up.
- A brand only counts as a watermark when it has a TLD glued on (`novelfire.net`),
  is disguised (any non-ASCII letter, digit swap or parenthesis inside it), or is
  wrapped in decoration (any Unicode symbol: `❖ ➤ ✪ ◈ ~ °• #`). A plain mention
  survives — a translator's afterword saying "after about a year on NovelFire." is
  kept as written.
- After cutting, a line with nothing readable left, or whose remainder is aggregator
  promo speak ("fastest", "latest chapters", "please collect", "free to read",
  "published on", …), is dropped. That promo test only runs on lines that carried a
  watermark or a URL, so ordinary story text never trips it; a bare reference URL in
  a translator's note (`https://en.m.wikipedia.org/wiki/…`) is kept.

### Mojibake

Some chapters were stored as UTF-8 decoded as Latin-1, with the C1 control
characters intact: one chapter opens 184 paragraphs with `â\x80\x83â\x80\x83`
(two em spaces), and a character sheet reads `âNationality: Japanese.` for
`○Nationality: Japanese.`.
`repairMojibake` re-decodes exactly those byte sequences — a UTF-8 lead byte
followed by the continuation bytes it announces — but only when the sequence holds a
C1 control (U+0080–U+009F), which never occurs in real text. `Ã©`-style pairs that
could be genuine are left alone. The repair also uncovers disguised watermarks that
were themselves mojibaked (`ðð¯ð¢…` → `𝐟𝐫𝐞𝐞𝐰𝐞𝐛𝐧𝐨𝐯𝐞𝐥.𝐜𝐨𝐦`), which the
watermark pass then removes.

## `searchChapters`

The site's own chapter filter (`renderChapters` in `novel-page.js`): a chapter
matches when its number or its lower-cased name contains the lower-cased query. It
runs over the same chapter list `getNovel` builds, reusing the novel `getNovel` just
fetched (one novel is cached per `Source` instance) instead of fetching it again.

## Errors

Every thrown error starts with the manifest id, `novelarchive: `. Non-2xx responses
carry the API's own reason when it sent one (`answered HTTP 404: Novel not found.`,
`… Chapter does not exist.`); a URL without a valid 24-hex id is rejected with
`SourceUrlError` before anything is fetched; a body that is not
JSON (a CDN error page) says so with its status; JSON of the wrong shape names the
endpoint (`did not return a novel list`, `did not return a novel`, `did not return a
chapter`).

## i18n

`src/strings.ts` (`en` + `ar`) holds what this source writes itself: the three home
row titles (the English ones are the site's own headings, which live in its markup
and JS rather than in the API), the volume title, the `"Chapter N"` fallback, and the
`meta` labels and rating format.

## Tests and fixtures

`tests/fixtures/` holds unedited API captures (2026-10-29), each named for what it
covers — the three home rows, search pages 1/2, a clamped page 99, an empty search,
the "shadow" page pair that overlaps, Shadow Slave and Lord of the Mysteries, the
`404` bodies, and one chapter per cleaning rule above. Expectations are derived from
the parsed fixtures wherever possible. To re-capture one:

```
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
curl -sS --compressed -A "$UA" \
  "https://novelarchive.st/api/novels/<id>/chapters/<n>?prefetch=1" \
  -o extensions/novelarchive/tests/fixtures/chapter-<what>.json
```

Live check: `PROBE_ID=novelarchive PROBE_QUERY="shadow" pnpm probe` (on Node 26 add
`NODE_OPTIONS=--no-experimental-webstorage`).
