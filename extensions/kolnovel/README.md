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

Theme: a custom WordPress build; mostly static — the browse, search and
novel pages ship their data in the initial HTML. `src/theme.ts` holds the
DOM→data parsing (private to this extension); `src/index.ts` wires it to
`host` and owns the one thing the theme doesn't hand over in HTML: PDF-only
chapters.

## Capabilities

| Method                | Supported | Notes |
|-----------------------|-----------|-------|
| `getHomeSections`     | ✓         | parses `.trendarea`, `.homehot`, `.bixbox + .listupd` |
| `search`              | ✓ (unpaginated) | `GET /?s=<q>` only — see **Search** below |
| `getNovel`            | ✓         | `/series/<slug>/` — `.sertobig` + `.ts-chl-collapsible` |
| `searchChapters`      | —         | no in-novel search on the site |
| `getChapterContent`   | ✓ (HTML + PDF fallback) | see **Chapter content** below |

## Search

`search()` always issues `GET https://kolnovel.com/?s=<query>` — nothing
else. It ignores its `page` argument and **always returns `hasMore: false`**,
for two site facts verified against the live site:

- The site renders every match on a single page — there is no numeric
  pager on this template.
- Both pagination forms return **HTTP 500**: `?s=<q>&paged=<N>` and
  `/page/<N>/?s=<q>`. `parseSearchResults` (in `theme.ts`) still derives an
  independent `hasMore` reading from the theme's `.pagination` block —
  because on broad queries the theme *does* render a pager even though
  clicking through it 500s — so `index.ts`'s `search()` deliberately
  discards that reading and hardcodes `false` rather than trusting the DOM.
  `tests/kolnovel.test.ts` pins both the true-from-DOM and the
  false-forced-by-the-extension cases so this override can't quietly regress.

**The site also 500s on broad queries.** This isn't a hypothetical edge
case: a live-site check recorded in this repo's `docs/design.md` ("Field
findings — 2026-08-27" → kolnovel.com) found that the single-word queries
`رواية` and `ال` each produced a WordPress error page, while the narrower
query `سيد` returned 21 results. A host UI calling `search()` needs a
first-class error state for whatever `host.fetch` surfaces on a 500 — this
extension does not retry or paper over it.

## Chapter content

`getChapterContent` reads HTML first: it fetches the chapter page and runs
`parseChapterContent` (in `theme.ts`) against `.epcontent` (falling back to
the older `#kol_content` markup, then `.entry-content`, then `<body>`). Most
chapters return their full text this way — official illustrations included,
served inline as `<img>` — with no PDF round-trip at all.

Some chapters on `kolnovel.com` ship **only** as a downloadable PDF (no
usable HTML body). When the HTML pass yields zero lines, `getChapterContent`
falls back to the site's token-gated download flow:

1. `POST /wp-admin/admin-ajax.php` with `action=ts_ln_dl_url&post_id=<id>`
   (the numeric id trailing the chapter's permalink) → `{ error: 0, url:
   "https://kolnovel.com/<chapter>/pdf/?tspdftoken=<token>" }`.
2. `GET` that tokenized URL → the PDF bytes. `assertPdf` checks the `%PDF`
   magic bytes before proceeding, since an expired/invalid token makes the
   endpoint return an HTML error/login page instead of a file.
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
   `Source` in `@riwaq/extension-api`.

There is no length heuristic gating the HTML-vs-PDF choice: a real chapter's
HTML body can legitimately be short or image-heavy, and guessing from length
would wrongly route those to the PDF endpoint (which fails for HTML-only
chapters). "Zero lines extracted" is the only trigger for the PDF fallback.

## Why static fetch is enough

The visible chapter body on this theme is not JS-injected — it ships
server-rendered in the initial HTML. What some JS on the live page *does*
inject are invisible decoy paragraphs meant to defeat copy-paste (rotating
hex CSS classes with `opacity: 0` + `-99999px` positioning, or an inline
`position: fixed; ...; text-indent: ...` variant). `parseChapterContent`
discovers the rotating hidden classes from the page's own `<style>` blocks
and filters matching `<p>` elements, plus strips any surviving fragments of
the site's own "read us only at kolnovel.com" ad string via
`IGNORED_PATTERNS`. No headless rendering is needed for any of this, so the
extension works on any host that implements the static-fetch capability.

## Card-URL filtering

KolNovel surfaces both novel-index URLs (`/series/<slug>/`) and direct
chapter URLs in the same homepage rows. Every card parser filters on
`/series/` in the href so only novel-index links become cards — a host UI
is expected to navigate a card click to a novel detail view, not a chapter.

## Home section shapes

| Class        | Cards under         | Notes |
|--------------|----------------------|-------|
| `.trendarea` | `.trendlist`         | "Trending" hero list; falls back to the extension's own `trendingFallback` string when the theme omits a heading |
| `.homehot`   | `.hotoday`           | "Hot updates" big-card row; falls back to `hotUpdatesFallback` |

A `.bixbox` section's optional "view more" link (`.releases .vl`) is
resolved with `absoluteUrl(href, baseUrl)`, deliberately **not** by reading
the anchor element's `.href` property. A `DOMParser`-produced `Document`
has no real page location — its base URL is `about:blank` — so a relative
`href` there cannot resolve the way it would on a live page; per the
`HTMLHyperlinkElementUtils` spec, `.href` then falls back to returning the
raw, unresolved attribute string instead of an absolute URL (some DOM
implementations, e.g. the happy-dom environment this repo tests under,
substitute their own fake page location instead — the effect is the same
kind of wrong URL, just a different wrong URL). This differs from what the
pre-split app's `kolnovel-theme.ts` did (it read `.href` directly) — that
was a latent bug carried over from the original app, not a porting mistake,
and the fix here is deliberate. `tests/kolnovel.test.ts`'s
`parseHomeSections` suite pins a fixture with a relative `viewMoreUrl` href
specifically to guard against this being "restored" by a future edit.
| `.bixbox`    | `.listupd` (`.utao` or `article.bs` cards) | most other sections — completed novels, recommendations, new novels, … Sidebar/blog widgets sharing `.bixbox` are skipped by checking for `.blogbox, .lexa` |

## Novel-page selectors

| Field          | Selector |
|----------------|----------|
| Title          | `.sertobig h1.entry-title` (falls back to a bare `h1.entry-title`) |
| Original title | `.sertobig .alter` |
| Status         | `.sertobig .sertostat > span` — kept as the site's own text; a host UI renders it verbatim as a badge |
| Cover image    | `.sertobig .sertothumb img` |
| Meta rows      | `.sertobig .serl`, each `<div><span class="sername">label</span><span class="serval">value</span></div>` |
| Author         | meta row labeled `الكاتب` / `writer` / `author` |
| Tags           | `.sertobig .sertogenre a` |
| Synopsis       | `.sertobig .sersys.entry-content` (or `.sersys`) — ad/script wrappers stripped before extraction |
| Volumes        | `.ts-chl-collapsible` headers + their `.ts-chl-collapsible-content` sibling's `ul li > a` (direct-child anchors only — a per-chapter PDF download link some chapters also render is a nested, non-direct-child anchor and is excluded so it isn't parsed as a phantom chapter) |

The page lists volumes and chapters newest-first; `parseVolumes` reverses
both so volume 1 / chapter 1 come first, matching reading order.

## i18n

This extension ships four of its own fallback strings in `src/strings.ts`,
used only when the site itself doesn't label something:

- `volumeFallback` — a volume with no title text (`"Volume {n}"` / `"المجلد {n}"`)
- `chapterNoTitleFallback` — a chapter whose scraped title is empty after
  sanitizing (`"{n} - No Title"` / `"{n} - بلا عنوان"`)
- `trendingFallback` — the `.trendarea` section when the theme omits its
  heading (`"Trending"` / `"الرائج"`)
- `hotUpdatesFallback` — the `.homehot` section under the same condition
  (`"Hot updates"` / `"تحديثات رائجة"`)

These values match what Riwaq shipped before the extensions were split out
of the app, so books and cached sections imported under the old in-app
sources keep the same text. An extension cannot reach the app's message
catalogue — it reads `host.locale` (`"en" | "ar"`) and picks from its own
small catalogue instead.

## Fetch-only, no ambient authority

`getHomeSections`, `search`, `getNovel` and the HTML pass of
`getChapterContent` use only `host.fetch`. The PDF fallback additionally
uses `host.fetchBytes` and `host.pdf.extractChapter` — both host
capabilities, never a bundled dependency. This extension has no
`renderAndExtract` dependency.
