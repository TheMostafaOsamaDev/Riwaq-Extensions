// Chapter-text cleanup for Novel Archive.
//
// The archive stores plain text it gathered from many other sites, and some
// of it still carries what those sites stamped into it. Every rule below
// exists because a live chapter showed it (see README.md, "Cleaning chapter
// text", for the examples):
//
//   - aggregator watermarks, usually disguised with look-alike letters
//     ("Follow curr𝒆nt nov𝒆ls on fɾeeweɓnѳveɭ.com.", "ᴘʟᴇᴀsᴇ ᴠɪsɪᴛ
//     Nove1Fire.net", "❖ Nоvеl𝚒ght ❖", "f(r)eew𝒆bn(o)vel.com"), either on
//     a line of their own or glued into a line of story text;
//   - "the fastest update…" / "please collect it: (www.…)" promo lines;
//   - Translator / Editor / Proofread credit lines at the top of a chapter;
//   - a Zhangyue publisher notice ("produced and distributed electronically
//     by…", "all rights reserved", "infringement will be investigated");
//   - Markdown code fences (```html / ```) left by some cleanup pipeline;
//   - UTF-8 read as Latin-1 ("â\x80\x83" for an em space).
//
// Matching runs on a *folded* copy of each line — look-alike letters mapped
// to plain lowercase ASCII — while removal cuts the same span out of the
// original line, so story text around a watermark comes through untouched.
import { sanitizeText } from "@riwaq/extension-api";

// ── mojibake ────────────────────────────────────────────────────────────────

/** One UTF-8 sequence that was decoded as Latin-1: a lead byte followed by
 *  exactly the continuation bytes it announces. */
const LATIN1_UTF8_RE = /[Â-ß][\u0080-¿]|[à-ï][\u0080-¿]{2}|[ð-ô][\u0080-¿]{3}/g;
const C1_CONTROL_RE = /[\u0080-\u009f]/;

/** Re-decodes UTF-8 that was read as Latin-1. Only sequences containing a
 *  C1 control character (U+0080–U+009F) are touched: those never occur in
 *  real text, so "Ã©"-style pairs that could be genuine are left alone. */
export function repairMojibake(text: string): string {
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

// ── folding ────────────────────────────────────────────────────────────────

/** Look-alike letters NFKD does not map to ASCII on its own (mathematical,
 *  fullwidth and accented letters it already does). Cyrillic, Greek, IPA and
 *  small-capital forms seen in, or typical of, aggregator watermarks. */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  а: "a", в: "b", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c",
  т: "t", у: "y", х: "x", ѕ: "s", і: "i", ї: "i", ј: "j", һ: "h", ԁ: "d", ԛ: "q",
  ԝ: "w", ѡ: "w", ѳ: "o", ѵ: "v", ӏ: "l",
  А: "a", В: "b", Е: "e", К: "k", М: "m", Н: "h", О: "o", Р: "p", С: "c", Т: "t",
  Х: "x", У: "y", Ѕ: "s", І: "i", Ј: "j", Ԁ: "d", Ү: "y",
  // Greek
  α: "a", β: "b", ε: "e", η: "n", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t",
  υ: "u", χ: "x", γ: "y", ω: "w",
  Α: "a", Β: "b", Ε: "e", Η: "h", Ι: "i", Κ: "k", Μ: "m", Ν: "n", Ο: "o", Ρ: "p",
  Τ: "t", Χ: "x", Υ: "y", Ζ: "z",
  // IPA / Latin extended
  ɑ: "a", ɓ: "b", ƈ: "c", ɗ: "d", ɖ: "d", ɛ: "e", ɘ: "e", ƒ: "f", ɠ: "g", ɡ: "g",
  ɦ: "h", ɧ: "h", ɨ: "i", ɩ: "i", ı: "i", ʝ: "j", ƙ: "k", ɭ: "l", ɫ: "l", ɱ: "m",
  ɲ: "n", ŋ: "n", ɵ: "o", ʠ: "q", ɾ: "r", ɽ: "r", ʂ: "s", ƭ: "t", ʈ: "t", ʋ: "v",
  ⱱ: "v", ⱳ: "w", ȥ: "z", ʐ: "z", ყ: "y",
  // small capitals
  ᴀ: "a", ʙ: "b", ᴄ: "c", ᴅ: "d", ᴇ: "e", ꜰ: "f", ɢ: "g", ʜ: "h", ɪ: "i", ᴊ: "j",
  ᴋ: "k", ʟ: "l", ᴍ: "m", ɴ: "n", ᴏ: "o", ᴘ: "p", ǫ: "q", ʀ: "r", ꜱ: "s", ᴛ: "t",
  ᴜ: "u", ᴠ: "v", ᴡ: "w", ʏ: "y", ᴢ: "z",
};

interface Folded {
  /** The folded line: one code unit per original character. */
  text: string;
  /** For folded index k: the original start / end (exclusive) index. */
  starts: number[];
  ends: number[];
}

function foldChar(ch: string): string {
  if (ch.length === 1 && ch.charCodeAt(0) < 0x80) return ch.toLowerCase();
  const mapped = CONFUSABLES[ch];
  if (mapped) return mapped;
  const plain = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (/^[a-z0-9]$/.test(plain)) return plain;
  // Not a letter we can fold: keep one code unit so indices stay 1:1.
  return ch.length === 1 ? ch : "�";
}

/** Folds a line to lowercase ASCII where a character has a look-alike, one
 *  folded code unit per original character (astral characters included). */
export function fold(line: string): Folded {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  for (const ch of line) {
    text += foldChar(ch);
    starts.push(i);
    i += ch.length;
    ends.push(i);
  }
  return { text, starts, ends };
}

// ── watermark patterns (all run on folded text) ─────────────────────────────

/** Aggregator names stamped into the text. Each is matched letter by letter
 *  with an optional space or parenthesis between letters ("n o v e l i g h
 *  t", "f(r)eewebn(o)vel"), and with the digit swaps watermarks use
 *  ("nove1fire"). */
const BRANDS = [
  "freewebnovel",
  "bednovel",
  "novelbin",
  "novelfire",
  "novelight",
  "novellight",
  "lightnovelpub",
  "lightnovelworld",
  "lightnovelcave",
  "readnovelfull",
  "novelfull",
  "novelhall",
  "novelnext",
  "novelusb",
  "novelbuddy",
  "novelcool",
  "pandanovel",
  "boxnovel",
  "mtlnovel",
  "wuxiaspot",
  "readwn",
  "1stkissnovel",
  "biquge",
  "auzw",
  "wsx5",
];

const LETTER_CLASS: Record<string, string> = { l: "[l1i|]", i: "[i1l]", o: "[o0]", e: "[e3]" };
const brandPattern = (brand: string) =>
  Array.from(brand, (c) => LETTER_CLASS[c] ?? c).join("[\\s()]?");

const BRAND_SRC = `(?:${BRANDS.map(brandPattern).join("|")})`;
/** A TLD glued to the name — "novelfire.net" — never "NovelFire. To the
 *  translators…", which is the end of a sentence. */
const TLD_SRC = String.raw`\.(?:com|net|org|cn|me|cc|co|io|vip|xyz|info|site|top|online|to)\b(?:/[^\s)\]】]*)?`;
/** Decoration watermarks wrap themselves in (❖ ➤ ✪ ◈ ~ °• # …): any
 *  symbol, plus the punctuation they borrow. */
const DECOR = "[\\s\\p{So}\\p{Sm}°•·*#_]";
const DECOR_RE = /[\p{So}\p{Sm}°•·*#]/u;
/** Phrases that introduce a watermark in the same breath. */
const LEAD_IN_SRC = String.raw`(?:(?:if you want to read more chapters,?\s*)?please visit|visit|this chapter is updated by|updated (?:by|from|at)|follow current novels on|new novel chapters are published on|read (?:more )?(?:at|on)|find (?:the original|more) (?:at|on)|the source of this content is|(?:this )?content (?:is )?taken from|discover more (?:at|on)|exclusive on)\s*`;
/** A promo aside right after a watermark: "(Read more on our source)". */
const PROMO_ASIDE_SRC = String.raw`(?:\((?:read more on our source|official version|original source|continue reading|read (?:more|it) (?:on|at)[^()]{0,25}|exclusive on[^()]{0,25})\))?`;

/** A brand mention, with its optional scheme/www, TLD and path. */
const BRAND_TOKEN_RE = new RegExp(
  String.raw`(?:https?://)?(?:www\.)?${BRAND_SRC}(?:${TLD_SRC})?`,
  "gu",
);
/** The span to cut for a watermark: lead-in, decoration, token, decoration,
 *  and a promo parenthetical right after it ("(Read more on our source)"). */
const WATERMARK_SPAN_RE = new RegExp(
  String.raw`(?:${LEAD_IN_SRC})?${DECOR}*(?:https?://)?(?:www\.)?${BRAND_SRC}(?:${TLD_SRC})?${DECOR}*${PROMO_ASIDE_SRC}`,
  "gu",
);
/** A bracketed group holding a watermark or a URL: "[笔趣阁www.biqugeso.me]",
 *  "(Exclusive on Novelight)", "(www.wuxiaspot.com)". */
const BRACKET_GROUP_RE = /\[[^\][]{0,60}\]|【[^】【]{0,60}】|\([^()]{0,60}\)/g;
const URL_RE = /https?:\/\/|www\.[a-z0-9-]+\./;

/** Aggregator promo speak. Only consulted on lines that also carry a
 *  watermark or a URL, so ordinary story text never trips it. */
const PROMO_RE =
  /fastest|latest chapters?|update(?:s|d)? (?:fast|quickly)|please collect|collect it|free to read|pop-?up|table of contents|reading experience|read more|continue reading|for the best|updated by|published (?:on|at)|follow current|source of this|for one second/;

const LETTER_RE = /\p{L}/u;

/** Is this brand match a watermark rather than a plain mention ("after a
 *  year on NovelFire")? It is when it carries a TLD, when it is disguised
 *  (any non-ASCII letter, digit swap or parenthesis inside it), or when it
 *  is wrapped in decoration. */
function isWatermark(original: string, folded: Folded, start: number, end: number): boolean {
  const token = folded.text.slice(start, end);
  if (/\.[a-z]{2,}/.test(token)) return true;
  const raw = original.slice(folded.starts[start], folded.ends[end - 1]);
  if (/[^\x20-\x7e]|[()0-9|]/.test(raw)) return true;
  const before = folded.text.slice(Math.max(0, start - 3), start);
  const after = folded.text.slice(end, end + 3);
  return DECOR_RE.test(before + after);
}

/** Removes folded-index ranges from the original line. */
function cut(original: string, folded: Folded, ranges: Array<[number, number]>): string {
  let out = "";
  let pos = 0;
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    const from = folded.starts[start];
    const to = folded.ends[end - 1];
    if (from < pos) continue;
    out += original.slice(pos, from) + " ";
    pos = to;
  }
  return out + original.slice(pos);
}

/** Strips watermarks out of one line. Returns the cleaned line, or "" when
 *  nothing worth keeping is left (a pure watermark or promo line). */
export function stripWatermarks(line: string): string {
  let current = line;
  let touched = false;

  // 1. Bracketed groups carrying a watermark or a URL go whole.
  {
    const folded = fold(current);
    const ranges: Array<[number, number]> = [];
    for (const m of folded.text.matchAll(BRACKET_GROUP_RE)) {
      const inner = m[0];
      const hasBrand = [...inner.matchAll(BRAND_TOKEN_RE)].some((b) =>
        isWatermark(current, folded, m.index! + b.index!, m.index! + b.index! + b[0].length),
      );
      if (hasBrand || URL_RE.test(inner)) ranges.push([m.index!, m.index! + inner.length]);
    }
    if (ranges.length > 0) {
      current = cut(current, folded, ranges);
      touched = true;
    }
  }

  // 2. Watermark spans (lead-in + decoration + token) anywhere in the line.
  {
    const folded = fold(current);
    const ranges: Array<[number, number]> = [];
    for (const m of folded.text.matchAll(WATERMARK_SPAN_RE)) {
      const span = m[0];
      const token = [...span.matchAll(BRAND_TOKEN_RE)][0];
      if (!token) continue;
      const tokenStart = m.index! + token.index!;
      if (!isWatermark(current, folded, tokenStart, tokenStart + token[0].length)) continue;
      ranges.push([m.index!, m.index! + span.length]);
    }
    if (ranges.length > 0) {
      current = cut(current, folded, ranges);
      touched = true;
    }
  }

  const text = sanitizeText(current);
  const folded = fold(text).text;
  if (touched) {
    // What is left of a line that carried a watermark: nothing readable, or
    // the rest of a promo sentence → drop it; story text → keep it.
    if (!LETTER_RE.test(text) || PROMO_RE.test(folded)) return "";
    return text.replace(/\s+([,.!?;:])/g, "$1");
  }
  // No known brand, but a URL in aggregator promo speak ("Table of Contents
  // URL: https://…", "Remember www.… for one second").
  if (URL_RE.test(folded) && PROMO_RE.test(folded)) return "";
  return text;
}

// ── whole-line rules ──────────────────────────────────────────────────────

const CODE_FENCE_RE = /^```[\w-]*$/;
/** Credit lines sit at the top of a chapter; only that far is checked. */
const CREDIT_WINDOW = 8;
const CREDIT_RE = /^(?:translator|translated by|translation|editor|edited by|proofreader|proofread(?:ed)? by|tl|tlc|ed|pr)\s*[:：]\s*(.*)$/i;
const CREDIT_MAX_LENGTH = 150;
const CREDIT_NAME_MAX_LENGTH = 60;
/** A credit names people; "Ed: [Hey!]" is a speaker line, not a credit. */
const NOT_A_NAME_RE = /[[\]「」“”"!?]/;
const ZHANGYUE_NOTICE_RE = /produced and distributed electronically by/i;
const ZHANGYUE_TAIL_RE = /^(?:all rights reserved|[·•]|infringement (?:will|must) be (?:investigated|prosecuted))[.!]?$/i;

/** Cleans a chapter's lines (already split and whitespace-collapsed). */
export function cleanLines(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (CODE_FENCE_RE.test(line)) continue;

    if (out.length < CREDIT_WINDOW && line.length < CREDIT_MAX_LENGTH) {
      const credit = CREDIT_RE.exec(line);
      if (credit && !NOT_A_NAME_RE.test(credit[1])) {
        // A bare "Translator:" label carries its name on the next line.
        const next = lines[i + 1];
        if (credit[1].trim() === "" && next !== undefined && next.length < CREDIT_NAME_MAX_LENGTH && !CREDIT_RE.test(next)) {
          i++;
        }
        continue;
      }
    }

    if (ZHANGYUE_NOTICE_RE.test(line)) {
      while (i + 1 < lines.length && ZHANGYUE_TAIL_RE.test(lines[i + 1])) i++;
      continue;
    }

    const cleaned = stripWatermarks(line);
    if (cleaned) out.push(cleaned);
  }
  return out;
}
