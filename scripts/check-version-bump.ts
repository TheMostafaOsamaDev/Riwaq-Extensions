// Fails a PR when an extension's files changed but its manifest `version`
// didn't move, comparing against the version already published on the
// `repo` branch's dist/index.min.json (the catalogue GitHub Pages serves
// and the reader app polls). Without this, a contributor could ship
// changed code under an already-published version number, and a reader
// that treats (id, version) as an immutable, cacheable pair would never
// see the new code.
//
// "Changed" means "changed in a way that reaches a published bundle",
// which is wider than `extensions/`: build.ts bundles, so
// packages/extension-api is inlined verbatim into all four served
// bundles. See SHARED_BUNDLE_PATHS.
//
// `decideChangedExtensionIds` and `decideVersionBumps` are pure functions
// over already-collected data and are what check-version-bump.test.ts
// exercises with fabricated inputs.
// Everything else in this file is git/filesystem glue that turns the real
// repository state into that input shape; it deliberately has no
// exported unit tests of its own (see the brief: "test the comparison
// logic, not git").
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { loadManifest } from "./manifest";

// See build.ts for why this is not `fileURLToPath(new URL("..", import.meta.url))`.
const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const EXTENSIONS_DIR = join(REPO_ROOT, "extensions");

const REMOTE = "origin";
const REPO_BRANCH = "repo";

/** The shape of dist/index.min.json this script actually reads — a
 *  subset of build.ts's RepoIndex, kept local so this script has no
 *  compile-time dependency on build.ts. */
export interface PublishedIndex {
  extensions: Array<{ id: string; version: string }>;
}

export interface VersionBumpCheckInput {
  /** Extension ids whose files changed between the merge base and HEAD. */
  changedIds: string[];
  /** id -> version, read from extensions/<id>/manifest.json at HEAD.
   *  An id present in `changedIds` but absent here means its manifest no
   *  longer exists at HEAD (e.g. the extension was deleted). */
  currentVersions: Map<string, string>;
  /** Parsed contents of the `repo` branch's index.min.json, or `null`
   *  when that branch does not exist yet (the very first publish). */
  published: PublishedIndex | null;
}

export interface VersionBumpViolation {
  id: string;
  version: string;
}

export interface VersionBumpCheckResult {
  ok: boolean;
  violations: VersionBumpViolation[];
  /** Human-readable, one per changed extension (or a single explanatory
   *  note when the check is skipped) — printed as-is by `main`. */
  notes: string[];
}

/** Paths whose contents end up INSIDE every published extension bundle,
 *  even though they live outside `extensions/`.
 *
 *  `scripts/build.ts` runs esbuild with `bundle: true`, so
 *  `packages/extension-api` is inlined verbatim into each bundle rather
 *  than imported at runtime (`grep -c '^import' dist/*\/index.js` → 0).
 *  A one-line edit to `packages/extension-api/src/dom.ts`, or to the
 *  esbuild settings in `scripts/build.ts` itself, therefore changes all
 *  four SERVED bundles while touching nothing under `extensions/` — and
 *  this check used to diff `-- extensions` only, print "no extensions
 *  changed", and let publish.yml republish every bundle under its
 *  already-published `(id, version)` pair. A reader that treats that pair
 *  as immutable and cacheable would never see the new code.
 *
 *  Deliberately coarse: one changed file anywhere under `packages/` marks
 *  EVERY extension changed. Resolving which extensions actually import
 *  the touched module would need a real import graph, and with a single
 *  shared package that every extension depends on, the answer is "all of
 *  them" anyway. Over-reporting costs a version bump nobody strictly
 *  needed; under-reporting silently overwrites a published version. */
const SHARED_BUNDLE_PATHS = ["packages/", "scripts/build.ts"];

/** True when `path` is one of the shared inputs above. Prefix match for
 *  the directory entry, exact match for the file. */
function isSharedBundlePath(path: string): boolean {
  return SHARED_BUNDLE_PATHS.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
}

/**
 * Pure decision function: map a list of changed repository paths onto the
 * extension ids whose published bundle those changes affect.
 *
 * `allExtensionIds` is every extension that exists at HEAD — needed
 * because a change to a shared bundle input (see SHARED_BUNDLE_PATHS)
 * affects extensions whose own directories are untouched, so they cannot
 * be discovered from the changed paths themselves.
 */
export function decideChangedExtensionIds(
  changedPaths: string[],
  allExtensionIds: string[],
): string[] {
  const ids = new Set<string>();
  for (const raw of changedPaths) {
    const path = raw.trim();
    if (path.length === 0) continue;
    if (isSharedBundlePath(path)) return [...allExtensionIds].sort();
    const match = /^extensions\/([^/]+)\//.exec(path);
    if (match) ids.add(match[1]);
  }
  return [...ids].sort();
}

/**
 * Pure decision function: for each changed extension, compare its current
 * manifest version against the version already published on the `repo`
 * branch. An extension is a violation only when it changed AND it was
 * already published AND the version string is unchanged.
 *
 * Skips cleanly (ok: true, no violations) when `published` is null — the
 * `repo` branch doesn't exist yet, which is the expected state for the
 * very first publish and must not block it.
 */
export function decideVersionBumps(input: VersionBumpCheckInput): VersionBumpCheckResult {
  if (input.published === null) {
    return {
      ok: true,
      violations: [],
      notes: [`'${REPO_BRANCH}' branch does not exist yet (first publish) — skipping.`],
    };
  }

  const publishedVersions = new Map(input.published.extensions.map((e) => [e.id, e.version]));
  const violations: VersionBumpViolation[] = [];
  const notes: string[] = [];

  for (const id of input.changedIds) {
    const current = input.currentVersions.get(id);
    if (current === undefined) {
      notes.push(`${id}: changed, but has no manifest at HEAD (deleted?) — skipping.`);
      continue;
    }

    const prior = publishedVersions.get(id);
    if (prior === undefined) {
      notes.push(`${id}: not yet published — brand-new extension, skipping.`);
      continue;
    }

    if (prior === current) {
      violations.push({ id, version: current });
    } else {
      notes.push(`${id}: version bumped ${prior} -> ${current}.`);
    }
  }

  return { ok: violations.length === 0, violations, notes };
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
}

/** True when `<remote>/<branch>` exists, without requiring it to already
 *  be fetched locally. Exit code 2 from `git ls-remote --exit-code` is
 *  its documented "ref not found" signal; anything else (network error,
 *  bad remote, ...) is a real failure and is rethrown rather than
 *  silently treated as "branch missing". */
function remoteBranchExists(remote: string, branch: string): boolean {
  try {
    execFileSync("git", ["ls-remote", "--exit-code", "--heads", remote, branch], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
    return true;
  } catch (err) {
    const status = (err as { status?: number | null }).status;
    if (status === 2) return false;
    throw err;
  }
}

function loadPublishedIndex(remote: string, branch: string): PublishedIndex | null {
  if (!remoteBranchExists(remote, branch)) return null;
  git(["fetch", "--quiet", "--depth=1", remote, branch]);
  const raw = git(["show", `${remote}/${branch}:index.min.json`]);
  return JSON.parse(raw) as PublishedIndex;
}

function getMergeBase(remote: string, baseRef: string): string {
  git(["fetch", "--quiet", remote, baseRef]);
  return git(["merge-base", `${remote}/${baseRef}`, "HEAD"]).trim();
}

/** Every extension directory that exists at HEAD — the working tree is
 *  HEAD in CI, and this script is only ever meaningful there. */
function listExtensionIds(): string[] {
  if (!existsSync(EXTENSIONS_DIR)) return [];
  return readdirSync(EXTENSIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Extension ids whose published bundle changed between `mergeBase` and
 *  HEAD. The diff is deliberately NOT scoped to `extensions` alone — see
 *  SHARED_BUNDLE_PATHS for what else ends up inside a bundle. */
function getChangedExtensionIds(mergeBase: string): string[] {
  const output = git([
    "diff",
    "--name-only",
    `${mergeBase}...HEAD`,
    "--",
    "extensions",
    "packages",
    "scripts/build.ts",
  ]);
  return decideChangedExtensionIds(output.split("\n"), listExtensionIds());
}

function loadCurrentVersions(ids: string[]): Map<string, string> {
  const versions = new Map<string, string>();
  for (const id of ids) {
    const dir = join(EXTENSIONS_DIR, id);
    if (!existsSync(join(dir, "manifest.json"))) continue;
    versions.set(id, loadManifest(dir).version);
  }
  return versions;
}

function main(): void {
  let published: PublishedIndex | null;
  try {
    published = loadPublishedIndex(REMOTE, REPO_BRANCH);
  } catch (err) {
    console.error(
      `check-version-bump: could not read '${REMOTE}/${REPO_BRANCH}': ${(err as Error).message}`,
    );
    process.exitCode = 1;
    return;
  }

  if (published === null) {
    console.log(
      `check-version-bump: '${REPO_BRANCH}' branch does not exist yet on '${REMOTE}' ` +
        "(first publish) — skipping version-bump check.",
    );
    return;
  }

  // publish.yml (push to main) has no PR base to diff against —
  // GITHUB_BASE_REF is a pull_request-only variable, and by the time this
  // job runs, origin/main already IS this push's HEAD, so a merge-base
  // against it would always be HEAD itself and every diff would come back
  // empty. It instead passes the push event's own `before` SHA (the tip
  // of main immediately before this push) as PUBLISH_BASE_SHA, so
  // "changed" means "changed by this push", which is the comparison that
  // actually protects main-side pushes that skip PR CI entirely.
  const publishBaseSha = process.env.PUBLISH_BASE_SHA?.trim();

  let mergeBase: string;
  if (publishBaseSha) {
    if (/^0+$/.test(publishBaseSha)) {
      // The all-zero SHA is what GitHub sends as a push event's `before`
      // when a ref is newly created (e.g. main's very first push) — there
      // is no prior commit on this branch to diff against. That state
      // necessarily also means nothing has ever been published yet
      // either, which the `published === null` branch above already
      // handles — this is belt-and-suspenders for the same situation.
      console.log(
        "check-version-bump: no prior commit on this branch (first push) — nothing to check.",
      );
      return;
    }
    mergeBase = publishBaseSha;
  } else {
    // GITHUB_BASE_REF is set automatically by GitHub Actions on
    // pull_request runs; "main" is only a fallback for running this by
    // hand locally.
    const baseRef = process.env.GITHUB_BASE_REF?.trim() || "main";
    try {
      mergeBase = getMergeBase(REMOTE, baseRef);
    } catch (err) {
      console.error(
        `check-version-bump: could not compute the merge base against ` +
          `'${REMOTE}/${baseRef}': ${(err as Error).message}`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const changedIds = getChangedExtensionIds(mergeBase);
  if (changedIds.length === 0) {
    console.log(
      "check-version-bump: nothing that reaches a published bundle changed — nothing to check.",
    );
    return;
  }

  const currentVersions = loadCurrentVersions(changedIds);
  const result = decideVersionBumps({ changedIds, currentVersions, published });

  for (const note of result.notes) console.log(`  ${note}`);

  if (!result.ok) {
    console.error("");
    for (const v of result.violations) {
      console.error(
        `check-version-bump: extensions/${v.id} changed but its manifest "version" ` +
          `(${v.version}) was not bumped from the version already published on '${REPO_BRANCH}'.`,
      );
    }
    process.exitCode = 1;
    return;
  }

  console.log("check-version-bump: OK — every changed extension has a bumped version.");
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) main();
