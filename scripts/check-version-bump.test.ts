import { describe, expect, it } from "vitest";
import { decideChangedExtensionIds, decideVersionBumps } from "./check-version-bump";
import type { PublishedIndex, VersionBumpCheckInput } from "./check-version-bump";

// Exercises `decideVersionBumps` — the pure comparison logic — with
// fabricated inputs only. Nothing here touches git, the filesystem or the
// network: the brief is explicit that the git/merge-base/repo-branch
// plumbing in check-version-bump.ts's `main` is not itself unit-tested.

function published(entries: Array<{ id: string; version: string }>): PublishedIndex {
  return { extensions: entries };
}

describe("decideVersionBumps", () => {
  it("passes a changed extension whose version was bumped", () => {
    const input: VersionBumpCheckInput = {
      changedIds: ["cenele"],
      currentVersions: new Map([["cenele", "1.1.0"]]),
      published: published([{ id: "cenele", version: "1.0.0" }]),
    };

    const result = decideVersionBumps(input);

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.notes).toEqual(["cenele: version bumped 1.0.0 -> 1.1.0."]);
  });

  it("fails a changed extension whose version was not bumped", () => {
    const input: VersionBumpCheckInput = {
      changedIds: ["cenele"],
      currentVersions: new Map([["cenele", "1.0.0"]]),
      published: published([{ id: "cenele", version: "1.0.0" }]),
    };

    const result = decideVersionBumps(input);

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([{ id: "cenele", version: "1.0.0" }]);
  });

  it("ignores an extension that did not change, regardless of its version state", () => {
    const input: VersionBumpCheckInput = {
      // "kolnovel" is deliberately absent from changedIds even though it
      // has an (unbumped) entry in both maps below — an unchanged
      // extension is never compared at all.
      changedIds: [],
      currentVersions: new Map([["kolnovel", "2.0.0"]]),
      published: published([{ id: "kolnovel", version: "2.0.0" }]),
    };

    const result = decideVersionBumps(input);

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.notes).toEqual([]);
  });

  it("passes a brand-new extension that has never been published", () => {
    const input: VersionBumpCheckInput = {
      changedIds: ["new-site"],
      currentVersions: new Map([["new-site", "1.0.0"]]),
      published: published([{ id: "cenele", version: "1.0.0" }]),
    };

    const result = decideVersionBumps(input);

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.notes).toEqual(["new-site: not yet published — brand-new extension, skipping."]);
  });

  it("skips cleanly when the repo branch does not exist yet (first publish)", () => {
    const input: VersionBumpCheckInput = {
      changedIds: ["cenele", "kolnovel"],
      currentVersions: new Map([
        ["cenele", "1.0.0"],
        ["kolnovel", "1.0.0"],
      ]),
      published: null,
    };

    const result = decideVersionBumps(input);

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.notes).toEqual([
      "'repo' branch does not exist yet (first publish) — skipping.",
    ]);
  });

  it("skips an extension deleted at HEAD instead of throwing", () => {
    const input: VersionBumpCheckInput = {
      changedIds: ["removed-site"],
      currentVersions: new Map(),
      published: published([{ id: "removed-site", version: "1.0.0" }]),
    };

    const result = decideVersionBumps(input);

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.notes).toEqual([
      "removed-site: changed, but has no manifest at HEAD (deleted?) — skipping.",
    ]);
  });

  it("handles several changed extensions independently in one call", () => {
    const input: VersionBumpCheckInput = {
      changedIds: ["cenele", "kolnovel"],
      currentVersions: new Map([
        ["cenele", "1.1.0"], // bumped
        ["kolnovel", "1.0.0"], // not bumped
      ]),
      published: published([
        { id: "cenele", version: "1.0.0" },
        { id: "kolnovel", version: "1.0.0" },
      ]),
    };

    const result = decideVersionBumps(input);

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([{ id: "kolnovel", version: "1.0.0" }]);
  });
});

// scripts/build.ts bundles (`bundle: true`), so packages/extension-api is
// inlined verbatim into every published bundle — `grep -c '^import'
// dist/*/index.js` returns 0 for all four. That makes "which extensions
// changed?" a wider question than "which extensions/ directories were
// touched?", and getting it wrong means publish.yml republishing changed
// bundles under an already-published (id, version) pair.
describe("decideChangedExtensionIds", () => {
  const ALL = ["cenele", "kolnovel", "seanovel", "sunovels"];

  it("reports only the extensions whose own directories changed", () => {
    expect(
      decideChangedExtensionIds(
        ["extensions/cenele/src/index.ts", "extensions/cenele/manifest.json"],
        ALL,
      ),
    ).toEqual(["cenele"]);
  });

  it("reports several touched extensions, sorted", () => {
    expect(
      decideChangedExtensionIds(
        ["extensions/sunovels/src/index.ts", "extensions/cenele/README.md"],
        ALL,
      ),
    ).toEqual(["cenele", "sunovels"]);
  });

  it("marks EVERY extension changed when a shared package changed", () => {
    // A one-line edit here changes all four SERVED bundles while touching
    // nothing under extensions/. Scoping the diff to `-- extensions` (what
    // this used to do) printed "nothing to check" for exactly this diff.
    expect(decideChangedExtensionIds(["packages/extension-api/src/dom.ts"], ALL)).toEqual(ALL);
  });

  it("marks EVERY extension changed when the build script changed", () => {
    // Same reasoning: the esbuild settings in build.ts decide what every
    // bundle's bytes are.
    expect(decideChangedExtensionIds(["scripts/build.ts"], ALL)).toEqual(ALL);
  });

  it("does not treat other scripts/ files as shared bundle inputs", () => {
    // Only build.ts feeds the bundles. This script, validate.ts, probe.ts
    // and friends never ship, so editing one must not demand four version
    // bumps.
    expect(
      decideChangedExtensionIds(["scripts/check-version-bump.ts", "scripts/validate.ts"], ALL),
    ).toEqual([]);
  });

  it("unions a shared change with a directly-touched extension without duplicating it", () => {
    expect(
      decideChangedExtensionIds(
        ["extensions/cenele/src/index.ts", "packages/extension-api/src/types.ts"],
        ALL,
      ),
    ).toEqual(ALL);
  });

  it("ignores blank lines and paths outside both scopes", () => {
    expect(decideChangedExtensionIds(["", "  ", "README.md", ".github/workflows/ci.yml"], ALL)).toEqual(
      [],
    );
  });

  it("does not match a file sitting directly in extensions/ with no extension directory", () => {
    expect(decideChangedExtensionIds(["extensions/README.md"], ALL)).toEqual([]);
  });
});
