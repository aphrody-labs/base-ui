// Fork-only (aphrody-labs/base-ui): `bun test` preload, the counterpart of the
// Vitest config in vitest.shared.mts (environment jsdom, globals, setupFiles).
// bun:test answers the `vitest` imports of the tests and of setupVitest.ts.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost", width: 1024, height: 768 });
process.env.VITEST = "true";

await import("./setupVitest.ts");
