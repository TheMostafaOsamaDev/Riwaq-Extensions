// DOM parsing helpers for extensions that scrape static HTML. Most
// extensions mix `host.fetch` (static HTML) with `host.renderAndExtract`
// (JS-rendered pages); for the static path, the fetched markup still needs
// to be queried, and DOMParser is the right tool. These stay plain,
// capability-free functions bundled into the extension itself — parsing
// text that has already been fetched needs no authority, so there is no
// reason to route it through `host`.

/** Parse an HTML string into a Document. Equivalent to
 *  `new DOMParser().parseFromString(html, "text/html")` but with a clearer
 *  name for the caller's intent. */
export function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

/** Resolve a URL relative to a base. Throws on invalid input. */
export function absoluteUrl(href: string, base: string): string {
  return new URL(href, base).toString();
}

/** Get the inner text of the first element matching `selector` within
 *  `root`, trimmed. Returns null when no match. */
export function textOf(root: ParentNode, selector: string): string | null {
  const el = root.querySelector(selector);
  if (!el) return null;
  return (el.textContent || "").trim() || null;
}

/** Get an attribute value of the first element matching `selector`. */
export function attrOf(
  root: ParentNode,
  selector: string,
  attr: string,
): string | null {
  const el = root.querySelector(selector);
  if (!el) return null;
  return el.getAttribute(attr);
}

/** Collapse all whitespace runs to single spaces and trim. Returns "" for
 *  nullish input, so callers can treat a missing node and an empty node alike. */
export function sanitizeText(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.replace(/\s+/g, " ").trim();
}
