## What changed and why



## Checklist

- [ ] `manifest.json`'s `version` was bumped, if any extension's files changed — and on
      **every** extension, if `packages/` or `scripts/build.ts` changed (both are inlined
      into every published bundle)
- [ ] Tests added or updated for the change
- [ ] New/changed fixtures under `tests/fixtures/` are derived from real markup captured
      from the live site (elements/attributes copied verbatim, then trimmed to what the
      parser reads) — not invented from scratch
- [ ] `pnpm typecheck && pnpm test && pnpm validate && pnpm build` all pass locally
- [ ] `README.md` (root or the extension's own) updated, if behaviour changed
