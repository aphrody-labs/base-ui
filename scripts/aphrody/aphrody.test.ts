import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { apply, rewrite, rewriteScript } from "./bunify.ts";
import { contentHash, nextVersion, PACKAGES, publishManifest } from "./publish-npm.ts";
import { touchesLockInputs } from "./sync-upstream.ts";

const ROOT = join(import.meta.dir, "..", "..");

describe("bunify", () => {
  test("rewrites upstream pnpm/node scripts to Bun", () => {
    expect(rewriteScript("preinstall", "npx only-allow@1.2.2 pnpm")).toBeNull();
    expect(rewriteScript("test", "pnpm test:chromium")).toBe("bun test");
    expect(rewriteScript("test", "cross-env VITEST_ENV=jsdom vitest")).toBe("bun test");
    expect(rewriteScript("test:jsdom:coverage", "pnpm test:jsdom --coverage")).toBe("bun test --coverage");
    expect(rewriteScript("test:chromium", "cross-env VITEST_ENV=chromium pnpm test:_unit")).toBe(
      "cross-env VITEST_ENV=chromium bun run test:_unit",
    );
    expect(rewriteScript("docs:dev", "pnpm --filter docs dev")).toBe("bun run --filter docs dev");
    expect(rewriteScript("size", "pnpm -F ./test/bundle-size check")).toBe("bun run --cwd ./test/bundle-size check");
    expect(rewriteScript("pg", "pnpm -C playground/vite-app build")).toBe("bun run --cwd playground/vite-app build");
    expect(rewriteScript("lint", "pnpm -r --if-present lint")).toBe("bun run --filter '*' --if-present lint");
    expect(rewriteScript("pkg", "publint --pack pnpm run ./build")).toBe("publint --pack bun ./build");
    expect(rewriteScript("release", "pnpm build && pnpm publish")).toBe("bun run build && bun publish");
    expect(rewriteScript("x", "node --experimental-strip-types ./a.mjs && tsx ./b.mts")).toBe(
      "bun ./a.mjs && bun ./b.mts",
    );
  });

  test("is idempotent", () => {
    const pkg = JSON.stringify(
      { scripts: { a: "pnpm build && node x.mjs", preinstall: "npx only-allow pnpm" } },
      null,
      2,
    );
    const once = rewrite("package.json", pkg);
    expect(rewrite("package.json", once)).toBe(once);
    expect(JSON.parse(once).scripts).toEqual({ a: "bun run build && bun x.mjs" });
  });

  test("leaves examples and non-manifests alone", () => {
    const pkg = JSON.stringify({ scripts: { dev: "pnpm dev" } });
    expect(rewrite("examples/vite/package.json", pkg)).toBe(pkg);
    expect(rewrite("README.md", "pnpm dev")).toBe("pnpm dev");
  });

  test("the tree is bunified", async () => {
    expect(await apply(ROOT, false)).toEqual([]);
  });
});

describe("publish-npm", () => {
  test("versions", () => {
    expect(nextVersion("1.8.0", [])).toEqual({ next: "1.8.0-aphrody.1", previous: undefined });
    expect(nextVersion("1.8.0", ["1.8.0-aphrody.1", "1.8.0-aphrody.3", "1.7.0-aphrody.9"])).toEqual({
      next: "1.8.0-aphrody.4",
      previous: "1.8.0-aphrody.3",
    });
  });

  test("manifest is scoped and aliases the sibling package", () => {
    const react = PACKAGES.find(p => p.dir === "react")!;
    const out = publishManifest(
      {
        name: "@base-ui/react",
        version: "1.8.0",
        funding: {},
        dependencies: { "@base-ui/utils": "0.4.0", "@floating-ui/utils": "^0.2.12" },
        peerDependencies: { react: "^19" },
      },
      react,
      "1.8.0-aphrody.1",
      new Map([["utils", "0.4.0-aphrody.2"]]),
    );
    expect(out.name).toBe("@aphrody/base-ui");
    expect(out.version).toBe("1.8.0-aphrody.1");
    expect(out.dependencies).toEqual({
      "@base-ui/utils": "npm:@aphrody/base-ui-utils@0.4.0-aphrody.2",
      "@floating-ui/utils": "^0.2.12",
    });
    expect(out.repository.url).toBe("git+https://github.com/aphrody-labs/base-ui.git");
    expect(out.funding).toBeUndefined();
    expect(() => publishManifest({ dependencies: { "@base-ui/utils": "0.4.0" } }, react, "1", new Map())).toThrow(
      "not published yet",
    );
  });

  test("content hash ignores versions", () => {
    const a = new Map([
      [
        "package/package.json",
        JSON.stringify({
          version: "1-aphrody.1",
          dependencies: { "@base-ui/utils": "npm:@aphrody/base-ui-utils@0.4.0-aphrody.1" },
        }),
      ],
      ["package/index.js", "x"],
    ]);
    const b = new Map([
      [
        "package/package.json",
        JSON.stringify({
          version: "1-aphrody.2",
          dependencies: { "@base-ui/utils": "npm:@aphrody/base-ui-utils@0.4.0-aphrody.2" },
        }),
      ],
      ["package/index.js", "x"],
    ]);
    expect(contentHash(a)).toBe(contentHash(b));
    b.set("package/index.js", "y");
    expect(contentHash(a)).not.toBe(contentHash(b));
  });
});

test("sync refreshes bun.lock only when its inputs change", () => {
  expect(touchesLockInputs(["packages/react/src/a.ts"])).toBe(false);
  expect(touchesLockInputs(["pnpm-lock.yaml"])).toBe(true);
  expect(touchesLockInputs(["docs/package.json"])).toBe(true);
  expect(touchesLockInputs(["pnpm-workspace.yaml"])).toBe(true);
});
