// Drives a real extension against its live site through a network-backed
// SourceHost, so "does this extension still work?" is answered by the site
// rather than by saved fixtures. Fixtures catch a parser regression; only
// this catches the site changing underneath us.
//
//   pnpm probe cenele
//   pnpm probe cenele "سيد"
//
// Transport is curl rather than global fetch: under happy-dom (which the
// extensions need for DOMParser) `fetch` is happy-dom's own CORS-enforcing
// implementation and refuses every cross-origin read. curl also gives real
// cookie-jar semantics via -b/-c, which is exactly what SourceHost.fetch
// promises — cenele's WordPress nonces are session-scoped and break
// without it.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, it } from "vitest";
import type { FetchResponse, Source, SourceHost } from "@riwaq/extension-api";

const execFileAsync = promisify(execFile);
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const JAR_DIR = mkdtempSync(join(tmpdir(), "riwaq-probe-"));
const JAR = join(JAR_DIR, "cookies.txt");
// One jar dir per invocation (mkdtempSync above); remove it once the run is
// done rather than leaving it behind in the OS tmpdir on every `pnpm probe`.
afterAll(() => rmSync(JAR_DIR, { recursive: true, force: true }));

async function curl(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } | undefined) {
  const args = [
    "-sS", "--compressed", "--max-time", "60", "-L",
    "-b", JAR, "-c", JAR,
    "-A", UA,
    "-H", "Accept-Language: ar,en;q=0.8",
    "-D", "/dev/stderr",
    "-X", opts?.method ?? "GET",
  ];
  for (const [k, v] of Object.entries(opts?.headers ?? {})) args.push("-H", `${k}: ${v}`);
  if (opts?.body !== undefined) args.push("--data-raw", String(opts.body));
  args.push(url);

  const { stdout, stderr } = await execFileAsync("curl", args, {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });

  // -D writes one header block per redirect hop; the last one is the
  // response we actually got.
  const blocks = stderr.toString("utf8").split(/\r?\n\r?\n/).filter((b) => b.trim());
  const lines = (blocks.at(-1) ?? "").split(/\r?\n/);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return {
    status: Number(lines[0]?.match(/HTTP\/[\d.]+\s+(\d+)/)?.[1] ?? 0),
    headers,
    body: stdout as unknown as Buffer,
  };
}

const host: SourceHost = {
  locale: "ar",
  async fetch(url, opts): Promise<FetchResponse> {
    const r = await curl(url, opts);
    return { status: r.status, text: r.body.toString("utf8"), headers: r.headers };
  },
  async fetchBytes(url, opts) {
    return new Uint8Array((await curl(url, opts)).body);
  },
  async renderAndExtract() {
    throw new Error("renderAndExtract is not wired in the probe — prefer static fetch");
  },
  log(level, msg) {
    if (level === "error" || level === "warn") console.log(`  [${level}] ${msg}`);
  },
  pdf: {
    async extractChapter() {
      throw new Error("pdf.extractChapter is not wired in the probe");
    },
  },
};

const ID = process.env.PROBE_ID ?? "cenele";
const QUERY = process.env.PROBE_QUERY ?? "سيد";

it(`probes ${ID} against its live site`, { timeout: 300_000 }, async () => {
  // Every method below is try/caught so one failure doesn't stop the rest
  // from being probed — but that means nothing here throws on its own, and
  // an `it()` body that resolves without throwing is a vitest PASS
  // regardless of what the printed lines above it say. `failed` plus the
  // `finish()` check at every exit point is what makes the process exit
  // code (and vitest's own pass/fail) track the printed PASS/FAIL lines
  // instead of going green no matter what the site did.
  const failed: string[] = [];
  const pass = (l: string, d: string) => console.log(`  PASS  ${l} — ${d}`);
  const fail = (l: string, e: unknown) => {
    failed.push(l);
    console.log(`  FAIL  ${l} — ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`);
  };
  const finish = () => {
    if (failed.length > 0) {
      throw new Error(`${failed.length} method(s) failed: ${failed.join(", ")}`);
    }
  };

  const mod = await import(`../extensions/${ID}/src/index.ts`);
  const source: Source = mod.default(host);
  console.log(`\n=== ${ID} — live probe ===`);

  let novelUrl = "";
  try {
    const sections = await source.getHomeSections();
    pass("getHomeSections", `${sections.length} sections, ${sections.reduce((n, s) => n + s.cards.length, 0)} cards`);
    for (const s of sections) console.log(`        · ${s.title} (${s.cards.length})`);
    novelUrl = sections.flatMap((s) => s.cards)[0]?.url ?? "";
  } catch (e) {
    fail("getHomeSections", e);
  }

  try {
    const r = await source.search(QUERY, 1);
    pass("search", `${r.cards.length} cards, hasMore=${r.hasMore}`);
    if (!novelUrl) novelUrl = r.cards[0]?.url ?? "";
  } catch (e) {
    fail("search", e);
  }

  if (!novelUrl) {
    console.log("  SKIP  getNovel — no novel URL discovered");
    return finish();
  }
  console.log(`  ----  novel: ${novelUrl}`);

  let novel: Awaited<ReturnType<Source["getNovel"]>>;
  try {
    novel = await source.getNovel(novelUrl);
    pass(
      "getNovel",
      `"${novel.title}" author="${novel.author}" vols=${novel.volumes.length} ` +
        `tags=${novel.tags.length} meta=${novel.meta.length} cover=${novel.coverUrl ? "yes" : "no"}`,
    );
  } catch (e) {
    fail("getNovel", e);
    return finish();
  }

  let chapter = novel.volumes.flatMap((v) => v.chapters)[0];
  if (!chapter && source.getVolumeChapters) {
    try {
      const ch = await source.getVolumeChapters(novelUrl, novel.volumes[0]);
      pass("getVolumeChapters", `${ch.length} chapters`);
      chapter = ch[0];
    } catch (e) {
      fail("getVolumeChapters", e);
    }
  }

  if (!chapter) {
    console.log("  SKIP  getChapterContent — no chapter available");
  } else {
    try {
      const lines = await source.getChapterContent(chapter);
      const text = lines.filter((l) => l.type === "text");
      pass("getChapterContent", `${lines.length} lines, ${text.reduce((n, l) => n + l.content.length, 0)} chars`);
    } catch (e) {
      fail("getChapterContent", e);
    }
  }

  // Optional, and stateful rather than a plain parse: cenele's
  // searchChapters depends on per-novel state (mangaId + a chapters
  // nonce) that only getNovel seeds, and throws its own "called before
  // getNovel" error if that state is missing. A fixture test can never
  // exercise that ordering dependency — only a live, sequential run like
  // this one calls getNovel and searchChapters in the same session.
  if (typeof source.searchChapters === "function") {
    try {
      const results = await source.searchChapters(novelUrl, QUERY);
      pass("searchChapters", `${results.length} chapters`);
    } catch (e) {
      fail("searchChapters", e);
    }
  } else {
    console.log("  SKIP  searchChapters — not implemented by this source");
  }

  finish();
});
