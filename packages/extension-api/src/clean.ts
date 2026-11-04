// Chapter-text cleanup for sources whose chapters were copied from
// aggregator sites (novelbuddy, novelarchive and chikari all serve such
// text). What those sites stamped into it survives the copy, and every rule
// here exists because a live chapter showed it:
//
//   - the aggregator's watermark, usually spelled with look-alike letters
//     so a plain string match misses it — a line of its own, the tail of a
//     line, or glued into story text:
//       Foll𝑜w current novℯls on ƒrēewebnoѵёl.cσm.
//       …Not until today at least.𝕗𝗿𝕖𝐞𝐰𝗲𝕓𝐧𝕠𝕧𝗲𝐥.𝚌𝐨𝚖
//       …concepts.| ɪꜰ ʏᴏᴜ ᴡᴀɴᴛ ᴛᴏ ʀᴇᴀᴅ ᴍᴏʀᴇ ᴄʜᴀᴘᴛᴇʀs, ᴘʟᴇᴀsᴇ ᴠɪsɪᴛ Nove1Fire.net
//       The killing intent emanating °• N 𝑜 v 𝑒 l i g h t •° from them was intense.
//   - the translation team's credit lines ("[Translator - Night]",
//     "Editor: Henyee Translations");
//   - the chapter's heading repeated as the body's first line.
//
// What only one site does (promo lines, publisher notices, donation plugs,
// mojibake) stays in that site's extension.
import { sanitizeText } from "./dom";

// ── folding ─────────────────────────────────────────────────────────────────
//
// Watermarks are matched on a *folded* copy of the line — lower-case ASCII
// wherever a character has a look-alike — and cut out of the original, so
// the story text around one comes through untouched.

/** Stands in for a letter or digit with no known ASCII look-alike (г ૦ σ
 *  ๓ …). It matches any letter of a name, so the table below never has to
 *  be complete; stripWatermarks caps it at half of a match's letters. */
const WILD = "\u0001";

/** Look-alikes NFKD leaves alone (it already folds mathematical, fullwidth,
 *  Roman-numeral and accented letters: 𝒆 ｎ Ⅰ é). Cyrillic, Greek, IPA and
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

const LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u;
/** Scripts that never pose as Latin letters, so they are not wildcards: a
 *  translator's note reading "read 天地" must not match "readwn". */
const NO_LOOKALIKE_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function foldChar(ch: string): string {
  if (ch.length === 1 && ch.charCodeAt(0) < 0x80) return ch.toLowerCase();
  const mapped = CONFUSABLES[ch];
  if (mapped) return mapped;
  let out = "";
  for (const c of ch.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()) {
    if (c.charCodeAt(0) < 0x80) out += c;
    else if (LETTER_OR_DIGIT_RE.test(c) && !NO_LOOKALIKE_RE.test(c)) out += WILD;
    // One code unit per output character keeps `origin` aligned; U+FFFD is
    // itself a symbol, so an astral emoji still counts as decoration.
    else out += c.length === 1 ? c : "�";
  }
  return out;
}

/** The folded line, plus for each of its code units the index (into the
 *  line's code points) of the character it came from. NFKD can turn one
 *  character into several ("…" → "..."), so this is not 1:1. */
function fold(chars: readonly string[]): { text: string; origin: number[] } {
  let text = "";
  const origin: number[] = [];
  chars.forEach((ch, i) => {
    for (const c of foldChar(ch)) {
      text += c;
      origin.push(i);
    }
  });
  return { text, origin };
}

// ── watermark patterns (all run on folded text) ─────────────────────────────

/** Aggregator names seen stamped into chapter text — the union of what the
 *  English sources met. Longest first, so a name that starts another loses
 *  to it. Add to it when a new one turns up (and see BRAND_CORE_RE). */
export const WATERMARK_BRANDS: readonly string[] = [
  "lightnovelworld", "lightnovelcave", "lightnovelpub", "readnovelfull", "freewebnovel",
  "1stkissnovel", "novelbuddy", "novellight", "pandanovel", "novelfire", "novelfull",
  "novelhall", "novelnext", "novelcool", "novelight", "wuxiaspot", "novelbin", "novelusb",
  "bednovel", "boxnovel", "mtlnovel", "biquge", "readwn", "auzw", "wsx5",
];
const BRAND_SET = new Set(WATERMARK_BRANDS);

/** Digit and symbol swaps watermarks use for a letter ("Nove1Fire"). */
const SWAPS: Record<string, string> = { l: "1i|", i: "1l", o: "0", e: "3" };
const letter = (c: string) => `[${c}${SWAPS[c] ?? ""}${WILD}]`;
/** Noise allowed between two letters of a name, one character at most:
 *  "N o v e l i g h t", "f(r)eewebn(o)vel", "fre(e)webno(v)el". */
const GAP = "[\\s()\\[\\]{}*_'\\-]?";
const GAP_CHARS_RE = /[\s()[\]{}*_'.·-]/g;

const BRAND_SRC = WATERMARK_BRANDS.map((b) => Array.from(b, letter).join(GAP)).join("|");
/** A TLD glued on — "novelfire.net", "freeweɓnovēl.coɱ" — never "NovelFire.
 *  To the translators…", which is the end of a sentence. No boundary after
 *  it: "𝚌𝐨𝚖He went." is a watermark glued onto the next sentence. */
const TLDS = ["online", "info", "site", "com", "net", "org", "vip", "xyz", "top", "cn", "me", "cc", "co", "io", "to"];
const TLD_SRC = `[.·](?:${TLDS.map((t) => Array.from(t, letter).join("")).join("|")})(?:/[^\\s)\\]】]*)?`;
/** Decoration watermarks wrap themselves in (❖ ➤ ◈ ~ °• # …): any symbol,
 *  plus the punctuation they borrow. */
const DECOR = "[\\s\\p{So}\\p{Sm}°•·*#_]";
/** Phrases that introduce a watermark in the same breath. */
const LEAD_IN_SRC = String.raw`(?:(?:if you want to read more chapters,?\s*)?please visit|visit|this chapter is updated by|updated (?:by|from|at)|follow current novels on|new novel chapters are published on|read (?:more )?(?:at|on)|find (?:the original|more) (?:at|on)|the source of this content is|(?:this )?content (?:is )?taken from|discover more (?:at|on)|exclusive on)\s*`;
/** A promo aside right after a watermark: "(Read more on our source)". */
const ASIDE_SRC = String.raw`\((?:read more on our source|official version|original source|continue reading|read (?:more|it) (?:on|at)[^()]{0,25}|exclusive on[^()]{0,25})\)`;

/** One watermark candidate: lead-in, decoration, the name (with scheme,
 *  www. and TLD when present), decoration, and a promo aside. Groups:
 *  1 lead-in, 2 decoration before, 3 token, 4 name, 5 TLD, 6 decoration
 *  after, 7 aside. */
const WATERMARK_SPAN_RE = new RegExp(
  `(${LEAD_IN_SRC})?(${DECOR}*)((?:https?://)?(?:www\\.)?(${BRAND_SRC})(${TLD_SRC})?)(${DECOR}*)(${ASIDE_SRC})?`,
  "gu",
);
/** A short bracketed group: a watermark inside one takes the group with it
 *  ("The [Liancheng www.wsx5.cn] branch of…"). */
const BRACKET_GROUP_RE = /\[[^\][]{0,60}\]|【[^】【]{0,60}】|\([^()]{0,60}\)/g;
/** The fast path. A line of nothing but ASCII, no-break spaces and the
 *  General Punctuation block (curly quotes, dashes, ellipses — none of which
 *  can spell a name) needs no per-character fold, and without one of these
 *  three-letter cores it holds no name at all. Every entry in
 *  WATERMARK_BRANDS contains one, allowing a character of noise between
 *  letters and 0 for o; a new name needs one too (clean.test.ts checks).
 *  Measured on a 38K-character chapter of curly-quoted dialogue: 0.4 ms,
 *  against 2 ms for testing the names themselves. */
const FOLD_NEEDED_RE = /[^\x00-\x7f\u00a0\u2000-\u206f]/;
const BRAND_CORE_RE = /n[^a-z]?[o0][^a-z]?v|w[^a-z]?u[^a-z]?x|q[^a-z]?u[^a-z]?g|d[^a-z]?w[^a-z]?n|u[^a-z]?z[^a-z]?w|s[^a-z]?x[^a-z]?5/i;

const SENTENCE_END_RE = /[.!?。！？…]/;
/** What may sit between a sentence's end and the next one's first word —
 *  closing quotes and brackets, a system panel's closing "|". */
const CLOSER_RE = /["'”’)\]|\s]/;

/** Cuts every aggregator watermark out of one line and returns what is
 *  left, or "" when nothing readable is.
 *
 *  A name counts as a watermark when it carries a TLD (`novelfire.net`), is
 *  disguised (a look-alike letter, a digit swap or a bracket inside it), or
 *  is wrapped in decoration (`❖ Novelight ❖`) — never a plain mention ("a
 *  year on NovelFire.", "a free web novel"). Look-alike letters fold to
 *  ASCII; whatever is left over matches as a wildcard, at most half of a
 *  match's letters.
 *
 *  What goes: a short bracket group holding the watermark goes whole. A
 *  domain goes with the sentence it sits in ("Visit frёewebnoѵel.ƈo๓ for
 *  the b𝘦st novel reading experience.") — but alone when it opens a
 *  sentence of its own, glued or not ("…at least.𝕗𝗿𝕖𝐞𝐰𝗲𝕓𝐧𝕠𝕧𝗲𝐥.𝚌𝐨𝚖",
 *  `auzw.com "Ha." With a grin…`), unless the words after it carry on in
 *  lower case. Any other watermark — a decorated domain included — goes
 *  with its lead-in, decoration and promo aside, and the sentence around
 *  it stays. */
export function stripWatermarks(line: string): string {
  if (!FOLD_NEEDED_RE.test(line) && !BRAND_CORE_RE.test(line)) return line;

  const chars = Array.from(line);
  const { text, origin } = fold(chars);
  const charAt = (k: number) => origin[k];
  const charAfter = (k: number) => origin[k - 1] + 1;
  const groups = Array.from(text.matchAll(BRACKET_GROUP_RE), (g) => [g.index!, g.index! + g[0].length]);
  const cuts: Array<[number, number]> = [];

  WATERMARK_SPAN_RE.lastIndex = 0;
  for (let m; (m = WATERMARK_SPAN_RE.exec(text)); ) {
    const [span, leadIn = "", before, token, name, tld = "", after] = m;
    const tokenStart = m.index + leadIn.length + before.length;
    const tokenEnd = tokenStart + token.length;
    const nameStart = tokenEnd - tld.length - name.length;

    const letters = (name + tld).replace(GAP_CHARS_RE, "");
    const wild = letters.split(WILD).length - 1;
    const raw = chars
      .slice(charAt(nameStart), charAfter(nameStart + name.length))
      .join("")
      .replace(/[\s_'*-]/g, "")
      .toLowerCase();
    const disguised = !BRAND_SET.has(raw);
    const decorBefore = /\S/.test(before);
    const decorAfter = /\S/.test(after);
    const decorated =
      (decorBefore || decorAfter) &&
      (decorBefore || text.slice(0, tokenStart).trim() === "") &&
      (decorAfter || text.slice(tokenEnd).trim() === "");
    if (wild * 2 > letters.length || !(tld || disguised || decorated)) {
      // Not a watermark; a real one may still start inside this span.
      WATERMARK_SPAN_RE.lastIndex = tokenEnd;
      continue;
    }

    const group = groups.find(([a, b]) => a <= tokenStart && tokenEnd <= b);
    const spanEnd = charAfter(m.index + span.length);
    if (group) cuts.push([charAt(group[0]), charAfter(group[1])]);
    else if (!tld || decorBefore) cuts.push([charAt(m.index), spanEnd]);
    else cuts.push(domainCut(chars, charAt(tokenStart), charAfter(tokenEnd), spanEnd));
  }
  if (cuts.length === 0) return line;

  const pieces: string[] = [];
  let pos = 0;
  for (const [from, to] of cuts.sort((a, b) => a[0] - b[0])) {
    if (from > pos) pieces.push(chars.slice(pos, from).join(""));
    pos = Math.max(pos, to);
  }
  pieces.push(chars.slice(pos).join(""));
  const out = sanitizeText(pieces.reduce(joinAtCut, ""));
  return LETTER_OR_DIGIT_RE.test(out) ? out : "";
}

/** The characters to cut for a domain watermark spanning [start, end) of
 *  `chars` (`spanEnd` takes its trailing decoration and aside with it). */
function domainCut(chars: readonly string[], start: number, end: number, spanEnd: number): [number, number] {
  let from = start;
  while (from > 0 && !SENTENCE_END_RE.test(chars[from - 1])) from--;
  while (from < start && CLOSER_RE.test(chars[from])) from++;
  const glued = end < chars.length && LETTER_OR_DIGIT_RE.test(chars[end]);

  if (from === start) {
    // The domain opens its sentence: a sentence of its own, unless the
    // words after it carry on in lower case or after a comma.
    let next = end;
    while (next < chars.length && /\s/.test(chars[next])) next++;
    if (glued || next === chars.length || !/[\p{Ll},;:]/u.test(chars[next])) return [start, spanEnd];
  } else if (glued) {
    return [from, end];
  }
  let to = end;
  while (to < chars.length && !SENTENCE_END_RE.test(chars[to])) to++;
  while (to < chars.length && SENTENCE_END_RE.test(chars[to])) to++;
  while (to < chars.length && CLOSER_RE.test(chars[to]) && !/\s/.test(chars[to])) to++;
  return [from, to];
}

/** Rejoins the text either side of a cut: one space, or none before
 *  punctuation ("…got ➤ Novelight ➤, then" → "…got, then"). */
function joinAtCut(left: string, right: string): string {
  const l = left.trimEnd();
  const r = right.trimStart();
  if (!l || !r) return l || r;
  return /^[,.!?;:]/.test(r) ? l + r : `${l} ${r}`;
}

// ── credit lines ────────────────────────────────────────────────────────────

/** Roles a translation team credits itself under. The two- and three-letter
 *  forms only count before a colon: "Ed - he never came back." is narration
 *  about someone named Ed. */
const CREDIT_ROLE = "author|translator|translated by|translation|editor|edited by|proofreader|proofread(?:ed)? by";
const CREDIT_ABBR = "tlc|tl|ed|pr";
/** `[Translator - Night]`, `[Proofreader: Gun]`: unambiguous wherever it
 *  sits (two source chapters glued together put pairs mid-body). */
const BRACKETED_CREDIT_RE = new RegExp(
  `^\\[\\s*(?:${CREDIT_ROLE}|${CREDIT_ABBR})\\s*[:：\\-–—]\\s*[^\\]]{1,60}\\]$`,
  "i",
);
/** `Editor: Henyee Translations`, `TL: Hanguk`, `Translator - Night`, or a
 *  bare `Translator:` label whose name is the next line. Group 1 is the
 *  name part. */
const BARE_CREDIT_RE = new RegExp(
  `^(?:(?:${CREDIT_ROLE})\\s*[:：\\-–—]|(?:${CREDIT_ABBR})\\s*[:：])\\s*(.{0,100})$`,
  "i",
);
/** A credit names people; "Ed: [Hey, wait!]" is a speaker line. */
const NOT_A_NAME_RE = /[[\]「」“”"!?]/;
/** Longest line a bare label's name may take up. */
const CREDIT_NAME_MAX_LENGTH = 60;
/** A bare credit only counts this close to either end of a chapter, or
 *  right next to another credit line there — so a system panel reading
 *  "Author: Unknown" mid-chapter stays. */
export const CREDIT_EDGE = 4;

/** Indexes of the translation-team credit lines among a chapter's text
 *  lines (each already whitespace-collapsed). A bracketed credit counts
 *  anywhere; a bare one only in the first or last CREDIT_EDGE lines or
 *  touching another credit there, and only when what follows the role
 *  reads as names. A bare label ("Translator:") takes the short line after
 *  it, its name, along with it. */
export function findCreditLines(lines: readonly string[]): Set<number> {
  const found = new Set<number>();
  lines.forEach((line, i) => {
    if (BRACKETED_CREDIT_RE.test(line)) found.add(i);
  });
  const bare = (i: number) => {
    const m = BARE_CREDIT_RE.exec(lines[i]);
    if (!m || NOT_A_NAME_RE.test(m[1])) return;
    found.add(i);
    const next = lines[i + 1];
    const isName =
      next !== undefined && next.length < CREDIT_NAME_MAX_LENGTH && !BARE_CREDIT_RE.test(next) && !NOT_A_NAME_RE.test(next);
    if (m[1].trim() === "" && isName) found.add(i + 1);
  };
  for (let i = 0; i < lines.length && (i < CREDIT_EDGE || found.has(i - 1)); i++) bare(i);
  for (let i = lines.length - 1; i >= 0 && (i >= lines.length - CREDIT_EDGE || found.has(i + 1)); i--) bare(i);
  return found;
}

// ── leading heading ─────────────────────────────────────────────────────────

/** "Chapter 12", "Chapter 2 - 2", "Chapter 4566: One Too Many (Part 2)". */
const NUMBERED_HEADING_RE = /^chapter\s*\d+/i;
/** Case- and punctuation-blind form of a heading. */
const headingKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Whether a chapter body's first text line only repeats the heading the
 *  reader already shows: a "Chapter N…" line, or the chapter's own `title`
 *  again ignoring case and punctuation ("Chapter 6081, Disciplinary Hall"
 *  for "Chapter 6081: Disciplinary Hall"). `numbered: false` leaves only the
 *  title test, for a line the source knows a translator wrote as a
 *  paragraph. No length limit: a heading can carry a credit glued on
 *  (155 characters on one novelbuddy chapter); a source whose text has no
 *  structure to tell a heading from a paragraph sets its own. */
export function isLeadingHeading(
  line: string,
  options: { title?: string; numbered?: boolean } = {},
): boolean {
  const { title = "", numbered = true } = options;
  if (numbered && NUMBERED_HEADING_RE.test(line)) return true;
  const key = headingKey(title);
  return key !== "" && headingKey(line) === key;
}
