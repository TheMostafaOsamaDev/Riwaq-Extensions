# SeaNovel — `extensions/seanovel`

Site: <https://seanovel.org> (بحر الروايات)

Korean, Chinese and Japanese web novels translated into Arabic. Novel pages
live at `/novels/<slug>`, chapters at `/novels/<slug>/chapters/<id>`. The
site serves its data through a JSON API rather than server-rendered HTML;
home sections, search, novel detail and chapter content are implemented
against that API in later tasks.

## Capabilities

| Method                | Supported | Notes |
|-----------------------|-----------|-------|
| `canHandle`           | ✓         | matches `seanovel.org` and `www.seanovel.org` |
| `getHomeSections`     | not yet   | |
| `search`              | not yet   | |
| `getNovel`            | not yet   | |
| `getChapterContent`   | not yet   | |

This extension is scaffolded via `pnpm new-extension seanovel`; every
method beyond `canHandle` still throws `"not implemented"` and is filled
in one at a time by the tasks that follow in this plan.

## `canHandle`

Accepts `https://seanovel.org/...` and `https://www.seanovel.org/...` —
any path, since only the hostname is checked. Anything else, or a string
that isn't a valid URL at all, returns `false` rather than throwing.

## i18n

`src/strings.ts` ships this extension's own fallback strings, keyed off
`host.locale` (`"en" | "ar"`). It cannot reach the app's message
catalogue. No fallback keys are needed yet — they'll be added as the
site's discovery/search/novel/chapter parsing needs them.
