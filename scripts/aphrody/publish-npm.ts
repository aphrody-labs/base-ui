// Publish the fork's packages to npm under the @aphrody scope.
//
//   bun scripts/aphrody/publish-npm.ts [--dry-run] [--only react,utils] [--out <dir>] [--registry <url>] [--no-build]
//
// The tree keeps the upstream names (@base-ui/react, @base-ui/utils) so upstream
// merges stay trivial; only the published manifest is renamed. Internal imports
// keep `@base-ui/utils/*`: the published @aphrody/base-ui depends on it through
// an npm alias (`"@base-ui/utils": "npm:@aphrody/base-ui-utils@<v>"`), and
// consumers alias `@base-ui/react` the same way, so no source is rewritten.
//
// Versions are `<upstream version>-aphrody.<n>`; a build whose files equal the
// newest published one is not republished.

import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const REPO = 'aphrody-labs/base-ui';
const SCOPE = '@aphrody';
const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

export interface PackageSpec {
  /** Directory under packages/. */
  dir: string;
  /** Upstream npm name, kept in the tree. */
  upstream: string;
  /** Published npm name. */
  name: string;
  description: string;
}

export const PACKAGES: PackageSpec[] = [
  {
    dir: 'utils',
    upstream: '@base-ui/utils',
    name: `${SCOPE}/base-ui-utils`,
    description: 'React utility functions for Base UI (Aphrody fork of mui/base-ui)',
  },
  {
    dir: 'react',
    upstream: '@base-ui/react',
    name: `${SCOPE}/base-ui`,
    description:
      'Base UI headless React components (Aphrody fork of mui/base-ui, built and tested with Bun)',
  },
];

const BY_UPSTREAM = new Map(PACKAGES.map((p) => [p.upstream, p]));

function run(cmd: string[], cwd: string) {
  const proc = Bun.spawnSync(cmd, { cwd, env: process.env, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) {
    throw new Error(`${cmd.join(' ')} failed (${proc.exitCode}):\n${proc.stdout}\n${proc.stderr}`);
  }
  return proc.stdout.toString();
}

/** Next `<base>-aphrody.<n>` version and the newest existing one for that base. */
export function nextVersion(
  base: string,
  published: Iterable<string>,
): { next: string; previous?: string } {
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-aphrody\\.(\\d+)$`);
  let max = 0;
  for (const v of published) {
    const m = re.exec(v);
    if (m) {
      max = Math.max(max, Number(m[1]));
    }
  }
  return {
    next: `${base}-aphrody.${max + 1}`,
    previous: max ? `${base}-aphrody.${max}` : undefined,
  };
}

/**
 * The built manifest as published: scoped name, version, fork links, and every
 * dependency on a sibling package aliased to its published @aphrody version.
 */
export function publishManifest(
  pkg: Record<string, any>,
  spec: PackageSpec,
  version: string,
  resolved: ReadonlyMap<string, string>,
): Record<string, any> {
  const out: Record<string, any> = {
    ...pkg,
    name: spec.name,
    version,
    description: spec.description,
  };
  for (const field of DEP_FIELDS) {
    const deps = pkg[field];
    if (!deps) {
      continue;
    }
    const next: Record<string, string> = {};
    for (const [dep, range] of Object.entries<string>(deps)) {
      const sibling = BY_UPSTREAM.get(dep);
      if (!sibling) {
        next[dep] = range;
        continue;
      }
      const pinned = resolved.get(sibling.dir);
      if (!pinned) {
        throw new Error(
          `${spec.name}: ${field}.${dep} needs ${sibling.name}, which is not published yet`,
        );
      }
      next[dep] = `npm:${sibling.name}@${pinned}`;
    }
    out[field] = next;
  }
  out.homepage = `https://github.com/${REPO}/tree/master/packages/${spec.dir}#readme`;
  out.repository = {
    type: 'git',
    url: `git+https://github.com/${REPO}.git`,
    directory: `packages/${spec.dir}`,
  };
  out.bugs = { url: `https://github.com/${REPO}/issues` };
  out.publishConfig = { access: 'public' };
  delete out.funding;
  delete out.private;
  return out;
}

/** Hash of a packed tarball's content, ignoring the version so republishing the same files is detected. */
export function contentHash(files: ReadonlyMap<string, string | Uint8Array>): string {
  const hasher = new Bun.CryptoHasher('sha256');
  for (const name of [...files.keys()].sort()) {
    let data = files.get(name)!;
    if (name.replace(/^package\//, '') === 'package.json') {
      const pkg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
      delete pkg.version;
      for (const field of DEP_FIELDS) {
        for (const [dep, range] of Object.entries<string>(pkg[field] ?? {})) {
          if (BY_UPSTREAM.has(dep)) {
            pkg[field][dep] = range.replace(/@[^@]+$/, '');
          }
        }
      }
      data = JSON.stringify(pkg);
    }
    hasher.update(`${name}\0`);
    hasher.update(data);
    hasher.update('\0');
  }
  return hasher.digest('hex');
}

async function tarballFiles(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const [name, file] of await new Bun.Archive(bytes).files()) {
    out.set(name, await file.bytes());
  }
  return out;
}

async function packument(registry: string, name: string): Promise<Record<string, any> | undefined> {
  const res = await fetch(`${registry}/${name.replace('/', '%2f')}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  });
  if (res.status === 404) {
    return undefined;
  }
  if (!res.ok) {
    throw new Error(`GET ${name}: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

function pack(staging: string, dest: string): string {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  run([process.execPath, 'pm', 'pack', '--destination', dest, '--quiet'], staging);
  const [tgz] = readdirSync(dest).filter((f) => f.endsWith('.tgz'));
  if (!tgz) {
    throw new Error(`bun pm pack produced no tarball in ${dest}`);
  }
  return join(dest, tgz);
}

export interface Result {
  name: string;
  version: string;
  action: 'published' | 'submitted' | 'unchanged' | 'dry-run';
  integrity?: string;
}

export function publicationAction(
  doc: Record<string, any> | undefined,
  version: string,
  integrity: string,
): 'published' | 'submitted' {
  const published = doc?.versions?.[version];
  if (!published) {
    return 'submitted';
  }
  if (published.dist?.integrity !== integrity) {
    throw new Error(
      `Registry ${version} differs from the qualified tarball; inspect the registry artifact before releasing it`,
    );
  }
  return 'published';
}

export async function publishAll(opts: {
  dryRun?: boolean;
  only?: string[];
  out?: string;
  registry?: string;
  build?: boolean;
}): Promise<Result[]> {
  const registry = (
    opts.registry ??
    process.env.NPM_CONFIG_REGISTRY ??
    'https://registry.npmjs.org'
  ).replace(/\/$/, '');
  const out = resolve(opts.out ?? join(tmpdir(), 'aphrody-base-ui-npm'));
  mkdirSync(out, { recursive: true });
  const resolved = new Map<string, string>();
  const results: Result[] = [];

  for (const spec of PACKAGES) {
    const doc = await packument(registry, spec.name);
    if (opts.only?.length && !opts.only.includes(spec.dir)) {
      const latest = doc?.['dist-tags']?.latest;
      if (latest) {
        resolved.set(spec.dir, latest);
      }
      continue;
    }

    const dir = join(ROOT, 'packages', spec.dir);
    if (opts.build !== false) {
      run([process.execPath, 'run', 'build'], dir);
    }
    const staging = join(dir, 'build');
    const built = await Bun.file(join(staging, 'package.json')).json();
    const source = await Bun.file(join(dir, 'package.json')).json();
    const { next, previous } = nextVersion(source.version, Object.keys(doc?.versions ?? {}));
    const manifest = publishManifest(built, spec, next, resolved);
    await Bun.write(join(staging, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const tgz = pack(staging, join(out, spec.dir));
    const bytes = await Bun.file(tgz).bytes();
    const integrity = `sha512-${new Bun.CryptoHasher('sha512').update(bytes).digest('base64')}`;
    const files = await tarballFiles(bytes);

    const packed = JSON.parse(new TextDecoder().decode(files.get('package/package.json')!));
    for (const field of DEP_FIELDS) {
      for (const [dep, range] of Object.entries<string>(packed[field] ?? {})) {
        if (/^(?:workspace|file|link|catalog):|^\.{0,2}\//.test(range)) {
          throw new Error(
            `${spec.name}: ${field}.${dep} is still local (${range}) in the packed tarball`,
          );
        }
      }
    }

    if (previous) {
      const tarball = doc!.versions[previous].dist.tarball;
      const prevFiles = await tarballFiles(
        new Uint8Array(await (await fetch(tarball)).arrayBuffer()),
      );
      if (contentHash(prevFiles) === contentHash(files)) {
        resolved.set(spec.dir, previous);
        results.push({ name: spec.name, version: previous, action: 'unchanged' });
        console.log(`= ${spec.name}@${previous} unchanged`);
        continue;
      }
    }

    resolved.set(spec.dir, next);
    console.log(`${opts.dryRun ? '~' : '+'} ${spec.name}@${next} (${files.size} files) ${tgz}`);
    if (opts.dryRun) {
      results.push({ name: spec.name, version: next, action: 'dry-run', integrity });
      continue;
    }
    run([process.execPath, 'publish', tgz, '--access', 'public', '--tag', 'latest'], staging);
    const action = publicationAction(await packument(registry, spec.name), next, integrity);
    results.push({ name: spec.name, version: next, action, integrity });
    console.log(
      `${action === 'published' ? '+' : '~'} ${spec.name}@${next} ${action}${action === 'submitted' ? '; awaiting registry availability' : ''}`,
    );
  }
  await Bun.write(
    join(out, 'publication-results.json'),
    `${JSON.stringify({ registry, results }, null, 2)}\n`,
  );
  return results;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const results = await publishAll({
    dryRun: args.includes('--dry-run'),
    only: value('--only')?.split(','),
    out: value('--out'),
    registry: value('--registry'),
    build: !args.includes('--no-build'),
  });
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = results
      .map((r) => `| \`${r.name}\` | \`${r.version}\` | ${r.action} |`)
      .join('\n');
    await Bun.write(
      process.env.GITHUB_STEP_SUMMARY,
      `| package | version | result |\n| --- | --- | --- |\n${rows}\n`,
    );
  }
}
