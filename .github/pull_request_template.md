## What changed and why



## Checklist

- [ ] `manifest.json`'s `version` was bumped, if any extension's files changed — and on
      **every** extension, if `packages/` or `scripts/build.ts` changed (both are inlined
      into every published bundle)
- [ ] Tests added or updated for the change
- [ ] New/changed fixtures under `tests/fixtures/` are **unedited** captures of a page the
      live site actually served — not invented from scratch, and not trimmed down to what
      the parser reads (`vitest.config.ts` configures happy-dom to survive a real page's
      ads, analytics and framework tags, so there is nothing left to strip)
- [ ] `pnpm typecheck && pnpm test && pnpm validate && pnpm build` all pass locally
- [ ] `README.md` (root or the extension's own) updated, if behaviour changed
