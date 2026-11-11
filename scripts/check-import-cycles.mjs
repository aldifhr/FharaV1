#!/usr/bin/env node
// Copyright 2026 Zeabur Inc.
// Licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0).
// Adapted from Nuphos `scripts/check-import-cycles.mjs` (commit a210a05).
// Modified by Fhara, 2026-11: the import graph is built with the TypeScript compiler API instead of
// madge (no new dependency); type-only imports and re-exports and dynamic `import()` are skipped;
// targets are Fhara's web, api, worker and config workspaces. `canonicalCycle`, `canonicalCycles`,
// `compareToBaseline` and `partitionTargets` are kept as in the original.
// See THIRD_PARTY_NOTICES.md (## Nuphos).
//
// The baseline is a ratchet: known cycles are recorded, new ones fail.
//   node scripts/check-import-cycles.mjs            check
//   node scripts/check-import-cycles.mjs --update   rewrite scripts/import-cycles.baseline.json
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadTypeScript } from "./guards/rules.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const BASELINE = path.join(import.meta.dirname, "import-cycles.baseline.json");

export const TARGETS = [
  { name: "web", roots: ["apps/web/app", "apps/web/components", "apps/web/lib"], tsConfig: "apps/web/tsconfig.json" },
  { name: "api", roots: ["apps/api/convex"], tsConfig: "apps/api/convex/tsconfig.json" },
  { name: "worker", roots: ["packages/worker/src"], tsConfig: "packages/worker/tsconfig.json" },
  { name: "config", roots: ["packages/config/src"], tsConfig: "packages/config/tsconfig.json" },
];

/** Same cycle, same string: rotate to the smallest member, then compare. */
export function canonicalCycle(cycle) {
  let best = 0;
  for (let i = 1; i < cycle.length; i++) if (cycle[i] < cycle[best]) best = i;
  return [...cycle.slice(best), ...cycle.slice(0, best)];
}

export function canonicalCycles(cycles) {
  return [...new Set(cycles.map((cycle) => canonicalCycle(cycle).join(" -> ")))].sort();
}

export function compareToBaseline(found, recorded) {
  const before = new Set(recorded);
  const now = new Set(found);
  return {
    added: found.filter((cycle) => !before.has(cycle)),
    removed: recorded.filter((cycle) => !now.has(cycle)),
  };
}

// Split targets into measurable and absent. A target can be legitimately absent from this tree,
// and the graph is then empty, which the ratchet would read as every recorded cycle resolved.
export function partitionTargets(targets, rootExists) {
  const present = [];
  const skipped = [];
  for (const target of targets) {
    const found = target.roots.filter((root) => rootExists(root));
    if (found.length === target.roots.length) {
      present.push(target);
      continue;
    }
    // All roots gone is a different tree; some roots gone is a mistake.
    if (found.length > 0) {
      const missing = target.roots.filter((root) => !found.includes(root));
      throw new Error(`${target.name}: roots missing from an otherwise present target: ${missing.join(", ")}`);
    }
    skipped.push(target.name);
  }
  return { present, skipped };
}

const SOURCE = /\.(?:ts|tsx|mts|cts)$/u;
const SKIP_FILE = /(?:\.d\.ts$)|(?:\.(?:test|spec)\.[cm]?tsx?$)/u;
const SKIP_DIR = new Set(["node_modules", "_generated", "tests", "__tests__", "dist", ".next"]);

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIR.has(entry.name)) walk(full, out);
    } else if (SOURCE.test(entry.name) && !SKIP_FILE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Module specifiers that create a runtime edge: value imports, side-effect imports, value re-exports. */
export function runtimeImports(ts, source) {
  const specs = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      const bindings = clause?.namedBindings;
      if (clause && !clause.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((el) => el.isTypeOnly)) continue;
      if (ts.isStringLiteral(statement.moduleSpecifier)) specs.push(statement.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      if (statement.isTypeOnly) continue;
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((el) => el.isTypeOnly)) continue;
      if (ts.isStringLiteral(statement.moduleSpecifier)) specs.push(statement.moduleSpecifier.text);
    }
  }
  return specs;
}

/** { file: [dependency files] } with repo-root-relative keys, edges kept inside the roots. */
export function buildGraph(root, target) {
  const ts = loadTypeScript();
  const configPath = path.join(root, target.tsConfig);
  const raw = ts.parseConfigFileTextToJson(configPath, readFileSync(configPath, "utf8"));
  if (raw.error) throw new Error(`${target.tsConfig}: ${ts.flattenDiagnosticMessageText(raw.error.messageText, "\n")}`);
  const { options } = ts.parseJsonConfigFileContent(raw.config, ts.sys, path.dirname(configPath));
  const absRoots = target.roots.map((r) => path.join(root, r));
  const files = absRoots.flatMap((dir) => walk(dir, [])).sort();
  const inScope = new Set(files);
  const cache = ts.createModuleResolutionCache(path.dirname(configPath), (f) => f, options);
  const rel = (file) => path.relative(root, file).split(path.sep).join("/");
  const graph = {};
  for (const file of files) {
    const kind = file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, kind);
    const deps = new Set();
    for (const spec of runtimeImports(ts, source)) {
      const resolved = ts.resolveModuleName(spec, file, options, ts.sys, cache).resolvedModule?.resolvedFileName;
      if (resolved && inScope.has(path.resolve(resolved))) deps.add(rel(path.resolve(resolved)));
    }
    graph[rel(file)] = [...deps].sort();
  }
  return graph;
}

/** Cycles found by a depth-first walk (the same walk madge's `circular()` does), canonicalised. */
export function findCycles(graph) {
  const cycles = [];
  const resolved = new Set();
  const onPath = [];
  const onPathSet = new Set();
  const visit = (id) => {
    onPath.push(id);
    onPathSet.add(id);
    for (const dep of graph[id] ?? []) {
      if (resolved.has(dep)) continue;
      if (onPathSet.has(dep)) {
        cycles.push(onPath.slice(onPath.indexOf(dep)));
        continue;
      }
      visit(dep);
    }
    onPath.pop();
    onPathSet.delete(id);
    resolved.add(id);
  };
  for (const id of Object.keys(graph).sort()) if (!resolved.has(id)) visit(id);
  return canonicalCycles(cycles);
}

/** Paths inside a cycle are shown relative to the target's first root's workspace. */
export function analyze(root, target) {
  const prefix = `${target.roots[0].split("/").slice(0, 2).join("/")}/`;
  const graph = buildGraph(root, target);
  return findCycles(graph).map((cycle) => cycle.split(" -> ").map((f) => (f.startsWith(prefix) ? f.slice(prefix.length) : f)).join(" -> "));
}

function main() {
  const update = process.argv.includes("--update");
  const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};
  const { present: targets, skipped } = partitionTargets(TARGETS, (r) => existsSync(path.join(REPO_ROOT, r)) && statSync(path.join(REPO_ROOT, r)).isDirectory());
  for (const name of skipped) console.log(`skip ${name}: none of its roots exist here`);
  const found = {};
  for (const target of targets) found[target.name] = analyze(REPO_ROOT, target);

  if (update) {
    const next = {};
    for (const target of TARGETS) next[target.name] = found[target.name] ?? baseline[target.name] ?? [];
    writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`);
    for (const target of targets) console.log(`${target.name}: ${found[target.name].length} cycles`);
    console.log(`baseline updated: ${path.relative(REPO_ROOT, BASELINE)}`);
    return;
  }

  let drifted = false;
  for (const target of targets) {
    const diff = compareToBaseline(found[target.name], baseline[target.name] ?? []);
    if (diff.added.length === 0 && diff.removed.length === 0) {
      console.log(`ok  ${target.name}: ${found[target.name].length} cycles, all known`);
      continue;
    }
    drifted = true;
    console.error(`FAIL ${target.name}: ${diff.added.length} new, ${diff.removed.length} resolved`);
    for (const cycle of diff.added) console.error(`  NEW    ${target.name}: ${cycle}`);
    for (const cycle of diff.removed) console.error(`  GONE   ${target.name}: ${cycle}`);
  }
  if (drifted) {
    console.error(
      "\nA NEW cycle means two modules now depend on each other: break it rather than record it." +
        "\nA GONE cycle means the baseline is stale: run `npm run check:cycles -- --update`.",
    );
    process.exit(1);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
