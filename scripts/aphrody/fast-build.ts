#!/usr/bin/env bun
// Fork-only local iteration build: `bun run build:fast [--filter utils|react] [--skip-types]`.
//
// Bun.build transpiles each source file to build/*.mjs + build/*.js and tsc emits the
// declarations. It does NOT run the Babel pipeline of babel.config.mjs (minify-errors,
// display-name, react-constant-elements), so its output is not the published one:
// `bun run build` (code-infra) stays the build used by release and publish-npm.ts.
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { $ } from "bun";

const rootDir = path.resolve(import.meta.dir, "../..");

// Helper to resolve relative imports in emitted files and declarations
export function resolveRelativeImport(specifier: string, dir: string, ext: string): string {
  if (!specifier.startsWith(".")) return specifier;
  if (specifier.endsWith(ext)) return specifier;
  const clean = specifier.replace(/\.(js|mjs|cjs|ts|tsx)$/, "");
  const abs = path.resolve(dir, clean);

  // Check if a file exists with typical source extensions first
  for (const checkExt of [".ts", ".tsx", ".js", ".jsx", ".d.ts"]) {
    if (existsSync(abs + checkExt)) {
      return `${clean}${ext}`;
    }
  }

  // Otherwise check if it's a directory with index
  try {
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      return `${clean}/index${ext}`;
    }
  } catch {}

  return `${clean}${ext}`;
}

// Transform imports in .d.ts files for .d.mts output
export function transformDtsImports(content: string, filePath: string, ext: string): string {
  const dir = path.dirname(filePath);
  return content.replace(
    /((?:from\s+|import\s*\(\s*)['"])([^'"]+)(['"]\s*\)?)/g,
    (match, prefix, specifier, suffix) => {
      if (specifier.startsWith(".")) {
        const resolved = resolveRelativeImport(specifier, dir, ext);
        return `${prefix}${resolved}${suffix}`;
      }
      return match;
    },
  );
}

// Find native TypeScript compiler (tsc/tsgo)
async function findTscBin(): Promise<string> {
  const binDir = path.join(rootDir, "node_modules", ".bin");
  for (const name of ["tsc", "tsgo", "tsc6"]) {
    for (const ext of ["", ".exe", ".cmd", ".bunx"]) {
      const candidate = path.join(binDir, name + ext);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {}
    }
  }
  return "tsc";
}

interface BuildPackageOptions {
  packageName: string;
  packageDir: string;
  skipTypes?: boolean;
}

async function buildPackage({ packageName, packageDir, skipTypes = false }: BuildPackageOptions) {
  const start = performance.now();
  console.log(`[fast-build] building ${packageName}`);

  const buildDir = path.join(packageDir, "build");
  await fs.rm(buildDir, { recursive: true, force: true });
  await fs.mkdir(buildDir, { recursive: true });

  const pkgJsonPath = path.join(packageDir, "package.json");
  const pkgJson = JSON.parse(await fs.readFile(pkgJsonPath, "utf8"));

  // Collect source files
  const srcDir = path.join(packageDir, "src");
  const glob = new Bun.Glob("**/*.{ts,tsx,js,jsx}");
  const sourceFiles = Array.from(glob.scanSync({ cwd: srcDir }))
    .filter(f => !f.includes(".test.") && !f.includes(".spec.") && !f.endsWith(".d.ts") && !f.endsWith(".template.js"))
    .map(f => path.join(srcDir, f));

  // Determine external dependencies
  const externalDeps = [
    ...Object.keys(pkgJson.dependencies || {}),
    ...Object.keys(pkgJson.peerDependencies || {}),
    "react",
    "react-dom",
    "react/*",
    "react-dom/*",
    "@base-ui/utils",
    "@base-ui/utils/*",
    "@floating-ui/react-dom",
    "@floating-ui/react-dom/*",
    "@floating-ui/utils",
    "@floating-ui/utils/*",
    "#formatErrorMessage",
    "#prehydration/*",
    "#test-utils",
  ];

  // 1. Parallel ESM & CJS Build using Bun.build
  const esmPromise = Bun.build({
    entrypoints: sourceFiles,
    root: srcDir,
    outdir: buildDir,
    format: "esm",
    sourcemap: "external",
    target: "browser",
    naming: "[dir]/[name].mjs",
    external: externalDeps,
    plugins: [
      {
        name: "fast-resolve-relative-mjs",
        setup(build) {
          build.onResolve({ filter: /^\./ }, args => {
            if (!args.importer) return;
            const target = resolveRelativeImport(args.path, path.dirname(args.importer), ".mjs");
            return { path: target, external: true };
          });
        },
      },
    ],
  });

  const cjsPromise = Bun.build({
    entrypoints: sourceFiles,
    root: srcDir,
    outdir: buildDir,
    format: "cjs",
    sourcemap: "external",
    target: "browser",
    naming: "[dir]/[name].js",
    external: externalDeps,
    plugins: [
      {
        name: "fast-resolve-relative-js",
        setup(build) {
          build.onResolve({ filter: /^\./ }, args => {
            if (!args.importer) return;
            const target = resolveRelativeImport(args.path, path.dirname(args.importer), ".js");
            return { path: target, external: true };
          });
        },
      },
    ],
  });

  // 2. TypeScript DTS declaration emission in parallel
  const tscPromise = (async () => {
    if (skipTypes) return;
    const tscBin = await findTscBin();
    const tsconfigPath = path.join(packageDir, "tsconfig.build.json");
    if (existsSync(tsconfigPath)) {
      await $`${tscBin} -p ${tsconfigPath} --outDir ${buildDir} --rootDir ${srcDir} --declaration --emitDeclarationOnly --noEmit false --composite false --incremental false`.quiet();
    }
  })();

  const [esmResult, cjsResult] = await Promise.all([esmPromise, cjsPromise, tscPromise]);

  if (!esmResult.success) {
    console.error(`\x1b[31mError building ESM for ${packageName}:\x1b[0m`, esmResult.logs);
    throw new Error(`ESM build failed for ${packageName}`);
  }
  if (!cjsResult.success) {
    console.error(`\x1b[31mError building CJS for ${packageName}:\x1b[0m`, cjsResult.logs);
    throw new Error(`CJS build failed for ${packageName}`);
  }

  // 3. Transform .d.ts files into .d.mts with resolved extensions for Node16 ESM
  if (!skipTypes) {
    const dtsGlob = new Bun.Glob("**/*.d.ts");
    const dtsFiles = Array.from(dtsGlob.scanSync({ cwd: buildDir }));

    await Promise.all(
      dtsFiles.map(async f => {
        const full = path.join(buildDir, f);
        const content = await fs.readFile(full, "utf8");
        const mtsPath = full.replace(/\.d\.ts$/, ".d.mts");
        const transformed = transformDtsImports(content, full, ".mjs");
        await fs.writeFile(mtsPath, transformed);
      }),
    );
  }

  // 4. Generate build/package.json
  const { createPackageExports, createPackageImports } = await import(
    path.join(rootDir, "node_modules/@mui/internal-code-infra/src/utils/build.mjs")
  );

  const builtPkgJson = { ...pkgJson };
  delete builtPkgJson.scripts;
  delete builtPkgJson.publishConfig?.directory;
  delete builtPkgJson.devDependencies;
  builtPkgJson.type = "commonjs";

  const originalExports = builtPkgJson.exports;
  delete builtPkgJson.exports;
  const originalImports = builtPkgJson.imports;
  delete builtPkgJson.imports;

  const [{ exports: packageExports, main, types }, packageImports] = await Promise.all([
    createPackageExports(originalExports, {
      bundles: ["esm", "cjs"],
      outputDir: buildDir,
      cwd: packageDir,
      addTypes: !skipTypes,
      expand: true,
      packageType: "commonjs",
    }),
    originalImports
      ? createPackageImports(originalImports, {
          bundles: ["esm", "cjs"],
          cwd: packageDir,
          outputDir: buildDir,
          addTypes: !skipTypes,
          expand: true,
          packageType: "commonjs",
        })
      : Promise.resolve(undefined),
  ]);

  builtPkgJson.exports = packageExports;
  if (packageImports) builtPkgJson.imports = packageImports;
  if (main) builtPkgJson.main = main;
  if (types) builtPkgJson.types = types;

  await fs.writeFile(path.join(buildDir, "package.json"), JSON.stringify(builtPkgJson, null, 2));

  // 5. Add license banner to index bundles
  async function addLicenseHeader(file: string) {
    try {
      const content = await fs.readFile(file, "utf8");
      const header = `/**
 * ${pkgJson.name} v${pkgJson.version}
 *
 * @license ${pkgJson.license || "MIT"}
 * This source code is licensed under the ${pkgJson.license || "MIT"} license found in the
 * LICENSE file in the root directory of this source tree.
 */\n`;
      await fs.writeFile(file, header + content);
    } catch {}
  }

  await Promise.all([
    addLicenseHeader(path.join(buildDir, "index.mjs")),
    addLicenseHeader(path.join(buildDir, "index.js")),
  ]);

  // 6. Copy documentation and legal files, package copy first, root copy otherwise
  for (const file of [".npmignore", "README.md", "LICENSE", "CHANGELOG.md"]) {
    const source = [path.join(packageDir, file), path.join(rootDir, file)].find(p => existsSync(p));
    if (source) await fs.copyFile(source, path.join(buildDir, file));
  }

  // published-docs is staged by the react `prebuild` script; build:fast does not run it
  const publishedDocsDir = path.join(packageDir, "published-docs");
  if (existsSync(publishedDocsDir)) {
    await fs.cp(publishedDocsDir, path.join(buildDir, "docs"), { recursive: true });
  }

  const duration = (performance.now() - start).toFixed(0);
  console.log(`[fast-build] ${packageName} built in ${duration}ms`);
}

async function main() {
  const args = process.argv.slice(2);
  const skipTypes = args.includes("--skip-types");
  const cwd = process.cwd().replaceAll("\\", "/");
  const filterArg =
    args.find(a => a.startsWith("--filter="))?.split("=")[1] ||
    (args.includes("--filter") ? args[args.indexOf("--filter") + 1] : undefined);

  const utils = { packageName: "@base-ui/utils", packageDir: path.join(rootDir, "packages/utils"), skipTypes };
  const react = { packageName: "@base-ui/react", packageDir: path.join(rootDir, "packages/react"), skipTypes };

  if (cwd.endsWith("packages/utils") || filterArg === "utils" || filterArg === "@base-ui/utils") {
    await buildPackage(utils);
  } else if (cwd.endsWith("packages/react") || filterArg === "react" || filterArg === "@base-ui/react") {
    await buildPackage(react);
  } else {
    const overallStart = performance.now();
    await buildPackage(utils);
    await buildPackage(react);
    console.log(`[fast-build] all packages built in ${((performance.now() - overallStart) / 1000).toFixed(2)}s`);
  }
}

if (import.meta.main) {
  main().catch(err => {
    console.error("[fast-build] failed:", err);
    process.exit(1);
  });
}
