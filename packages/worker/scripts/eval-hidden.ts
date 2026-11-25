/**
 * One-shot hidden held-out grader. Prints ONLY four aggregate numbers.
 * Never prints commands, labels, or failing case ids. Run once at the end of
 * step 2; the run count is recorded in a gitignored local marker.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runCase } from "../tests/eval/harness";

const file = path.resolve(import.meta.dirname, "../tests/eval/hidden.cases.local.json");
const marker = path.resolve(import.meta.dirname, "../tests/eval/.hidden-runs.local");
if (!existsSync(file)) {
  console.error("hidden cases not present");
  process.exit(1);
}
const cases = JSON.parse(readFileSync(file, "utf8")) as Parameters<typeof runCase>[0][];
const results = cases.map(runCase);
const kind = results.filter((row) => row.kindOk).length;
const correct = results.filter((row) => row.ok).length;
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const runs = existsSync(marker) ? Number(readFileSync(marker, "utf8")) + 1 : 1;
writeFileSync(marker, String(runs));

console.log(`cases: ${results.length}`);
console.log(`kind accuracy: ${pct(results.length ? kind / results.length : 0)}`);
console.log(`full accuracy: ${pct(results.length ? correct / results.length : 0)}`);
console.log(`correct: ${correct}`);
