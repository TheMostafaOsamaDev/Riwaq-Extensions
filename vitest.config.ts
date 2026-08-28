import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Extension parsers need DOMParser; the whole suite is parser tests.
    environment: "happy-dom",
    include: ["packages/**/*.test.ts", "extensions/**/*.test.ts", "scripts/**/*.test.ts"],
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
