/**
 * Intent-classifier eval CLI.
 *
 *   pnpm --filter @fhara/worker eval:classifier
 *   pnpm --filter @fhara/worker eval:classifier --verbose
 *   pnpm --filter @fhara/worker eval:classifier --json
 *   pnpm --filter @fhara/worker eval:classifier --min=0.85      (exit 1 below)
 *   pnpm --filter @fhara/worker eval:classifier --update-baseline
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { formatReport, runClassifierEval } from "../tests/eval/harness";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const minArg = args.find((a) => a.startsWith("--min="));

const report = runClassifierEval();

if (flag("--update-baseline")) {
  const file = path.resolve(import.meta.dirname, "../tests/eval/baseline.json");
  const knownFailures = report.failures.map((f) => f.id).sort();
  writeFileSync(file, `${JSON.stringify({ knownFailures }, null, 2)}\n`);
  console.log(`baseline updated: ${knownFailures.length} known failure(s) -> ${file}`);
}

if (flag("--json")) {
  console.log(JSON.stringify({ ...report, results: undefined }, null, 2));
} else {
  console.log(formatReport(report, flag("--verbose")));
}

if (minArg) {
  const min = Number(minArg.split("=")[1]);
  if (!(report.kindAccuracy >= min)) {
    console.error(`\nkind accuracy ${(report.kindAccuracy * 100).toFixed(1)}% is below --min=${min}`);
    process.exit(1);
  }
}
