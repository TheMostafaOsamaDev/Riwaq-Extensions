// Shared manifest schema, validation and loading, used by both
// scripts/build.ts and scripts/validate.ts. `validateManifest` is
// deliberately the single place every manifest rule from the design doc
// is enforced — in particular the "en" locale key inside `description`,
// which the runtime `SourceMetadata.description` type (in
// @riwaq/extension-api) can only type as `Record<string, string>` and so
// cannot enforce on its own. This is where that gets enforced instead.
//
// Imported via a relative path into the package's source rather than the
// `@riwaq/extension-api` bare specifier — not because the bare specifier
// is unresolvable under `tsx`. Whether it resolves depends on node_modules
// linking, and nothing in this repo actually declares that dependency: no
// package.json here — not the root's, not this package's own — lists
// `@riwaq/extension-api`, so whether pnpm happens to have linked it into
// node_modules in a given checkout isn't something this script controls
// or can rely on. The relative import sidesteps that question entirely:
// it needs no workspace-linking at all, so it can't be broken by an
// undeclared virtual-store link that happens to resolve in today's
// node_modules but has no guarantee of surviving a fresh, from-scratch
// CI install.
import { API_VERSION } from "../packages/extension-api/src/index";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

export { API_VERSION };

/** A locale map for the extension's one-line description. `en` is
 *  required as the fallback the host uses when its current locale has no
 *  entry of its own — see SourceMetadata.description in
 *  @riwaq/extension-api, which can only type this as
 *  `Record<string, string>` and cannot require the "en" key itself. */
export interface ManifestDescription {
  en: string;
  [locale: string]: string;
}

export interface ExtensionManifest {
  /** Stable machine-readable id, kebab-case, matching the extension's
   *  directory name under extensions/. */
  id: string;
  name: string;
  /** Semver (e.g. "1.0.0"). Bumped whenever the extension's source changes. */
  version: string;
  /** Major version of @riwaq/extension-api this extension targets. Must
   *  equal the contract package's own API_VERSION. */
  apiVersion: number;
  /** BCP-47 language tag, e.g. "ar", "en". */
  language: string;
  /** Origin this extension handles. Must be an https: URL. */
  baseUrl: string;
  /** Always "icon.png" — a 128x128 PNG sitting next to manifest.json. */
  icon: string;
  description: ManifestDescription;
  author: string;
}

// Exported so scripts/new-extension.ts can refuse a non-kebab-case id with
// the exact same rule this validator enforces, instead of a second regex
// that could quietly drift from this one.
export const KEBAB_CASE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// The canonical semver pattern published at https://semver.org (App A).
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function fail(source: string, field: string, detail: string): never {
  throw new Error(`extensions/${source}: manifest field "${field}" ${detail}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// `scripts/new-extension.ts` scaffolds `name`, `author` and
// `description.en` with a literal "TODO: ..." placeholder (see its
// manifestJson()) so the scaffold typechecks, tests and even bundles
// immediately. Nothing about a leftover placeholder is otherwise
// syntactically wrong — it's a non-empty string, an https baseUrl still
// validates, etc — so an accidentally-merged scaffold would otherwise
// pass `pnpm validate` and `pnpm build` and publish an installable,
// permanently-broken "TODO: Display Name" extension. This rejects any
// string field that still contains the same marker, naming the field, so
// the scaffold fails validation until its author actually fills it in.
const TODO_MARKER_RE = /TODO:/;

function rejectTodoPlaceholder(source: string, field: string, value: string): void {
  if (TODO_MARKER_RE.test(value)) {
    fail(
      source,
      field,
      `still contains a "TODO:" placeholder (${JSON.stringify(value)}) — ` +
        "replace it with the real value before this extension can be validated or built.",
    );
  }
}

function requireNonEmptyString(
  raw: Record<string, unknown>,
  field: string,
  source: string,
): string {
  const value = raw[field];
  if (typeof value !== "string" || value.trim() === "") {
    fail(source, field, "is required");
  }
  return value;
}

/**
 * Validate a parsed `manifest.json` payload. Throws an Error naming the
 * offending field on the first rule violated; returns a fully-typed
 * ExtensionManifest once every rule passes.
 *
 * `source` is the extension's directory name under extensions/ (e.g.
 * "cenele") — it is both what `id` must match and what every thrown
 * message names the extension by.
 */
export function validateManifest(raw: unknown, source: string): ExtensionManifest {
  if (!isPlainObject(raw)) {
    throw new Error(`extensions/${source}: manifest.json must contain a JSON object`);
  }

  const id = requireNonEmptyString(raw, "id", source);
  rejectTodoPlaceholder(source, "id", id);
  if (!KEBAB_CASE_RE.test(id)) {
    fail(
      source,
      "id",
      `must be kebab-case (lowercase letters, digits, hyphens), got ${JSON.stringify(id)}`,
    );
  }
  if (id !== source) {
    fail(source, "id", `must match its directory name "${source}", got ${JSON.stringify(id)}`);
  }

  const version = requireNonEmptyString(raw, "version", source);
  rejectTodoPlaceholder(source, "version", version);
  if (!SEMVER_RE.test(version)) {
    fail(source, "version", `must be valid semver (e.g. "1.0.0"), got ${JSON.stringify(version)}`);
  }

  const apiVersion = raw.apiVersion;
  if (typeof apiVersion !== "number" || !Number.isInteger(apiVersion) || apiVersion !== API_VERSION) {
    fail(
      source,
      "apiVersion",
      `must be the integer ${API_VERSION}, got ${JSON.stringify(apiVersion ?? null)}`,
    );
  }

  const name = requireNonEmptyString(raw, "name", source);
  rejectTodoPlaceholder(source, "name", name);
  const language = requireNonEmptyString(raw, "language", source);
  rejectTodoPlaceholder(source, "language", language);
  const baseUrl = requireNonEmptyString(raw, "baseUrl", source);
  rejectTodoPlaceholder(source, "baseUrl", baseUrl);
  const author = requireNonEmptyString(raw, "author", source);
  rejectTodoPlaceholder(source, "author", author);

  let isHttps = false;
  try {
    isHttps = new URL(baseUrl).protocol === "https:";
  } catch {
    isHttps = false;
  }
  if (!isHttps) {
    fail(source, "baseUrl", `must be an "https:" URL, got ${JSON.stringify(baseUrl)}`);
  }

  const description = raw.description;
  if (!isPlainObject(description) || typeof description.en !== "string" || description.en.trim() === "") {
    fail(source, "description", 'must be an object with a required "en" key, e.g. { "en": "..." }');
  }
  for (const [locale, value] of Object.entries(description)) {
    if (typeof value === "string") {
      rejectTodoPlaceholder(source, `description.${locale}`, value);
    }
  }

  const icon = requireNonEmptyString(raw, "icon", source);
  rejectTodoPlaceholder(source, "icon", icon);
  if (icon !== "icon.png") {
    fail(source, "icon", `must be "icon.png", got ${JSON.stringify(icon)}`);
  }

  return {
    id,
    name,
    version,
    apiVersion,
    language,
    baseUrl,
    icon,
    description: description as ManifestDescription,
    author,
  };
}

/** Read and validate `<dir>/manifest.json`. `source` for validation
 *  purposes is `basename(dir)`, so `id` is checked against the actual
 *  directory this manifest was loaded from. */
export function loadManifest(dir: string): ExtensionManifest {
  const source = basename(dir);
  const manifestPath = join(dir, "manifest.json");

  let text: string;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch (err) {
    throw new Error(
      `extensions/${source}: could not read manifest.json (${(err as Error).message})`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `extensions/${source}: manifest.json is not valid JSON (${(err as Error).message})`,
    );
  }

  return validateManifest(raw, source);
}
