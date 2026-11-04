// Chapter-text cleanup for Novel Archive.
//
// The archive stores plain text it gathered from many other sites, and some
// of it still carries what those sites stamped into it. Aggregator
// watermarks (look-alike letters, spaced or bracketed names, symbol
// wrappers) and translator credit lines are the shared rules from
// @riwaq/extension-api (`stripWatermarks`, `findCreditLines`). What is left
// here only this archive showed (see README.md, "Cleaning chapter text"):
//
//   - "the fastest update…" / "please collect it: (www.…)" promo lines, and
//     bracketed URLs ("[笔趣阁www.biqugeso.me]");
//   - a Zhangyue publisher notice ("produced and distributed electronically
//     by…", "all rights reserved", "infringement will be investigated");
//   - Markdown code fences (```html / ```) left by some cleanup pipeline;
//   - UTF-8 read as Latin-1 ("â\x80\x83" for an em space).
import { findCreditLines, sanitizeText, stripWatermarks } from "@riwaq/extension-api";

// ── mojibake ────────────────────────────────────────────────────────────────

/** One UTF-8 sequence that was decoded as Latin-1: a lead byte followed by
 *  exactly the continuation bytes it announces. */
const LATIN1_UTF8_RE = /[Â-ß][\u0080-¿]|[à-ï][\u0080-¿]{2}|[ð-ô][\u0080-¿]{3}/g;
const C1_CONTROL_RE = /[\u0080-\u009f]/;

/** Re-decodes UTF-8 that was read as Latin-1. Only sequences containing a
 *  C1 control character (U+0080–U+009F) are touched: those never occur in
 *  real text, so "Ã©"-style pairs that could be genuine are left alone,
 *  and a chapter without one (nearly all of them) skips the sequence pass. */
export function repairMojibake(text: string): string {
  if (!C1_CONTROL_RE.test(text)) return text;
  return text.replace(LATIN1_UTF8_RE, (seq) => {
    if (!C1_CONTROL_RE.test(seq)) return seq;
    const b = Array.from(seq, (ch) => ch.charCodeAt(0));
    let cp: number;
    if (b.length === 2) cp = ((b[0] & 0x1f) << 6) | (b[1] & 0x3f);
    else if (b.length === 3) cp = ((b[0] & 0x0f) << 12) | ((b[1] & 0x3f) << 6) | (b[2] & 0x3f);
    else cp = ((b[0] & 0x07) << 18) | ((b[1] & 0x3f) << 12) | ((b[2] & 0x3f) << 6) | (b[3] & 0x3f);
    const min = b.length === 2 ? 0x80 : b.length === 3 ? 0x800 : 0x10000;
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return seq;
    return String.fromCodePoint(cp);
  });
}

// ── promo lines ─────────────────────────────────────────────────────────────

/** A short bracketed group: "[笔趣阁www.biqugeso.me]", "(www.novelbuddy.com)". */
const BRACKET_GROUP_RE = /\[[^\][]{0,60}\]|【[^】【]{0,60}】|\([^()]{0,60}\)/g;
const URL_RE = /https?:\/\/|www\.[a-z0-9-]+\./i;
/** Aggregator promo speak. Only consulted on lines that also carried a
 *  watermark or a URL, so ordinary story text never trips it. */
const PROMO_RE =
  /fastest|latest chapters?|update(?:s|d)? (?:fast|quickly)|please collect|collect it|free to read|pop-?up|table of contents|reading experience|read more|continue reading|for the best|updated by|published (?:on|at)|follow current|source of this|for one second/;
/** A character NFKD could fold into another. ASCII, curly quotes and en
 *  and em dashes — the bulk of English prose — are their own NFKD form, so
 *  a line of only those holds a URL only if it shows one as written. */
const NFKD_SENSITIVE_RE = /[^\x00-\x7f\u2013\u2014\u2018\u2019\u201c\u201d]/;

/** One line without its watermarks and this archive's promo leftovers: a
 *  bracketed group holding a URL is cut, and what remains of a line that
 *  lost a watermark or URL, or still carries a URL, is dropped when it is
 *  aggregator promo ("Remember … for one second, update fast, no pop-up
 *  window, free to read!", "READ MORE CHAPTERS HERE-https://…"). Returns ""
 *  for a line with nothing worth keeping. */
export function cleanLine(line: string): string {
  // A bracket group can only hold a URL when the line does.
  const hasUrl = URL_RE.test(line);
  const unbracketed = hasUrl ? line.replace(BRACKET_GROUP_RE, (group) => (URL_RE.test(group) ? " " : group)) : line;
  let text = stripWatermarks(unbracketed);
  // A cut group leaves a gap, and a space before the punctuation after it.
  if (unbracketed !== line) text = sanitizeText(text).replace(/\s+([,.!?;:])/g, "$1");
  const touched = text !== line;
  // An untouched line is promo only when it carries a URL — and without a
  // URL as written, or a character NFKD could fold into one, it cannot.
  if (!touched && !hasUrl && !NFKD_SENSITIVE_RE.test(line)) return line;
  if (touched && !/\p{L}/u.test(text)) return "";
  const plain = text.normalize("NFKD").toLowerCase();
  if ((touched || URL_RE.test(plain)) && PROMO_RE.test(plain)) return "";
  return text;
}

// ── whole-line rules ──────────────────────────────────────────────────────

const CODE_FENCE_RE = /^```[\w-]*$/;
const ZHANGYUE_NOTICE_RE = /produced and distributed electronically by/i;
const ZHANGYUE_TAIL_RE = /^(?:all rights reserved|[·•]|infringement (?:will|must) be (?:investigated|prosecuted))[.!]?$/i;

/** Cleans a chapter's lines (already split and whitespace-collapsed). */
export function cleanLines(lines: string[]): string[] {
  const credits = findCreditLines(lines);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (CODE_FENCE_RE.test(line) || credits.has(i)) continue;

    if (ZHANGYUE_NOTICE_RE.test(line)) {
      while (i + 1 < lines.length && ZHANGYUE_TAIL_RE.test(lines[i + 1])) i++;
      continue;
    }

    const cleaned = cleanLine(line);
    if (cleaned) out.push(cleaned);
  }
  return out;
}
