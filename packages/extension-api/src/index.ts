// The public barrel. Everything an extension needs to import types and
// pure helpers comes from here. `./testing` is deliberately not re-exported
// — it is reached only via the package's `./testing` export condition, so
// test-only fixtures (createTestHost) can never end up inside a shipped
// extension bundle.

export * from "./types";
export * from "./dom";
