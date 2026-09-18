import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Extension parsers need DOMParser; the whole suite is parser tests.
    environment: "happy-dom",
    include: ["packages/**/*.test.ts", "extensions/**/*.test.ts", "scripts/**/*.test.ts"],
    // A fixture captured straight off a live page carries an external
    // <script src> / <link> for every ads, analytics and framework chunk,
    // plus (for a Next.js site) inline Suspense-replacement scripts and ad
    // <iframe>s. None of that is inert under happy-dom the way it is in a
    // real browser's DOMParser, and the two hazards are SEPARATE — measured
    // against all four unstripped fixtures on happy-dom 15.11.7:
    //
    //   drop handleDisabledFileLoadingAsSuccess  -> 98 unhandled rejections
    //   drop disableJavaScriptEvaluation         ->  0 errors, all parse
    //
    // So the thing that actually kills a run is the ERROR EVENT dispatched
    // for each disabled external load, not inline evaluation: a throwing
    // inline script is caught rather than fatal. handleDisabledFileLoading-
    // AsSuccess is what fixes that, by making the disabled load report a
    // synthetic "load" instead.
    //
    // disableJavaScriptEvaluation earns its place for a different reason:
    // it stops an inline script from RUNNING and mutating the tree under
    // test (a Next.js payload's `$RC(...)` rewrites Suspense boundaries in
    // place). Every extension here only ever READS the parsed tree — cenele
    // reads nhvNovelV2 out of a script's textContent, sunovels regexes
    // chaptersCount out of one — and turning evaluation off leaves
    // textContent fully readable, so nothing any extension can observe
    // changes. Together they let a fixture be committed as a genuine,
    // unedited live capture instead of hand-stripped to dodge the harness.
    environmentOptions: {
      happyDOM: {
        settings: {
          disableJavaScriptEvaluation: true,
          disableJavaScriptFileLoading: true,
          disableCSSFileLoading: true,
          disableComputedStyleRendering: true,
          // A live page's ad/analytics <iframe>s (sunovels' homepage
          // carries two) try to actually load their `src` the same way
          // an external <script> would, and dispatching THAT failure
          // hits the identical no-defaultView wall as both cases above.
          disableIframePageLoading: true,
          // A live page's <script src="..."> tags (ads/analytics bundles)
          // would otherwise each dispatch an error event once loading is
          // disabled above — and dispatching that error throws for the
          // same reason (no defaultView) as the inline-script case above,
          // turning into an unhandled rejection that fails the whole run
          // even though every Source method under test already passed.
          // This makes the disabled load a synthetic "load" event instead,
          // which is inert either way since nothing here ever runs it.
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
      // The subpath must be listed before the bare specifier: it needs its
      // own exact-match entry pointing at testing.ts, since the package's
      // `./testing` export condition (for real consumers outside vitest)
      // isn't something this alias map understands.
      "@riwaq/extension-api/testing": new URL("./packages/extension-api/src/testing.ts", import.meta.url)
        .pathname,
      "@riwaq/extension-api": new URL("./packages/extension-api/src/index.ts", import.meta.url).pathname,
    },
  },
});
