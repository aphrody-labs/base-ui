// Merge upstream mui/base-ui into the fork and keep it on Bun.
//
//   bun scripts/aphrody/sync-upstream.ts [--push] [--dry-run] [--keep-conflicts]
//       [--root <dir>] [--remote upstream] [--ref upstream/master] [--branch master] [--no-fetch] [--no-index]
//
// Conflicts are first retried as a Bun-aware three-way merge: the merge base
// and the upstream side are passed through bunify.ts `rewrite()` before
// `git merge-file`, so manifest script lines that differ only by pnpm vs bun
// merge cleanly and only real divergences remain. Anything still conflicting
// stops the sync (exit 2) with the merge aborted, unless --keep-conflicts.
//
// Upstream keeps pnpm-workspace.yaml and pnpm-lock.yaml; the fork keeps them
// untouched (no modify/delete conflicts) and owns bun.lock, refreshed here
// whenever a merge touches a manifest or the pnpm files.

import { join } from "node:path";
import { apply, rewrite } from "./bunify.ts";

type Options = {
  root: string;
  remote: string;
  ref: string;
  branch: string;
  fetch: boolean;
  push: boolean;
  dryRun: boolean;
  keepConflicts: boolean;
  index: boolean;
};

export type SyncResult =
  | { status: "up-to-date"; behind: 0 }
  | { status: "merged"; behind: number; commit: string; bunResolved: string[]; pushed: boolean }
  | { status: "dry-run"; behind: number; conflicts: string[] }
  | { status: "conflicts"; behind: number; conflicts: string[] };

function parseArgs(argv: string[]): Options {
  const value = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const remote = value("--remote", "upstream");
  return {
    root: value("--root", join(import.meta.dir, "..", "..")),
    remote,
    ref: value("--ref", `${remote}/master`),
    branch: value("--branch", "master"),
    fetch: !argv.includes("--no-fetch"),
    push: argv.includes("--push"),
    dryRun: argv.includes("--dry-run"),
    keepConflicts: argv.includes("--keep-conflicts"),
    index: !argv.includes("--no-index"),
  };
}

function git(root: string, args: string[], input?: string) {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdin: input === undefined ? "ignore" : Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

function gitOk(root: string, args: string[]): string {
  const r = git(root, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (exit ${r.code}): ${r.err.trim()}`);
  return r.out.trim();
}

// Stage blob of a conflicted path, or null when that side deleted it.
function stage(root: string, n: 1 | 2 | 3, path: string): string | null {
  const r = git(root, ["show", `:${n}:${path}`]);
  return r.code === 0 ? r.out : null;
}

async function resolveWithBunify(root: string, path: string): Promise<boolean> {
  const base = stage(root, 1, path);
  const ours = stage(root, 2, path);
  const theirs = stage(root, 3, path);
  if (base === null || ours === null || theirs === null) return false;
  const tmp = join(root, ".git", "aphrody-sync");
  const files = { ours: join(tmp, "ours"), base: join(tmp, "base"), theirs: join(tmp, "theirs") };
  await Bun.write(files.ours, ours);
  await Bun.write(files.base, rewrite(path, base));
  await Bun.write(files.theirs, rewrite(path, theirs));
  const merged = Bun.spawnSync(["git", "merge-file", "-p", files.ours, files.base, files.theirs], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (merged.exitCode !== 0) return false;
  await Bun.write(join(root, path), merged.stdout);
  gitOk(root, ["add", "--", path]);
  return true;
}

/** Whether the merged upstream range touches anything bun.lock is derived from. */
export function touchesLockInputs(paths: string[]): boolean {
  return paths.some(p => /(?:^|\/)package\.json$|^pnpm-(?:workspace\.yaml|lock\.yaml)$/.test(p));
}

export async function sync(opts: Options): Promise<SyncResult> {
  const { root } = opts;
  if (gitOk(root, ["status", "--porcelain", "--untracked-files=no"]) !== "") {
    throw new Error("working tree has uncommitted changes to tracked files; commit them first");
  }
  const current = gitOk(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current !== opts.branch) throw new Error(`on branch "${current}", expected "${opts.branch}"`);
  if (opts.fetch) gitOk(root, ["fetch", "--quiet", opts.remote]);

  const behind = Number(gitOk(root, ["rev-list", "--count", `HEAD..${opts.ref}`]));
  if (behind === 0) return { status: "up-to-date", behind: 0 };

  const upstreamHead = gitOk(root, ["rev-parse", "--short", opts.ref]);
  const mergeBase = gitOk(root, ["merge-base", "HEAD", opts.ref]);
  const changed = gitOk(root, ["diff", "--name-only", mergeBase, opts.ref]).split("\n").filter(Boolean);
  const merge = git(root, ["merge", "--no-ff", "--no-commit", opts.ref]);
  const conflicted = gitOk(root, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
  if (merge.code !== 0 && conflicted.length === 0) {
    git(root, ["merge", "--abort"]);
    throw new Error(`git merge ${opts.ref} failed: ${merge.err.trim() || merge.out.trim()}`);
  }

  const bunResolved: string[] = [];
  const conflicts: string[] = [];
  for (const path of conflicted) {
    if (await resolveWithBunify(root, path)) bunResolved.push(path);
    else conflicts.push(path);
  }

  if (opts.dryRun || conflicts.length) {
    if (!(conflicts.length && opts.keepConflicts)) git(root, ["merge", "--abort"]);
    return opts.dryRun && !conflicts.length
      ? { status: "dry-run", behind, conflicts }
      : { status: "conflicts", behind, conflicts };
  }

  // Upstream may have added pnpm/node scripts.
  const bunified = await apply(root, true);
  if (bunified.length) gitOk(root, ["add", "--", ...bunified]);
  const leftover = await apply(root, false);
  if (leftover.length) {
    git(root, ["merge", "--abort"]);
    throw new Error(`bunify rewrite is not idempotent for: ${leftover.join(", ")}`);
  }

  let relocked = false;
  if (touchesLockInputs(changed)) {
    const install = Bun.spawnSync([process.execPath, "install", "--lockfile-only"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (install.exitCode !== 0) {
      git(root, ["merge", "--abort"]);
      throw new Error(`bun install --lockfile-only failed:\n${install.stderr}`);
    }
    gitOk(root, ["add", "--", "bun.lock"]);
    relocked = true;
  }

  const lines = [`Merge ${opts.ref} (${upstreamHead}) into ${opts.branch}`, ""];
  lines.push(`${behind} upstream commit(s).`);
  if (bunResolved.length) lines.push(`Bun-aware resolution: ${bunResolved.join(", ")}.`);
  if (bunified.length) lines.push(`Scripts moved to Bun: ${bunified.join(", ")}.`);
  if (relocked) lines.push("bun.lock refreshed.");
  const commit = git(root, ["commit", "--quiet", "-F", "-"], lines.join("\n") + "\n");
  if (commit.code !== 0) throw new Error(`git commit failed: ${commit.err.trim()}`);
  const head = gitOk(root, ["rev-parse", "--short", "HEAD"]);

  let pushed = false;
  if (opts.push) {
    gitOk(root, ["push", "--quiet", "origin", opts.branch]);
    pushed = true;
  }
  if (opts.index) refreshIndex(root, head);
  return { status: "merged", behind, commit: head, bunResolved, pushed };
}

// Keep the aphrody code graph and memory in step with the merged tree. Both
// are optional tooling: a missing or failing `aphrody` never fails the sync.
function refreshIndex(root: string, head: string) {
  if (!Bun.which("aphrody")) return;
  const run = (args: string[], input?: string) =>
    Bun.spawnSync(["aphrody", ...args], {
      cwd: root,
      stdin: input === undefined ? "ignore" : Buffer.from(input),
      stdout: "ignore",
      stderr: "ignore",
    }).exitCode === 0;
  const graph = run(["graph", "--source", "graph:base-ui", "build", root]);
  const note = `Upstream sync merged at ${head} on ${new Date().toISOString()}; graph:base-ui rebuilt: ${graph}.`;
  run(
    [
      "memory",
      "write",
      "--agent-id",
      "base-ui",
      "--id",
      "base-ui-upstream-sync-last",
      "--tag",
      "base-ui",
      "--tag",
      "sync",
      "--content",
      "-",
    ],
    note,
  );
}

if (import.meta.main) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    const result = await sync(opts);
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "conflicts") {
      console.error(
        `${result.conflicts.length} file(s) conflict beyond the Bun rewrite; ` +
          (opts.keepConflicts ? "the merge is left in progress." : "the merge was aborted."),
      );
      process.exit(2);
    }
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  }
}
