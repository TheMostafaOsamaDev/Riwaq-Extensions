import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Extension parsers need DOMParser; the whole suite is parser tests.
    environment: "happy-dom",
    include: ["packages/**/*.test.ts", "extensions/**/*.test.ts", "scripts/**/*.test.ts"],
  },
  resolve: {
    alias: { "@riwaq/extension-api": new URL("./packages/extension-api/src/index.ts", import.meta.url).pathname },
  },
});
