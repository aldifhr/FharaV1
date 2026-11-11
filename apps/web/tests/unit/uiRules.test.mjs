// GOAT G2 guard tests (+ Nuphos N9): the UI rules, code budget, suppression reasons,
// unawaited async assertions and the import-cycle ratchet. Rules live in
// scripts/guards/rules.mjs; the baselines are scripts/code-budgets.json and
// scripts/import-cycles.baseline.json. Existing offenders are baselined; anything new fails.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  MAX_LINES,
  brandUses,
  compareMeasures,
  countLines,
  isUiSource,
  measureFile,
  uiRuleCounts,
  unawaitedAsyncAssertions,
  unexplainedSuppressions,
} from "../../../../scripts/guards/rules.mjs";
import { measureTree, readBaseline } from "../../../../scripts/code-budget.mjs";
import {
  TARGETS,
  analyze,
  canonicalCycle,
  compareToBaseline,
  findCycles,
  partitionTargets,
} from "../../../../scripts/check-import-cycles.mjs";

const UI_FILE = "apps/web/components/Example.tsx";
// Built from parts so this file does not contain the directives it plants.
const TS = "@ts-";
const ED = "eslint-" + "disable";
const EE = "eslint-" + "enable";

test("animate-pulse is caught", () => {
  assert.equal(uiRuleCounts(`<div className="h-4 animate-pulse bg-hover" />`).pulse, 1);
  assert.equal(uiRuleCounts(`<div className="h-4 bg-hover" />`).pulse, 0);
  // prose in a comment is not a violation
  assert.equal(uiRuleCounts(`// never use animate-pulse here\n<div className="bg-hover" />`).pulse, 0);
});

test("pills and badges are caught", () => {
  assert.equal(uiRuleCounts(`<span className="rounded-full px-2 py-0.5 text-xs">x</span>`).pill, 1);
  assert.equal(uiRuleCounts(`<span className="px-2 rounded-full">x</span>`).pill, 1);
  assert.equal(uiRuleCounts(`import { Badge } from "@/components/ui/badge";`).pill, 1);
  assert.equal(uiRuleCounts(`<span className="status-pill text-ink-3">x</span>`).pill, 0);
  assert.equal(uiRuleCounts(`<span className="badge text-ink-3">x</span>`).pill, 1);
  // a round dot or avatar is not a pill
  assert.equal(uiRuleCounts(`<span className="h-2 w-2 rounded-full bg-ink-3" />`).pill, 0);
});

test("palette tints are caught, theme tokens are not", () => {
  assert.equal(uiRuleCounts(`<div className="bg-rose-100 text-rose-700 dark:bg-rose-950" />`).tint, 3);
  assert.equal(uiRuleCounts(`<div className="border-emerald-500/40" />`).tint, 1);
  assert.equal(uiRuleCounts(`<div className="bg-canvas bg-panel bg-hover border-line text-ink text-ink-2 text-ink-3" />`).tint, 0);
  assert.equal(uiRuleCounts(`<button className="bg-ink text-canvas">Go</button>`).tint, 0);
});

test("raw hex colours are caught, issue numbers are not", () => {
  assert.equal(uiRuleCounts(`<div className="bg-[#635bff] text-[#fff]" />`).hex, 2);
  assert.equal(uiRuleCounts(`const c = { color: "#1f9d55" };`).hex, 1);
  assert.equal(uiRuleCounts(`<p>Fixes PR #123 and #456</p>`).hex, 0);
});

test("the retired brand colour is caught, ink is not (dashboard F1)", () => {
  assert.equal(brandUses(`<button className="bg-brand text-white hover:bg-brand-hover focus-visible:ring-brand/40" />`), 3);
  assert.equal(brandUses(`<span className="bg-brand-soft text-brand-ink accent-[var(--shell-brand)]" />`), 3);
  assert.equal(brandUses(`<button className="bg-ink text-canvas hover:bg-ink/85 focus-visible:ring-ink/30" />`), 0);
  assert.equal(brandUses(`const label = "brand new"; // was bg-brand`), 0);
  assert.equal(measureFile(UI_FILE, `const s = "bg-brand";`).brand, 1);
});

test("suppressions need a reason", () => {
  assert.deepEqual(unexplainedSuppressions(`// ${TS}ignore\nconst x = 1;`), [1]);
  assert.deepEqual(unexplainedSuppressions(`// ${TS}expect-error: upstream type is wrong\nconst x = 1;`), []);
  assert.deepEqual(unexplainedSuppressions(`// ${ED}-next-line no-console\nconsole.log(1);`), [1]);
  assert.deepEqual(unexplainedSuppressions(`// ${ED}-next-line no-console -- CLI output\nconsole.log(1);`), []);
  assert.deepEqual(unexplainedSuppressions(`// The CLI prints its result.\n// ${ED}-next-line no-console\nconsole.log(1);`), []);
  assert.deepEqual(unexplainedSuppressions(`foo(); // ${ED}-line\n`), [1]);
  assert.deepEqual(unexplainedSuppressions(`/* ${EE} */`), []);
});

test("unawaited .rejects/.resolves are caught (Nuphos N9)", () => {
  const planted = [
    `test("a", async () => {`,
    `  expect(load()).rejects.toThrow("x");`,
    `  await expect(load()).rejects.toThrow("x");`,
    `  return expect(load()).resolves.toBe(1);`,
    `});`,
    `test("b", () => {`,
    `  expect.soft(load()).resolves.toEqual({});`,
    `  expect(load()).toBe(1);`,
    `});`,
  ].join("\n");
  assert.deepEqual(unawaitedAsyncAssertions(planted, "x.test.ts"), [2, 7]);
  assert.equal(measureFile("packages/worker/tests/x.test.ts", planted).unawaited, 2);
});

test("file budget: a new file over the limit fails, a baselined one may not grow", () => {
  const big = "x\n".repeat(MAX_LINES + 1);
  assert.equal(countLines(big), MAX_LINES + 1);
  assert.equal(countLines("a\nb"), 2);
  const measured = { "packages/worker/src/new.ts": measureFile("packages/worker/src/new.ts", big) };
  assert.equal(compareMeasures(measured, {}).problems.length, 1);
  assert.equal(compareMeasures(measured, { "packages/worker/src/new.ts": { lines: MAX_LINES + 1 } }).problems.length, 0);
  assert.equal(compareMeasures(measured, { "packages/worker/src/new.ts": { lines: MAX_LINES + 5 } }).improved.length, 1);
});

test("UI rules only apply to the web app's own source", () => {
  assert.equal(isUiSource(UI_FILE), true);
  assert.equal(isUiSource("apps/web/tests/unit/x.test.mjs"), false);
  assert.equal(isUiSource("packages/worker/src/prompts/x.ts"), false);
  assert.equal(measureFile("packages/worker/src/x.ts", `const s = "animate-pulse bg-rose-100";`).pulse, undefined);
  assert.equal(measureFile(UI_FILE, `const s = "animate-pulse bg-rose-100";`).pulse, 1);
});

test("the tree is within scripts/code-budgets.json", () => {
  const { problems } = compareMeasures(measureTree(), readBaseline());
  assert.deepEqual(
    problems.map((p) => `${p.file}: ${p.rule} ${p.found} > ${p.allowed}`),
    [],
    "over the guard baseline; fix it rather than raising the baseline",
  );
});

test("import cycles: canonical rotation and the ratchet", () => {
  assert.deepEqual(canonicalCycle(["c", "a", "b"]), ["a", "b", "c"]);
  assert.deepEqual(compareToBaseline(["a -> b", "c -> d"], ["a -> b", "e -> f"]), { added: ["c -> d"], removed: ["e -> f"] });
  assert.deepEqual(findCycles({ a: ["b"], b: ["c"], c: ["a"], d: ["a"] }), ["a -> b -> c"]);
  assert.deepEqual(findCycles({ a: ["b"], b: [] }), []);
  assert.throws(() => partitionTargets([{ name: "x", roots: ["r1", "r2"] }], (r) => r === "r1"), /roots missing/);
  assert.deepEqual(partitionTargets(TARGETS, () => false).skipped, TARGETS.map((t) => t.name));
});

test("import cycles: a planted cycle is found, type-only imports are not edges", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fhara-cycles-"));
  try {
    mkdirSync(path.join(root, "pkg/src"), { recursive: true });
    writeFileSync(path.join(root, "pkg/tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true } }));
    writeFileSync(path.join(root, "pkg/src/a.ts"), `import { b } from "./b";\nexport const a = () => b();\n`);
    writeFileSync(path.join(root, "pkg/src/b.ts"), `import { a } from "./a";\nexport const b = () => a;\n`);
    writeFileSync(path.join(root, "pkg/src/c.ts"), `import type { D } from "./d";\nexport type C = D;\n`);
    writeFileSync(path.join(root, "pkg/src/d.ts"), `import { type C } from "./c";\nexport type D = C | 1;\n`);
    const target = { name: "pkg", roots: ["pkg/src"], tsConfig: "pkg/tsconfig.json" };
    assert.deepEqual(analyze(root, target), ["a.ts -> b.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
