# Contributing

The technical guide — what an extension is, the `Source` interface, the manifest
format, the `host` API, testing conventions — lives in [`README.md`](README.md). Start
there; this file only covers the process around a contribution.

## Opening a PR

1. `pnpm new-extension <id>` to scaffold a new extension, or edit an existing one under
   `extensions/<id>/`.
2. Before pushing, run:
   ```bash
   pnpm typecheck && pnpm test && pnpm validate && pnpm build
   ```
3. Open a PR against `main`. Fill in the PR template's checklist.

## What CI checks

`.github/workflows/ci.yml` runs on every PR: manifest validation, typecheck, the test
suite, a full build of every extension, and (once an extension is already published) a
check that its manifest `version` was bumped if any of its files changed. All of it has
to pass before a PR merges — there is no separate publish step to catch what CI missed.

Nothing a PR does publishes anything. Publishing only happens from `main` — see the
README's [Publishing](README.md#publishing) section.

## Review policy

**Bundles are built by CI from reviewed source, and are never uploaded pre-built.** A PR
is a diff of the TypeScript a reviewer can actually read; what eventually reaches the
published catalogue is always CI's own `esbuild` output from exactly that reviewed
source, never a `dist/` folder a contributor produced locally and attached to the PR.
This is the whole point of the review process — an extension's code runs inside the app
with real network and rendering capability, so what gets merged is what gets run.

## Reporting a broken extension

Open an issue with:

- the extension's id (`cenele`, `kolnovel`, …) and the version you have installed,
- what you did and what happened — a search query, a novel URL, a chapter that failed,
- the error message, if the app showed one.

If you can also identify what changed on the site itself (a redesigned page, a moved
selector), that's the single most useful thing to include — it's usually the entire fix.
