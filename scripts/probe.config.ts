import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["scripts/probe.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // Live pages carry ad and analytics tags plus the site's own bundles.
    // happy-dom executes inline <script> on insert and that code throws
    // outside a real browser, surfacing as a bogus parse failure.
    // Extensions only ever READ the parsed tree — cenele reads nhvNovelV2
    // out of a script's textContent, it never runs it — so turning
    // evaluation off changes nothing an extension can observe.
    environmentOptions: {
      happyDOM: {
        settings: {
          disableJavaScriptEvaluation: true,
          disableJavaScriptFileLoading: true,
          disableCSSFileLoading: true,
          disableComputedStyleRendering: true,
          // Live pages also carry <script src="..."> tags (ads/analytics
          // bundles). With disableJavaScriptFileLoading on, happy-dom's
          // default is to dispatch an error event for each one — and
          // dispatching that error throws (`Cannot read properties of
          // null (reading 'console')`) because the DOMParser-created
          // document these extensions parse into has no defaultView. That
          // throw becomes an unhandled rejection that fails the whole run
          // even though every Source method it was measuring passed. This
          // makes the disabled load a synthetic "load" event instead of an
          // error, which is inert either way since nothing here ever runs
          // the script.
          //
          // @ts-expect-error — vitest@2.1.9 vendors an older happy-dom
          // settings type that doesn't know this field yet; the installed
          // happy-dom (15.11.7) honors it at runtime regardless. Drop this
          // once vitest's vendored type catches up.
          handleDisabledFileLoadingAsSuccess: true,
        },
      },
    },
  },
  resolve: {
    alias: {
      "@riwaq/extension-api/testing": new URL("../packages/extension-api/src/testing.ts", import.meta.url).pathname,
      "@riwaq/extension-api": new URL("../packages/extension-api/src/index.ts", import.meta.url).pathname,
    },
  },
});
