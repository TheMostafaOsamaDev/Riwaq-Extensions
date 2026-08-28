import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_VERSION, loadManifest, validateManifest } from "./manifest";

// Written before scripts/manifest.ts exists — every rejection below must be
// watched failing (module-not-found, then assertion failures) before the
// validator is implemented.

function validRawManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "cenele",
    name: "Test Novel Site",
    version: "1.0.0",
    apiVersion: API_VERSION,
    language: "ar",
    baseUrl: "https://cenele.com",
    icon: "icon.png",
    description: { en: "A test extension." },
    author: "Someone",
    ...overrides,
  };
}

/** Returns a copy of `obj` with `key` removed — used for the "missing
 *  required field" cases. A plain destructure-and-discard
 *  (`const { key, ...rest } = obj`) also works but leaves `key` unused,
 *  which trips `noUnusedLocals`; this sidesteps that entirely. */
function omit(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}

describe("validateManifest", () => {
  it("accepts a fully valid manifest", () => {
    const raw = validRawManifest();
    expect(validateManifest(raw, "cenele")).toEqual(raw);
  });

  it("rejects a missing id", () => {
    expect(() => validateManifest(omit(validRawManifest(), "id"), "cenele")).toThrow(/"id"/);
  });

  it("rejects a non-kebab-case id", () => {
    expect(() => validateManifest(validRawManifest({ id: "Cenele_Site" }), "cenele")).toThrow(
      /"id"/,
    );
  });

  it("rejects an id that does not match its directory name", () => {
    expect(() => validateManifest(validRawManifest({ id: "cenele" }), "some-other-dir")).toThrow(
      /"id"/,
    );
  });

  it("rejects a missing version", () => {
    expect(() => validateManifest(omit(validRawManifest(), "version"), "cenele")).toThrow(
      /"version"/,
    );
  });

  it("rejects a non-semver version", () => {
    expect(() => validateManifest(validRawManifest({ version: "1.0" }), "cenele")).toThrow(
      /"version"/,
    );
  });

  it("rejects a missing apiVersion", () => {
    expect(() => validateManifest(omit(validRawManifest(), "apiVersion"), "cenele")).toThrow(
      /"apiVersion"/,
    );
  });

  it("rejects an apiVersion that is not the integer 1", () => {
    expect(() => validateManifest(validRawManifest({ apiVersion: 2 }), "cenele")).toThrow(
      /"apiVersion"/,
    );
  });

  it("rejects an apiVersion given as a numeric string", () => {
    expect(() => validateManifest(validRawManifest({ apiVersion: "1" }), "cenele")).toThrow(
      /"apiVersion"/,
    );
  });

  it("rejects a missing name", () => {
    expect(() => validateManifest(omit(validRawManifest(), "name"), "cenele")).toThrow(/"name"/);
  });

  it("rejects a missing language", () => {
    expect(() => validateManifest(omit(validRawManifest(), "language"), "cenele")).toThrow(
      /"language"/,
    );
  });

  it("rejects a missing baseUrl", () => {
    expect(() => validateManifest(omit(validRawManifest(), "baseUrl"), "cenele")).toThrow(
      /"baseUrl"/,
    );
  });

  it("rejects a missing author", () => {
    expect(() => validateManifest(omit(validRawManifest(), "author"), "cenele")).toThrow(
      /"author"/,
    );
  });

  it("rejects a baseUrl that is not https:", () => {
    expect(() =>
      validateManifest(validRawManifest({ baseUrl: "http://cenele.com" }), "cenele"),
    ).toThrow(/"baseUrl"/);
  });

  it("rejects a baseUrl that is not a valid URL at all", () => {
    expect(() => validateManifest(validRawManifest({ baseUrl: "not a url" }), "cenele")).toThrow(
      /"baseUrl"/,
    );
  });

  it("rejects a description that is not an object", () => {
    expect(() =>
      validateManifest(validRawManifest({ description: "just text" }), "cenele"),
    ).toThrow(/"description"/);
  });

  it("rejects a description that lacks an en key", () => {
    expect(() =>
      validateManifest(validRawManifest({ description: { ar: "..." } }), "cenele"),
    ).toThrow(/"description"/);
  });

  it("rejects a missing icon", () => {
    expect(() => validateManifest(omit(validRawManifest(), "icon"), "cenele")).toThrow(/"icon"/);
  });

  it("rejects an icon that is not icon.png", () => {
    expect(() => validateManifest(validRawManifest({ icon: "logo.svg" }), "cenele")).toThrow(
      /"icon"/,
    );
  });

  // scripts/new-extension.ts scaffolds `name`, `author` and `description.en`
  // with exactly these "TODO: ..." placeholders (see manifestJson() there).
  // An accidentally-merged scaffold would otherwise pass every check above
  // — non-empty strings, a valid https baseUrl, a real icon.png — and
  // publish a permanently-broken "TODO: Display Name" extension.
  it('rejects a name still carrying the scaffold\'s "TODO:" placeholder', () => {
    expect(() =>
      validateManifest(validRawManifest({ name: "TODO: Display Name" }), "cenele"),
    ).toThrow(/"name".*TODO:/s);
  });

  it('rejects an author still carrying the scaffold\'s "TODO:" placeholder', () => {
    expect(() =>
      validateManifest(validRawManifest({ author: "TODO: your name" }), "cenele"),
    ).toThrow(/"author".*TODO:/s);
  });

  it('rejects a description.en still carrying the scaffold\'s "TODO:" placeholder', () => {
    expect(() =>
      validateManifest(
        validRawManifest({
          description: { en: "TODO: one-line description shown in the sources list." },
        }),
        "cenele",
      ),
    ).toThrow(/"description\.en".*TODO:/s);
  });

  it('rejects a "TODO:" placeholder in a non-English description locale too', () => {
    expect(() =>
      validateManifest(
        validRawManifest({ description: { en: "Fine.", ar: "TODO: ترجمة عربية" } }),
        "cenele",
      ),
    ).toThrow(/"description\.ar".*TODO:/s);
  });

  it('does not reject the word "todo" when it is not the scaffold\'s "TODO:" marker', () => {
    // Only the literal scaffold marker is rejected — an ordinary sentence
    // that happens to contain the word "todo" (no colon, wrong case) must
    // not be blocked.
    expect(() =>
      validateManifest(validRawManifest({ name: "My Todo List Novels" }), "cenele"),
    ).not.toThrow();
  });

  it("accepts a fully filled-in manifest scaffolded by new-extension", () => {
    // The full scaffold shape from scripts/new-extension.ts, but with every
    // TODO placeholder actually replaced — this must still validate cleanly.
    expect(() =>
      validateManifest(
        validRawManifest({
          name: "Real Display Name",
          author: "A Real Author",
          description: { en: "A real one-line description." },
        }),
        "cenele",
      ),
    ).not.toThrow();
  });
});

describe("loadManifest", () => {
  it("reads manifest.json from a directory and validates it against the directory's own name", () => {
    // mkdtemp's random suffix is not guaranteed kebab-case (it can include
    // uppercase letters), so nest a controlled, known-kebab-case directory
    // inside it rather than using the mkdtemp'd path's own basename as id.
    const parent = mkdtempSync(join(tmpdir(), "riwaq-manifest-test-"));
    const dir = join(parent, "sample-ext");
    try {
      mkdirSync(dir);
      writeFileSync(
        join(dir, "manifest.json"),
        JSON.stringify(validRawManifest({ id: "sample-ext" })),
      );
      const manifest = loadManifest(dir);
      expect(manifest.id).toBe("sample-ext");
      expect(manifest.name).toBe("Test Novel Site");
      expect(manifest.description).toEqual({ en: "A test extension." });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("throws a clear error naming manifest.json when the file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "riwaq-manifest-test-"));
    try {
      expect(() => loadManifest(dir)).toThrow(/manifest\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws a clear error when manifest.json is not valid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "riwaq-manifest-test-"));
    try {
      writeFileSync(join(dir, "manifest.json"), "{ not json");
      expect(() => loadManifest(dir)).toThrow(/manifest\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
