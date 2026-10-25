// KolNovel page parsers — DOM→data for the site's "starless" WordPress theme
// (kolnovel.com moved to it in October 2026; every home, search and novel
// selector of the previous theme vanished at once). `parseChapterContent`
// handles chapter bodies, which kept their `#kol_content.epcontent` container
// across the switch; the PDF path — token fetch, download,
// host.pdf.extractChapter — is owned by index.ts, this module only ever sees
// HTML.
//
// Every novel card on the theme, on every page, carries the same hook: an
// element marked `data-kol-series-title-source` whose text is the title and
// whose `href` (or, on the homepage hero's <h1>, `data-kol-series-title-url`)
// is the series URL. Cards are read through that one hook rather than through
// each rail's own layout classes, of which the homepage alone has six.

import {
  absoluteUrl,
  sanitizeText,
  type NovelCard,
  type SourceChapter,
  type SourceHost,
  type SourceLine,
  type SourceNovel,
  type SourceNovelMeta,
  type SourceSearchResult,
  type SourceSection,
  type SourceVolume,
} from "@riwaq/extension-api";
import { strings } from "./strings";

// ── cards ───────────────────────────────────────────────────────────────────

const TITLE_SOURCE = "[data-kol-series-title-source]";

/** A series index URL, `/series/<slug>/` — not the bare `/series/` listing
 *  and not a chapter permalink. Only these become cards: a card click opens
 *  a novel detail view. */
function isSeriesUrl(href: string): boolean {
  return /\/series\/[^/?#]+/.test(href);
}

function titleSourceUrl(el: Element): string {
  return el.getAttribute("href") || el.getAttribute("data-kol-series-title-url") || "";
}

/** One card per title hook under `scope`, in document order, de-duplicated by
 *  URL (the hero novel is usually also first in the list beside it). `extra`
 *  adds what only one rail renders — a subtitle, badges. */
function readCards(
  scope: Element,
  baseUrl: string,
  extra?: (container: Element) => Partial<NovelCard>,
): NovelCard[] {
  const cards: NovelCard[] = [];
  const seen = new Set<string>();
  for (const source of Array.from(scope.querySelectorAll(TITLE_SOURCE))) {
    const href = titleSourceUrl(source);
    if (!isSeriesUrl(href)) continue;
    const url = absoluteUrl(href, baseUrl);
    if (seen.has(url)) continue;
    const title = sanitizeText(source.textContent);
    if (!title) continue;
    seen.add(url);
    const container = source.closest("article, li") ?? source.parentElement ?? source;
    const card: NovelCard = {
      url,
      title,
      coverUrl: pickImageSrc(container.querySelector("img") as HTMLImageElement | null, baseUrl),
    };
    const rating = ratingOf(container);
    if (rating) card.badges = [`★ ${rating}`];
    cards.push({ ...card, ...extra?.(container) });
  }
  return cards;
}

/** The rating the theme renders beside a card as `★ 8.5`, from whichever
 *  element carries a `rating` class (each rail names its own). */
function ratingOf(container: Element): string | undefined {
  const el = container.querySelector("[class*='rating']");
  const m = sanitizeText(el?.textContent).match(/\d+(?:\.\d+)?/);
  return m ? m[0] : undefined;
}

// ── home-page parsing ───────────────────────────────────────────────────────

export function parseHomeSections(doc: Document, baseUrl: string, host: SourceHost): SourceSection[] {
  // Rails in document order: the hero grid (featured novel + "rising" list)
  // and every `section.kol-home-section` — weekly trending, updates, rankings,
  // newly added, completed. The community blocks (stats, donors, translator
  // leaderboards) are separate `section`s without that class and carry no
  // novel cards.
  const sections: SourceSection[] = [];
  const usedIds = new Set<string>();
  for (const el of Array.from(doc.querySelectorAll("section.kol-home-hero-grid, section.kol-home-section"))) {
    const cards = readCards(el, baseUrl, (container) => {
      // Update rows list their latest chapters; the newest is the subtitle.
      const latest = sanitizeText(container.querySelector(".kol-home-chapter-links a")?.textContent);
      return latest ? { subtitle: latest } : {};
    });
    if (cards.length === 0) continue;
    const viewMore = el.querySelector("a.kol-home-section-link, header a.kol-ui-button") as HTMLAnchorElement | null;
    const viewMoreHref = viewMore?.getAttribute("href") || "";
    sections.push({
      id: uniqueSectionId(sectionIdFor(el), usedIds),
      title:
        sanitizeText(el.querySelector("h2")?.textContent) ||
        sanitizeText(el.getAttribute("aria-label")) ||
        strings(host.locale)("trendingFallback"),
      cards,
      viewMoreUrl: viewMoreHref ? absoluteUrl(viewMoreHref, baseUrl) : undefined,
    });
  }
  return sections;
}

/** Collapse a heading into a stable, printable id fragment: keep letters
 *  and digits of ANY script (these headings are Arabic) and turn every run
 *  of anything else into one dash. */
function slugify(text: string): string {
  return text
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

/** A section's `id`, derived from WHAT THE SECTION IS rather than from
 *  where it happened to land in the list.
 *
 *  `SourceSection.id` is contracted to be a stable identifier useful for
 *  caching (see @riwaq/extension-api). A document-order `home-${idx}`
 *  reindexes every section below any row that happened to render no cards
 *  on a given run, so yesterday's `home-2` is today's `home-1` and every
 *  cache keyed on it is silently wrong. extensions/cenele abandoned exactly
 *  this scheme for exactly this reason.
 *
 *  Each rail carries a modifier class naming it — `kol-home-updates`,
 *  `kol-home-completed`, `kol-home-hero-grid` — so that is the key, minus
 *  the prefix. A rail without one falls back to a slug of its heading. */
function sectionIdFor(el: Element): string {
  for (const cls of Array.from(el.classList)) {
    const m = cls.match(/^kol-home-([a-z0-9-]+)$/);
    if (m && m[1] !== "section") return m[1];
  }
  return slugify(sanitizeText(el.querySelector("h2")?.textContent)) || "section";
}

/** Two sections could in principle derive the same key. Ids must stay
 *  distinct within one response, so a collision gets a numeric suffix —
 *  deterministic, and only ever affecting the duplicate. */
function uniqueSectionId(base: string, used: Set<string>): string {
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
}

// ── search-page parsing ─────────────────────────────────────────────────────
//
// `GET /?s=<q>` renders 20 matches a page; later pages are `/page/<N>/?s=<q>`.
// (The previous theme answered both pagination forms with HTTP 500; this one
// serves them — verified live 2026-10-25.)

export function parseSearchResults(
  doc: Document,
  baseUrl: string,
  query: string,
  page: number,
): SourceSearchResult {
  const cards: NovelCard[] = [];
  for (const item of Array.from(doc.querySelectorAll("article.kol-search__item"))) {
    const [card] = readCards(item, baseUrl, (container) => {
      const excerpt = sanitizeText(container.querySelector(".kol-search__excerpt")?.textContent);
      const genres = sanitizeText(container.querySelector(".kol-search__genres")?.textContent)
        .split("·")
        .map((g) => g.trim())
        .filter((g) => g.length > 0);
      return {
        subtitle: excerpt || undefined,
        badges: genres.length > 0 ? genres : undefined,
      };
    });
    if (card) cards.push(card);
  }

  // WordPress's pager: a `.next.page-numbers` link, or a numbered link past
  // the current page — accept either signal.
  let hasMore = false;
  for (const pl of Array.from(doc.querySelectorAll("a.page-numbers"))) {
    const n = parseInt(sanitizeText(pl.textContent), 10);
    if (pl.classList.contains("next") || (!Number.isNaN(n) && n > page)) {
      hasMore = true;
      break;
    }
  }

  return { cards, hasMore, query, page };
}

// ── novel-page parsing ──────────────────────────────────────────────────────

/** What a novel page hands over for loading its chapter lists. The theme
 *  ships no chapter rows in the page itself: each volume is an empty
 *  `<details>` that fills itself from `admin-ajax.php` when opened, keyed by
 *  the series id, the volume's own name, and a nonce printed on the page. */
export interface ChapterIndex {
  seriesId: string;
  nonce: string;
  ajaxUrl: string;
  /** Oldest first — the page lists them newest first. */
  volumes: { key: string; title: string; count: number }[];
}

export function parseChapterIndex(doc: Document, baseUrl: string): ChapterIndex | null {
  const root = doc.querySelector("[data-kol-chapter-index]");
  if (!root) return null;
  const seriesId = root.getAttribute("data-kol-series-id") || "";
  const nonce = root.getAttribute("data-kol-volume-nonce") || "";
  if (!seriesId || !nonce) return null;
  const volumes = Array.from(root.querySelectorAll("[data-kol-chapter-volume]")).map((v) => ({
    // The empty string is a real key: it names the "no volume" bucket.
    key: v.getAttribute("data-kol-chapter-volume") ?? "",
    title: sanitizeText(v.querySelector(".kol-series-editorial__volume-title")?.textContent),
    count: parseCount(v.querySelector(".kol-series-editorial__volume-count")?.textContent),
  }));
  return {
    seriesId,
    nonce,
    ajaxUrl: absoluteUrl(root.getAttribute("data-kol-volume-url") || "/wp-admin/admin-ajax.php", baseUrl),
    volumes: volumes.reverse(),
  };
}

/** "2٬756 فصل" → 2756. The theme prints counts with the Arabic thousands
 *  separator, and may print Arabic-Indic digits. */
function parseCount(text: string | null | undefined): number {
  const digits = (text ?? "")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/\D/g, "");
  return digits ? parseInt(digits, 10) : 0;
}

export function parseNovelPage(
  doc: Document,
  baseUrl: string,
  pageUrl: string,
  host: SourceHost,
): SourceNovel {
  const page = doc.querySelector(".kol-series-editorial") ?? doc;

  // Never a literal "Untitled": either a real title, or this function
  // refuses outright (see the guard below). A locale-frozen literal must
  // never get baked into the novel's persisted data.
  const title = sanitizeText(page.querySelector("h1.kol-series-editorial__title, h1[itemprop='name']")?.textContent);

  // A page that yields no title at all — a layout change, an anti-bot
  // interstitial or an error page served with HTTP 200, a redirect that
  // landed somewhere else — must not silently produce a structurally
  // valid but empty SourceNovel that imports as a book with no title and no
  // chapters. Refuse loudly instead, naming the page. Deliberately NOT
  // extended to "no volumes": a real novel with no chapters published yet
  // is a thing this site can legitimately serve.
  if (!title) {
    throw new Error(
      `kolnovel: couldn't find a novel title on ${pageUrl} (h1.kol-series-editorial__title is ` +
        "missing or empty) — the layout may have changed, or this page was blocked/errored " +
        "despite an HTTP 200.",
    );
  }

  // Definition-list rows: the quick facts under the title (chapters, year,
  // language, views) and the facts panel (type). Each becomes a meta row; a
  // row labelled as the writer also becomes the author. Empty (not "Unknown
  // author") when there is none — the theme currently prints no author at
  // all — so the host's own display-time fallback can localize it.
  const meta: SourceNovelMeta[] = [];
  let author = "";
  for (const row of Array.from(page.querySelectorAll(".kol-series-editorial__quick-facts > div, .kol-series-editorial__facts dl > div"))) {
    const label = sanitizeText(row.querySelector("dt")?.textContent);
    const dd = row.querySelector("dd");
    if (!label || !dd) continue;
    const links = Array.from(dd.querySelectorAll("a"));
    const value = links.length > 0 ? links.map((a) => sanitizeText(a.textContent)).join("، ") : sanitizeText(dd.textContent);
    if (!value) continue;
    meta.push({
      label,
      value,
      url: links.length === 1 ? absoluteUrl(links[0].getAttribute("href") || "", baseUrl) : undefined,
    });
    if (/كاتب|مؤلف|writer|author/i.test(label) && !author) author = value;
  }
  const translators = Array.from(page.querySelectorAll(".kol-series-translators__label strong"))
    .map((s) => sanitizeText(s.textContent))
    .filter((s) => s.length > 0);
  if (translators.length > 0) {
    meta.push({
      label: sanitizeText(page.querySelector(".kol-series-translators__name")?.textContent) || "المترجمون",
      value: translators.join("، "),
    });
  }

  const descEl = page.querySelector(".kol-series-editorial__prose[itemprop='description'], .kol-series-editorial__prose");
  const index = parseChapterIndex(doc, baseUrl);

  return {
    title,
    author,
    originalTitle: sanitizeText(page.querySelector(".kol-series-editorial__alt-title")?.textContent) || undefined,
    language: "ar",
    direction: "rtl",
    coverUrl: pickImageSrc(page.querySelector(".kol-series-editorial__cover img") as HTMLImageElement | null, baseUrl),
    description: descEl ? extractDescriptionText(descEl) || undefined : undefined,
    tags: Array.from(page.querySelectorAll(".kol-series-editorial__genres a"))
      .map((a) => sanitizeText(a.textContent))
      .filter((s) => s.length > 0),
    status: sanitizeText(page.querySelector(".kol-series-editorial__status")?.textContent) || undefined,
    meta,
    volumes: (index?.volumes ?? []).map<SourceVolume>((v, i) => ({
      id: i + 1,
      title: v.title || strings(host.locale)("volumeFallback", { n: i + 1 }),
      chapters: [],
      chapterCount: v.count,
      key: v.key,
    })),
  };
}

/** One chapter row of a volume listing, before numbering. */
export interface ChapterRow {
  url: string;
  title: string;
}

/** One page of a volume's chapter rows, as the `kol_series_volume_chapters`
 *  action returns them (`data.html`: a run of `<li>`s), newest first like the
 *  page. Rows still under a release countdown are skipped: they name a
 *  chapter that is not readable yet. */
export function parseVolumeChapterRows(doc: Document, baseUrl: string): ChapterRow[] {
  const out: ChapterRow[] = [];
  for (const row of Array.from(doc.querySelectorAll("li[data-chapter-id]"))) {
    if (row.querySelector("[data-kol-countdown-end], .chapter-countdown")) continue;
    const href = row.querySelector("a[href]")?.getAttribute("href") || "";
    if (!href) continue;
    const number = sanitizeText(row.querySelector("[data-kol-chapter-number]")?.getAttribute("data-kol-chapter-number"));
    const name = sanitizeText(row.querySelector("[data-kol-chapter-title]")?.textContent);
    // The number is free text on the site: usually digits, but special
    // chapters carry things like "---" or "1INFO1". Only a real number
    // becomes a "الفصل N" prefix; otherwise the name stands alone.
    const numeric = /^\d+(?:\.\d+)?$/.test(number) ? number : "";
    const title = numeric ? (name ? `الفصل ${numeric} - ${name}` : `الفصل ${numeric}`) : name || number;
    out.push({ url: absoluteUrl(href, baseUrl), title });
  }
  return out;
}

/** A volume's rows, oldest first, as chapters numbered from `startId`. The
 *  no-title fallback names the chapter by the id it actually gets. */
export function numberChapters(rows: ChapterRow[], startId: number, host: SourceHost): SourceChapter[] {
  return rows.map((r, i) => ({
    id: startId + i,
    title: sanitizeChapterTitle(r.title, startId + i, host),
    url: r.url,
    lines: [],
  }));
}

// ── helpers ─────────────────────────────────────────────────────────────────

function sanitizeChapterTitle(raw: string, fallbackId: number, host: SourceHost): string {
  const collapsed = sanitizeText(raw);
  const safe = collapsed.replace(/[\\/:*?"<>|]+/g, "").trim();
  const truncated = safe.length > 100 ? safe.slice(0, 100).trim() : safe;
  // Rare technical fallback (a scraped chapter with no usable title text) —
  // same pattern as the volume-title fallback above: synthesized directly
  // via `strings(host.locale)` since this becomes the persisted chapter
  // title (data), not something translated at a single display site.
  return (
    truncated ||
    strings(host.locale)("chapterNoTitleFallback", { n: fallbackId })
  );
}

function pickImageSrc(img: HTMLImageElement | null, baseUrl: string): string | undefined {
  if (!img) return undefined;
  const src =
    img.getAttribute("src") ||
    img.getAttribute("data-src") ||
    img.getAttribute("data-lazy-src") ||
    "";
  if (!src) return undefined;
  try {
    return new URL(src, baseUrl).toString();
  } catch {
    return src;
  }
}

function extractDescriptionText(el: Element): string {
  // Strip injected ad blocks (e.g., `code-block`, `<script>` wrappers) and
  // the donation widget the theme appends to every synopsis (`.shola-widget`:
  // a progress bar and a donor leaderboard) so the description doesn't read
  // like prose glued to page furniture.
  // Cloning lets us mutate without disturbing the parsed DOM.
  const clone = el.cloneNode(true) as Element;
  clone
    .querySelectorAll("script, style, .code-block, .ai-viewports, .shola-widget")
    .forEach((n) => n.remove());
  const text = (clone.textContent || "").replace(/\s+/g, " ").trim();
  // Many KolNovel pages prepend a few hundred chars; cap so a host UI's
  // description card doesn't grow unbounded — full text is still
  // available in the imported book's content.
  return text.length > 1200 ? text.slice(0, 1200).trim() + "…" : text;
}

// ── chapter-body extraction (static HTML) ───────────────────────────────────
//
// KolNovel chapter pages carry rotating per-load hex class names that mark
// decoy paragraphs (duplicated text + a "read us only at kolnovel.com" ad
// string); the discovery + filtering below handle them. On chapters served
// through the current theme the body is already clean, so the decoy filter
// is simply a no-op there — but the selectors and stripping stay in place
// since the same theme still emits the decoy markup on some chapter
// templates.

const IGNORED_PATTERNS = [
  "*إقرأ* رواياتنا* فقط* على* مو*قع م*لوك الرو*ايات ko*lno*vel ko*lno*vel. com",
];
const IGNORED_REGEXES = IGNORED_PATTERNS.map(toIgnoreRegex);

function toIgnoreRegex(pattern: string): RegExp {
  const trimmed = pattern.replace(/^\*+|\*+$/g, "");
  const escaped = trimmed.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const withWildcards = escaped.replace(/\*/g, ".*?");
  return new RegExp(`\\s*\\*?\\s*${withWildcards}\\s*\\*?\\s*`, "gi");
}

function extractHiddenClassesFromCss(cssText: string): Set<string> {
  const out = new Set<string>();
  const ruleRegex = /([^{}]+)\{([^{}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRegex.exec(cssText)) !== null) {
    const selectors = m[1];
    const body = m[2].toLowerCase();
    if (
      !body.includes("0.1px") ||
      !body.includes("-99999px") ||
      !/opacity\s*:\s*0\b/.test(body)
    ) {
      continue;
    }
    const classMatches = selectors.match(/\.([a-f0-9]{20,})/g) || [];
    for (const c of classMatches) out.add(c.slice(1));
  }
  return out;
}

export function collectHiddenClasses(doc: Document): Set<string> {
  const out = new Set<string>();
  for (const styleEl of Array.from(doc.querySelectorAll("style"))) {
    const css = styleEl.textContent || "";
    if (!css) continue;
    for (const c of extractHiddenClassesFromCss(css)) out.add(c);
  }
  return out;
}

function hasHiddenClass(p: Element, hidden: Set<string>): boolean {
  if (hidden.size === 0) return false;
  const cls = (p.getAttribute("class") || "").trim();
  if (!cls) return false;
  for (const c of cls.split(/\s+/)) {
    if (hidden.has(c)) return true;
  }
  return false;
}

function isDecorativeImage(img: HTMLImageElement): boolean {
  const cls = (img.getAttribute("class") || "").toLowerCase();
  if (cls.includes("wp-post-image")) return true;
  if (cls.includes("attachment-post-thumbnail")) return true;
  if (cls.includes("avatar")) return true;
  if (cls.includes("emoji")) return true;
  const src = (img.getAttribute("src") || "").toLowerCase();
  if (src.includes("/ads/") || src.includes("doubleclick")) return true;
  return false;
}

function absoluteImageSrc(img: HTMLImageElement, baseUrl: string): string | null {
  const raw =
    img.getAttribute("src") ||
    img.getAttribute("data-src") ||
    img.getAttribute("data-lazy-src");
  if (!raw) return null;
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return null;
  }
}

function isHiddenInline(p: Element): boolean {
  const style = (p.getAttribute("style") || "").toLowerCase();
  if (!style) return false;
  return (
    style.includes("0.1px") &&
    style.includes("position") &&
    style.includes("fixed") &&
    style.includes("opacity") &&
    style.includes("text-indent")
  );
}

/** A paragraph's own text. Nested `<p>`s are removed first: some chapters
 *  ship unclosed `<p>` tags (`<p>` + newline + `<p>text</p>`). A spec HTML
 *  parser closes the open one at the next `<p>`, but not every parser does
 *  (happy-dom nests them), and a nested paragraph would repeat the whole
 *  rest of the chapter inside this one. Each nested `<p>` is visited on its
 *  own by `parseChapterContent` anyway. */
function paragraphText(p: Element): string {
  const clone = p.cloneNode(true) as Element;
  clone.querySelectorAll("script, noscript, style, p").forEach((n) => n.remove());
  return (clone.textContent || "").replace(/\s+/g, " ").trim();
}

function stripIgnored(line: string): string {
  let out = line;
  for (const r of IGNORED_REGEXES) out = out.replace(r, " ");
  return out.replace(/\s+/g, " ").trim();
}

/** Parse a KolNovel chapter page's body into SourceLines (text + image).
 *  Root preference: `#kol_content` (older theme markup), `.epcontent`
 *  (current markup), then `.entry-content`, then body. `baseUrl` absolutizes
 *  relative image srcs. Drops decoy paragraphs (rotating hidden hex classes
 *  / inline hide style), strips the ad string, and dedups repeated
 *  text/images ADJACENTLY ONLY — see the comment at the dedup site. Used both as the primary read (most chapters) and, when it
 *  yields nothing, as the signal that a chapter is PDF-only — see
 *  `getChapterContent` in index.ts. */
export function parseChapterContent(doc: Document, baseUrl: string): SourceLine[] {
  const hiddenClasses = collectHiddenClasses(doc);
  const root =
    doc.querySelector("#kol_content") ||
    doc.querySelector(".epcontent") ||
    doc.querySelector(".entry-content") ||
    doc.body;

  const items = root.querySelectorAll("p, img");
  const lines: SourceLine[] = [];
  // Dedup against the immediately-preceding line of the SAME TYPE only —
  // NOT "seen anywhere in the chapter", which is what this used to do.
  //
  // What this catches: the site rendering the exact same <p>/<img> twice
  // in a row (a copy-paste artifact in its markup), which the committed
  // chapter.html fixture reproduces.
  //
  // What it deliberately does NOT catch, and why: a chapter can
  // legitimately repeat a short line — a one-word paragraph, an
  // interjection — several times at unrelated points in the narrative. A
  // whole-chapter Set collapsed those into one, silently dropping real
  // prose. That is not a hypothetical here: extensions/cenele hit exactly
  // this on a live capture (three unrelated one-word paragraphs, all
  // identical, two of them deleted from the imported book) and its README
  // records it. Silently deleting a reader's book is strictly worse than
  // leaving a harmless visible duplicate line in it. No loss is
  // demonstrated in kolnovel's own live capture (chapter-live.html: 163
  // kept paragraphs, 163 distinct, so both strategies produce the same
  // output there) — this is the known-good fix ported before the site
  // hands us the case, not after.
  //
  // KNOWN LIMITATION this trade-off accepts, identical to cenele's:
  // lastText/lastImage are tracked independently per element type, so
  // "adjacent" means adjacent within that type's own sub-sequence, not in
  // raw document order. A duplicated MULTI-ELEMENT RUN (<p>A</p><img>X
  // </img><p>B</p> immediately repeated) is not caught as a whole — the
  // repeated <p>s survive as visible duplicates (the accepted trade-off)
  // but the repeated <img> is deduped away even though real content sits
  // between the two occurrences. Never observed live; recorded rather
  // than designed around speculatively.
  let lastText: string | null = null;
  let lastImage: string | null = null;
  for (const el of Array.from(items)) {
    if (el.tagName === "IMG") {
      const img = el as HTMLImageElement;
      if (isDecorativeImage(img)) continue;
      const src = absoluteImageSrc(img, baseUrl);
      if (!src) continue;
      if (src === lastImage) continue;
      lastImage = src;
      lines.push({ type: "image", content: src });
      continue;
    }
    const p = el;
    if (hasHiddenClass(p, hiddenClasses)) continue;
    if (isHiddenInline(p)) continue;
    const rawText = paragraphText(p);
    if (rawText.length === 0) continue;
    const text = stripIgnored(rawText);
    if (text.length === 0) continue;
    if (text === lastText) continue;
    lastText = text;
    lines.push({ type: "text", content: text });
  }
  return lines;
}
