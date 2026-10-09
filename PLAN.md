# Plan (aphrody-labs/base-ui)

Master plan: `C:/bun/PLAN.md` section R. Status of this fork:

- ✅ Fork synced on `mui/base-ui` master, remotes origin = fork, upstream = mui.
- ✅ Bun tooling: bunify, sync (6 h), npm publish, setup-bun action, secrets `NPM_TOKEN` / `APHRODY_SYNC_TOKEN`.
- ✅ `bun.lock` from `bun pm migrate`.
- ⏳ First publish of `@aphrody/base-ui` / `@aphrody/base-ui-utils` (needs a green `code-infra build` under Bun).
- ⏳ `bun test` pass rate on happy-dom; missing `vi` APIs (fake timers, `importActual`, `hoisted`,
  `stubGlobal`, ...) are added to bun:test in the Bun fork core.
- ⏳ Remove the `name` fields added to `test/bundle-size`, `test/performance`, `test/public-types` once the Bun
  fork release that names unnamed workspaces after their directory (Bun fork fix, PLAN R) is `FORK_BUN`.
- ⏳ Overrides dropped by `bun pm migrate` (`brace-expansion@N`, `js-yaml@4`, `nanoid@3`,
  `@guidepup/setup>@guidepup/record: -`): migrate them in the Bun fork core.
- ⏳ `@aphrody/m3-baseui` (Aphrody monorepo) switched to the `npm:@aphrody/base-ui` alias after the first publish.
