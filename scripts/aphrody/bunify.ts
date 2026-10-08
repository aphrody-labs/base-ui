// The fork installs, runs and tests with Bun. Upstream keeps pnpm, so this file
// is the single, idempotent rewrite of the upstream manifest scripts: the
// upstream sync applies `rewrite()` to both sides of a three-way merge (like
// scope.ts), so a script line upstream edits never conflicts on pnpm vs bun.
//
//   bun scripts/aphrody/bunify.ts --check   list manifests that still need it (exit 1 if any)
//   bun scripts/aphrody/bunify.ts --write   rewrite them in place
//
// Workspaces, overrides and allowBuilds come from pnpm-workspace.yaml through
// `bun pm migrate` (Bun writes them into the root package.json); this file only
// owns the scripts and the package manager pin.

/** aphrody-labs/bun release the fork installs, runs and tests with (CI: .github/actions/setup-bun). */
export const FORK_BUN = "1.4.3-aphrody.2";

import { join } from "node:path";

// Unit tests run with `bun test` + happy-dom (bunfig.toml preload) instead of
// Vitest under jsdom. The real-browser modes (`test:chromium`, ...) stay on Vitest.
const BUN_TEST: Record<string, RegExp> = {
  test: /^(?:pnpm test:chromium|cross-env VITEST_ENV=jsdom vitest)$/,
  "test:jsdom": /VITEST_ENV=jsdom/,
  "test:jsdom:coverage": /test:jsdom --coverage/,
};

export function rewriteScript(name: string, cmd: string): string | null {
  if (/\bonly-allow(?:@[\d.]+)? pnpm\b/.test(cmd)) return null;
  if (BUN_TEST[name]?.test(cmd)) return name.endsWith(":coverage") ? "bun test --coverage" : "bun test";
  let out = cmd;
  out = out.replace(/\bpnpm (?:dedupe|install)\b/g, "bun install");
  out = out.replace(/\bpnpm publish\b/g, "bun publish");
  out = out.replace(/\bpublint --pack pnpm(?: run)?/g, "publint --pack bun");
  out = out.replace(/\bpnpm -r --if-present (\S+)/g, "bun run --filter '*' --if-present $1");
  out = out.replace(/\bpnpm (?:--filter|-F) (\.\/\S+) (?:run )?/g, "bun run --cwd $1 ");
  out = out.replace(/\bpnpm (?:--filter|-F) (\S+) (?:run )?/g, "bun run --filter $1 ");
  out = out.replace(/\bpnpm -C (\S+) (?:run )?/g, "bun run --cwd $1 ");
  out = out.replace(/\bpnpm (?:run )?(?=[\w:@.-])/g, "bun run ");
  out = out.replace(/\bnpx /g, "bunx ");
  out = out.replace(/(^|&& |; )(?:node|tsx) (?:--experimental-strip-types )?/g, "$1bun ");
  return out;
}

export function rewriteManifest(text: string): string {
  const pkg = JSON.parse(text) as Record<string, any>;
  let changed = false;
  const scripts = pkg.scripts as Record<string, string> | undefined;
  if (scripts && typeof scripts === "object") {
    const next: Record<string, string> = {};
    for (const [name, cmd] of Object.entries(scripts)) {
      const out = rewriteScript(name, cmd);
      if (out !== cmd) changed = true;
      if (out !== null) next[name] = out;
    }
    pkg.scripts = next;
  }
  if (typeof pkg.packageManager === "string" && pkg.packageManager !== `bun@${FORK_BUN}`) {
    pkg.packageManager = `bun@${FORK_BUN}`;
    changed = true;
  }
  if (pkg.engines && typeof pkg.engines === "object" && "pnpm" in pkg.engines) {
    delete pkg.engines.pnpm;
    changed = true;
  }
  if (!changed) return text;
  const indent = /^\{\r?\n([ \t]+)/.exec(text)?.[1] ?? "  ";
  return JSON.stringify(pkg, null, indent) + (text.endsWith("\n") ? "\n" : "");
}

// Examples are standalone apps users copy; they keep their own package manager.
export function isManaged(path: string): boolean {
  const p = path.replaceAll("\\", "/");
  return /(?:^|\/)package\.json$/.test(p) && !p.startsWith("examples/") && !p.includes("node_modules/");
}

// For the upstream sync: rewrite one blob (non-manifests pass through).
export function rewrite(path: string, text: string): string {
  return isManaged(path) ? rewriteManifest(text) : text;
}

export function manifests(root: string): string[] {
  const proc = Bun.spawnSync(["git", "ls-files", "--", "package.json", "*/package.json"], {
    cwd: root,
    stdout: "pipe",
  });
  return proc.stdout.toString().split(/\r?\n/).filter(Boolean).filter(isManaged);
}

export async function apply(root: string, write: boolean): Promise<string[]> {
  const changed: string[] = [];
  for (const file of manifests(root)) {
    const abs = join(root, file);
    const before = await Bun.file(abs).text();
    const after = rewriteManifest(before);
    if (after === before) continue;
    changed.push(file);
    if (write) await Bun.write(abs, after);
  }
  return changed;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const i = args.indexOf("--root");
  const root = i >= 0 ? args[i + 1] : join(import.meta.dir, "..", "..");
  const changed = await apply(root, write);
  for (const f of changed) console.log(`${write ? "bunified" : "not bunified"} ${f}`);
  if (!write && changed.length) {
    console.error(`${changed.length} manifest(s) still run pnpm/node scripts; run with --write`);
    process.exit(1);
  }
}
