# aphrody-labs/base-ui

Fork of [mui/base-ui](https://github.com/mui/base-ui) that installs, runs, tests and publishes with the
[Aphrody Bun fork](https://github.com/aphrody-labs/bun). Upstream source stays untouched; only tooling differs.

## Packages

| tree (upstream name) | published | consumers |
| --- | --- | --- |
| `packages/react` (`@base-ui/react`) | `@aphrody/base-ui` | alias `"@base-ui/react": "npm:@aphrody/base-ui@<v>"` |
| `packages/utils` (`@base-ui/utils`) | `@aphrody/base-ui-utils` | pulled by `@aphrody/base-ui` as `npm:` alias |

Versions are `<upstream>-aphrody.<n>`. Imports keep `@base-ui/*`, so no source is rewritten and M3 styling
(`@aphrody/m3-baseui` in the Aphrody monorepo) consumes it through the alias.

## Fork-only files

- `scripts/aphrody/bunify.ts`: idempotent rewrite of manifest scripts (pnpm/npx/node/tsx to bun, Vitest jsdom to
  `bun test`) and the `packageManager` pin (`FORK_BUN`). `--check` / `--write`.
- `scripts/aphrody/sync-upstream.ts`: merges `upstream/master` every 6 h
  (`.github/workflows/aphrody-upstream-sync.yml`); conflicts retried through `bunify.rewrite()` on both sides;
  `bun.lock` refreshed when a manifest or the pnpm files change. Exit 2 on a real conflict.
- `scripts/aphrody/publish-npm.ts`: builds, renames the built manifest, packs, skips unchanged content, publishes
  (`.github/workflows/aphrody-publish-npm.yml`, after each successful sync or on dispatch).
- `scripts/aphrody/aphrody.test.ts`: `bun test scripts/aphrody/aphrody.test.ts`.
- `bunfig.toml` + `test/setupBunTest.ts`: `bun test` on happy-dom, reusing `test/setupVitest.ts`
  (bun:test answers the `vitest` imports). Browser modes stay on Vitest.
- `.github/actions/setup-bun`: installs the fork release named by `packageManager`.
- `scripts/aphrody/fast-build.ts` (`bun run build:fast [--filter utils|react] [--skip-types]`): local iteration
  build with `Bun.build` + `tsc` declarations. It skips the Babel plugins of `babel.config.mjs`
  (minify-errors, display-name, react-constant-elements), so `bun run build` (code-infra) stays the build for
  release and `publish-npm.ts`.
- `patches/@mui%2Finternal-code-infra@0.1.1-canary.6.patch` (`patchedDependencies`): `findBin` also tries
  `.exe` / `.cmd` / `.bunx` shims, so `code-infra build --tsgo` finds `tsc` in `node_modules/.bin` on Windows.
- Root `package.json` `workspaces` / `overrides` / `trustedDependencies` and `bun.lock`: from
  `bun pm migrate` of `pnpm-workspace.yaml` / `pnpm-lock.yaml` (both kept as upstream ships them).

Bun limits hit here are fixed in the Bun fork core, never worked around here (see PLAN.md).
