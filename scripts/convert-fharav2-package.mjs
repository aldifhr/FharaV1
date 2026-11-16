#!/usr/bin/env node
/**
 * Plan 058 stage 2: one-shot adaptation of the packages copied verbatim
 * from FharaV2 (pnpm) to this repo's pnpm workspaces (amended decision).
 *
 *  - `catalog:` dependency ranges (resolved against FharaV2's
 *    pnpm-workspace.yaml catalog at copy time) become concrete versions.
 *  - `workspace:*` is preserved: pnpm resolves it to the local workspace.
 *  - `vite-plus` (vp) is replaced by plain `vitest`.
 *  - `effect-tsgo` typecheck script becomes `tsc -p tsconfig.json --noEmit`.
 *  - tsconfig `extends` is repointed at the shared `tsconfig.fharav2.json`.
 *
 * Run: node scripts/convert-fharav2-package.mjs <packageDir> [packageDir...]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Versions from D:\CODE\FharaV2\pnpm-workspace.yaml `catalog:` (2026-11-16). */
const CATALOG = {
  effect: "^4.1.3",
  "@effect/platform-node": "4.1.2",
  "@effect/vitest": "4.1.2",
  "@effect/openapi-generator": "4.1.2",
  "@types/node": "^26.6.6",
  "@types/mdast": "^4.0.4",
  "@noble/curves": "1.9.1",
  "@noble/hashes": "1.8.0",
  "mdast-util-directive": "3.1.0",
  "mdast-util-to-hast": "^13.2.1",
  "micromark-extension-directive": "4.0.0",
  "micromark-util-character": "2.1.1",
  "micromark-util-types": "2.0.2",
  "property-information": "^7.2.0",
  "rehype-raw": "7.0.0",
  "rehype-sanitize": "6.0.0",
  "remark-breaks": "4.0.0",
  "remark-gfm": "4.0.1",
  "remark-math": "6.0.0",
  "remark-parse": "11.0.0",
  "remark-rehype": "11.1.2",
  unified: "11.0.5",
  yaml: "^2.9.0",
};

const convertRange = (range) =>
  range === "catalog:"
    ? undefined
    : range.startsWith("catalog:")
      ? range.slice("catalog:".length)
      : range;

const convertDeps = (deps) => {
  if (!deps) return undefined;
  const out = {};
  for (const [name, range] of Object.entries(deps)) {
    if (name === "vite-plus") continue; // replaced by vitest below
    const converted = convertRange(range);
    if (converted !== undefined) out[name] = converted;
    else if (!(name in CATALOG)) {
      throw new Error(`No catalog version known for ${name} (${range})`);
    } else {
      out[name] = CATALOG[name];
    }
  }
  return out;
};

for (const dir of process.argv.slice(2)) {
  const pkgPath = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const usedVitePlus =
    pkg.devDependencies?.["vite-plus"] || pkg.dependencies?.["vite-plus"];
  pkg.dependencies = convertDeps(pkg.dependencies);
  pkg.devDependencies = convertDeps(pkg.devDependencies);
  if (usedVitePlus) {
    pkg.devDependencies ??= {};
    pkg.devDependencies.vitest = "^5.1.0";
  }
  pkg.scripts = {
    ...pkg.scripts,
    typecheck: "tsc -p tsconfig.json --noEmit",
    ...(pkg.scripts.test ? { test: "vitest run" } : {}),
  };
  pkg.devDependencies ??= {};
  pkg.devDependencies.typescript = "^5.9.3";
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  const tsconfigPath = join(dir, "tsconfig.json");
  const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
  tsconfig.extends = "../tsconfig.fharav2.json";
  writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2) + "\n");
  console.log(`adapted ${dir}`);
}
