import { describe, expect, it } from "vitest";
import { decideVersionBumps } from "./check-version-bump";
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
