# KolNovel — `extensions/kolnovel`

Site: <https://kolnovel.com> (ملوك الروايات)

This extension merges what used to ship as two separate Riwaq extensions —
a free mirror at `free.kolnovel.com` and the main paid-adjacent site at
`kolnovel.com` (internally "KolNovel Pro") — into one. The free mirror now
301-redirects to `kolnovel.com`, so the two sites are the same site today.
`canHandle` accepts every hostname either extension ever matched, so a URL
already saved in a user's library keeps resolving after the merge:

- `kolnovel.com`, `www.kolnovel.com` — the live site
- `free.kolnovel.com` — the retired free mirror, now a 301 to `kolnovel.com`
- `kolnovel.online` — a third domain the site's own "view more" links point
  at; treated as an alias, not fetched directly

Theme: a custom WordPress theme the site calls **starless**, live since
October 2026 (v1.1.0 of this extension). It replaced the previous theme
wholesale — every home, search and novel-page selector changed at once, and
chapter lists stopped being part of the novel page — so v1.0.x returns
nothing from this site. URLs did not change: novels are still
`/series/<slug>/` and chapters `/<slug>-<post id>/`, so books already in a
library keep resolving. `src/theme.ts` holds the DOM→data parsing (private
to this extension); `src/index.ts` wires it to `host` and owns the two
things the pages don't hand over in HTML: chapter lists and PDF-only
chapters.

## Capabilities

| Method                | Supported | Notes |
|-----------------------|-----------|-------|
| `getHomeSections`     | ✓         | every `section.kol-home-section` plus the hero grid — see **Home sections** |
| `search`              | ✓ (paginated) | `GET /?s=<q>`, then `/page/<N>/?s=<q>` — see **Search** |
| `getNovel`            | ✓         | `/series/<slug>/` — metadata plus every volume, **without** chapters |
| `hasLazyVolumes`      | `true`    | see **Chapter lists** |
| `getVolumeChapters`   | ✓         | the `kol_series_volume_chapters` AJAX action, 50 rows a page |
| `searchChapters`      | —         | no in-novel search on the site |
| `getChapterContent`   | ✓ (HTML + PDF fallback) | see **Chapter content** below; throws rather than return an empty chapter |

## Search

`GET https://kolnovel.com/?s=<query>` renders 20 matches a page as
`article.kol-search__item`; page N is `/page/<N>/?s=<query>`. `hasMore` comes
from WordPress's own pager — a `.next.page-numbers` link, or a numbered one
past the current page. (Verified live 2026-10-25: `سيد` has 21 matches, 20 on
page 1 with a pager, 1 on page 2 without one.)

The previous theme answered both pagination forms — and broad one-word
queries like `رواية` — with HTTP 500, so v1.0.x ignored `page` and always
reported `hasMore: false`. On this theme both work.

## Chapter lists

The novel page carries every volume's name and chapter count but **no
chapter rows**: each volume is an empty `<details data-kol-chapter-volume=
"<name>">` that the site's `series-chapters.js` fills when it is opened. The
request it makes, and the one this extension makes:

```
GET /wp-admin/admin-ajax.php?action=kol_series_volume_chapters
      &nonce=<data-kol-volume-nonce>&series_id=<data-kol-series-id>
      &volume=<data-kol-chapter-volume>&page=<n>
→ { "success": true,
    "data": { "html": "<li data-chapter-id=…>…", "page": 1, "pages": 56, "total": 2756, … } }
```

Facts about it, verified against the live site on 2026-10-25:

- **50 rows a page, fixed.** `per_page`, `posts_per_page` and `limit` are all
  ignored. A 2,756-chapter volume is 56 requests; `getVolumeChapters` reads
  page 1 for the page count and fetches the rest six at a time (a 6,703-
  chapter, 15-volume novel loads in ~85s volume after volume, the bulk of it
  that one 2,756-chapter volume at ~12s).
- **The nonce is required.** Without it, or with a wrong one, the endpoint
  answers **HTTP 403** with the bare body `-1`
  (`tests/fixtures/volume-bad-nonce.json`). It is a WordPress nonce for the
  anonymous user, so it is the same on every novel page and expires within a
  day. `getVolumeChapters` treats a refusal as a stale nonce: it reloads the
  novel page once and retries before failing.
- **The empty string is a real volume name.** It is the site's "no volume"
  bucket, titled `الفصول`.
- **Volumes and rows are newest first**; both are reversed, so volume 1 /
  chapter 1 come first in reading order.

Chapter ids run across the whole novel, oldest volume first: a volume's first
id is one past the sum of the counts of every volume before it. That keeps a
chapter's id independent of which volume the app loads first, and matches
the running numbering v1.0.x produced when the old page listed every chapter
inline. The volume is found by its name (`SourceVolume.key`), not its
position, so a snapshot whose ids were assigned on an earlier visit still
loads the right one. `getVolumeChapters` works cold — the app calls it for a
saved novel without a `getNovel` first — by fetching the novel page for the
series id and nonce.

A row's title is `الفصل <number> - <name>` from its `data-kol-chapter-number`
and `data-kol-chapter-title`. The number is free text on the site — special
chapters carry `---` or `1INFO1` — and only a real number becomes the
prefix; otherwise the name stands alone. Rows under a release countdown
(`[data-kol-countdown-end]`) are skipped: they name chapters that are not
readable yet.

## Chapter content

`getChapterContent` reads HTML first: it fetches the chapter page and runs
`parseChapterContent` (in `theme.ts`) against `#kol_content` (falling back to
`.epcontent`, then `.entry-content`, then `<body>`). On the starless theme the
body element is `<div id="kol_content" class="epcontent entry-content">` —
the one container that survived the redesign unchanged. Most chapters return
their full text this way — official illustrations included, served inline as
`<img>` — with no PDF round-trip at all.

**Unclosed `<p>` tags.** Some chapter bodies open paragraphs they never close
(`<p>` + newline + `<p>text</p>`; `tests/fixtures/chapter-starless.html`). A
spec HTML parser — the app's — closes the open one at the next `<p>`, but
happy-dom nests them, and a paragraph's `textContent` then holds the whole
rest of the chapter: the live probe read 132 lines and 337,043 characters
out of a 10 KB chapter. A paragraph's text is therefore read with any nested
`<p>` removed; each nested one is visited on its own.

**The PDF token endpoint is broken on the site as of 2026-10-25:** `POST
action=ts_ln_dl_url` answers HTTP 500 with WordPress's "critical error" page.
No chapter reached while porting to the new theme was PDF-only, so the
fallback below is kept as it was; a chapter that does reach it now fails with
the non-JSON error (reporting the HTTP 500) rather than with an empty page.

Some chapters on `kolnovel.com` ship **only** as a downloadable PDF (no
usable HTML body). When the HTML pass yields zero lines, `getChapterContent`
falls back to the site's token-gated download flow:

1. `POST /wp-admin/admin-ajax.php` with `action=ts_ln_dl_url&post_id=<id>`
   (the numeric id trailing the chapter's permalink) → `{ error: 0, url:
   "https://kolnovel.com/<chapter>/pdf/?tspdftoken=<token>" }`. The returned
   url is resolved against the site origin before use — see **Token-flow
   failures** below for why that is not paranoia.
2. `GET` that tokenized URL → the PDF bytes. `assertPdf` checks the `%PDF`
   magic bytes before proceeding, since an expired/invalid token makes the
   endpoint return an HTML error/login page instead of a file. The length
   bound is `>= 4`, which is what reading bytes 0-3 actually needs. This is a
   magic-byte check and not a `Content-Type` check because the extension
   cannot see the content type at all: `SourceHost.fetchBytes` returns a bare
   `Promise<Uint8Array>` with no headers beside it (only the text `fetch`
   returns a `FetchResponse` carrying `headers`). The first four bytes are the
   only evidence this path has.
3. The bytes go to **`host.pdf.extractChapter(bytes, { chapterUrl,
   novelTitle, mintImageRef })`** — this extension never parses PDF bytes
   itself. `pdf.js` is too heavy to bundle per-extension (the build enforces
   a 512 KB bundle ceiling specifically to catch that mistake), so the host
   owns the single shared instance.
4. Images `host.pdf.extractChapter` pulls out of the PDF are minted an
   opaque ref (`kolnovel:img:<postId>:<n>`) and stashed in an in-memory
   `imageStore` map; `resolveImage(ref)` reads them back out for the host to
   package. This mirrors how any source emits an image `SourceLine` whose
   `content` is not a directly-fetchable URL — see `resolveImage` on
   `Source` in `@riwaq/extension-api`. The map is cleared at the start of
   every PDF extraction, so it holds one chapter's images rather than a
   session's: a ref is valid only until the next `getChapterContent` call on
   the same instance, which is the lifetime `Source.resolveImage` documents.
   It used to be cleared only in `getNovel`, which a reader working through
   an already-imported snapshot never calls.

There is no length heuristic gating the HTML-vs-PDF choice: a real chapter's
HTML body can legitimately be short or image-heavy, and guessing from length
would wrongly route those to the PDF endpoint (which fails for HTML-only
chapters). "Zero lines extracted" is the only trigger for the PDF fallback.

### Never a hollow chapter, and never a hollow novel

If the HTML body parses to nothing *and* the PDF extracts to nothing,
`getChapterContent` **throws**, naming the chapter URL. It does not return an
empty `lines` array. An empty chapter is imported silently and drawn by the
reader as a blank page, indistinguishable from a chapter that is genuinely
empty — there is no layer above this one that can tell the difference, so the
refusal has to happen here. A genuinely empty *search* result is a different
thing and returns empty without throwing.

`parseNovelPage` applies the same ruling to a novel page: `title` falls back
to `""`, `tags` to `[]` and `volumes` to `[]`, so a blocked or errored page
served with HTTP 200 would otherwise produce a structurally valid but
completely empty `SourceNovel` that imports as a book with no chapters. It
**throws** when no title can be read, naming the page URL. A real novel page
that simply has no chapters listed yet is *not* refused — that is a page the
site legitimately serves.

### Dedup is adjacency-only, not whole-chapter

`parseChapterContent` dedups a line only against the immediately-preceding
line of the same type, not against every line seen earlier in the chapter.
A whole-chapter `Set` silently deletes a legitimately repeated short
paragraph — a one-word interjection reused at unrelated points in the
narrative — from the imported book. That is not hypothetical: `extensions/
cenele` hit exactly this on a live capture (three unrelated one-word
paragraphs, all identical, two of them dropped) and its README records it.
No loss is demonstrated in kolnovel's own live capture — `chapter-live.html`
yields 163 kept paragraphs, all distinct, so both strategies produce
identical output there — so this is the known-good fix ported before the
site hands us the case. See the comment at the dedup site for the known
limitation the trade-off accepts, and the test that pins the difference.

### Token-flow failures

The three ways the token request can fail are three separate errors, because
they have three different causes and three different fixes. They were one
message until v1.0.1 — `"members-only or removed"` — which named a cause the
code had not established. Verified against the live endpoint on 2026-09-18,
and each response committed as a fixture under `tests/fixtures/`:

| Request | Response | Extension's behaviour |
|---|---|---|
| `post_id=293246` (a real chapter) | `{"error":0,"url":"https://kolnovel.com/…/pdf/?tspdftoken=…"}` | downloads it |
| `post_id=` (empty) or a non-numeric id | `{"error":403,"url":""}` | throws naming **error code 403** |
| `post_id=999999999` (unknown id) | `{"error":0,"url":"/pdf/?tspdftoken=…"}` | resolves the **root-relative** url against the origin, then fails the `%PDF` check |
| — (synthetic) | `{"error":0}` | throws: reported success, **no download url** |
| — (synthetic) | a non-JSON body | throws, reporting the **HTTP status** |

The third row is the surprising one and the reason the url is resolved rather
than forwarded: for a post id the site does not recognise it answers *success*
and hands back a root-relative url with the novel segment missing. Passing
that string to `host.fetchBytes` would ask the host to fetch a relative URL;
resolving it yields a real absolute URL whose failure is then reported
accurately by `assertPdf`.

`assertPdf`'s message reports the chapter URL and a short description of what
actually arrived (`1153 bytes starting "<html>"`), so a user forwarding the
error and a maintainer reading it later can tell an HTML loader page from an
empty body from a CDN challenge without re-running the download.

## Why static fetch is enough

The visible chapter body is not JS-injected — it ships server-rendered in
the initial HTML — and the one thing the site does load from JS, a volume's
chapter list, is a plain GET returning JSON. What some JS on the old theme's
page *did* inject are invisible decoy paragraphs meant to defeat copy-paste (rotating
hex CSS classes with `opacity: 0` + `-99999px` positioning, or an inline
`position: fixed; ...; text-indent: ...` variant). `parseChapterContent`
discovers the rotating hidden classes from the page's own `<style>` blocks
and filters matching `<p>` elements, plus strips any surviving fragments of
the site's own "read us only at kolnovel.com" ad string via
`IGNORED_PATTERNS`. No headless rendering is needed for any of this, so the
extension works on any host that implements the static-fetch capability.

## Card-URL filtering

Every card on the theme — home rails and search results alike — carries one
hook: an element marked `data-kol-series-title-source` whose text is the
title and whose `href` is the series URL (on the homepage hero's `<h1>`, the
URL is in `data-kol-series-title-url` instead). Cards are read through that
hook rather than through each rail's own layout classes, and only hooks
pointing at `/series/<slug>/` become cards — never the bare `/series/`
listing or a chapter — because a host UI navigates a card click to a novel
detail view. The cover is the first `<img>` in the card's `article`/`li`.

## Home sections

| Rail (class)                 | id            | Notes |
|------------------------------|---------------|-------|
| `section.kol-home-hero-grid` | `hero-grid`   | the featured novel plus the "rising" list beside it, titled by that list's `<h2>` |
| `.kol-home-rising-kings`     | `rising-kings` | "trending this week" carousel; its cover is a `<button>`, the title hook is in the details panel |
| `.kol-home-updates`          | `updates`     | latest-updates rows; the newest chapter link (`.kol-home-chapter-links a`) is the card's subtitle |
| `.kol-home-most-read`        | `most-read`   | rankings by total reads |
| `.kol-home-newly-added`      | `newly-added` | |
| `.kol-home-completed`        | `completed`   | |

**Section ids are derived from the section, never from its position.**
`SourceSection.id` is contracted to be stable and useful for caching, so each
rail is keyed by its `kol-home-<name>` modifier class (falling back to a slug
of its heading). A document-order `home-<idx>` reindexes every rail below one
that rendered nothing that run; `extensions/cenele` abandoned that scheme for
the same reason. The community blocks (stats, donors, translator
leaderboards) are `section`s without `kol-home-section` and carry no novel
cards. A rail's "view all" link (`a.kol-home-section-link`) becomes its
`viewMoreUrl`, resolved with `absoluteUrl(href, baseUrl)` rather than the
anchor's `.href` — a `DOMParser` document has no real location to resolve
against. A card's rating (`★ 9.1`, from whichever element in it has a
`rating` class) becomes its one badge.

## Novel-page selectors

| Field          | Selector |
|----------------|----------|
| Title          | `h1.kol-series-editorial__title` (**no title at all is a refusal**, see [Never a hollow chapter, and never a hollow novel](#never-a-hollow-chapter-and-never-a-hollow-novel)) |
| Original title | `.kol-series-editorial__alt-title` — the site sometimes puts a release-schedule note here instead; it is passed through as-is |
| Status         | `.kol-series-editorial__status` — kept as the site's own text |
| Cover image    | `.kol-series-editorial__cover img` |
| Meta rows      | `<dt>`/`<dd>` pairs in `.kol-series-editorial__quick-facts` (chapters, year, language, views) and `.kol-series-editorial__facts` (type), plus the translators (`.kol-series-translators__label strong`) as one row |
| Author         | a meta row labelled `الكاتب` / `المؤلف` / `writer` / `author` — the theme prints none today, so `author` is `""` and the host localizes its own fallback |
| Tags           | `.kol-series-editorial__genres a` |
| Synopsis       | `.kol-series-editorial__prose` — scripts, styles and the donation widget the theme appends to every synopsis (`.shola-widget`) stripped first |
| Volumes        | `[data-kol-chapter-index]` → `details[data-kol-chapter-volume]`; see **Chapter lists** |

## i18n

This extension ships three of its own fallback strings in `src/strings.ts`,
used only when the site itself doesn't label something:

- `volumeFallback` — a volume with no title text (`"Volume {n}"` / `"المجلد {n}"`)
- `chapterNoTitleFallback` — a chapter whose scraped title is empty after
  sanitizing (`"{n} - No Title"` / `"{n} - بلا عنوان"`)
- `trendingFallback` — a home rail with neither an `<h2>` nor an
  `aria-label` (`"Trending"` / `"الرائج"`)

These values match what Riwaq shipped before the extensions were split out
of the app, so books imported under the old in-app sources keep the same
text. An extension cannot reach the app's message catalogue — it reads `host.locale` (`"en" | "ar"`) and picks from its own
small catalogue instead.

## Fetch-only, no ambient authority

`getHomeSections`, `search`, `getNovel`, `getVolumeChapters` and the HTML pass of
`getChapterContent` use only `host.fetch`. The PDF fallback additionally
uses `host.fetchBytes` and `host.pdf.extractChapter` — both host
capabilities, never a bundled dependency. This extension has no
`renderAndExtract` dependency.
