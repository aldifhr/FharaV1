/**
 * Ablation: replace one regex literal in classifier.ts with a never-matching
 * regex, run the shared eval, and record the delta. Nothing is removed from
 * the source permanently; candidates must be reviewed against incident
 * comments and git blame before any deletion.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const file = path.resolve(import.meta.dirname, "../src/orchestrator/classifier.ts");
const original = readFileSync(file, "utf8");
const lines = original.split("\n");
const assignment = /^\s*const\s+([A-Z_][A-Z0-9_]*)\s*=\s*([\s\S]*)/;
const targets: Array<{ name: string; start: number; end: number; flags: string }> = [];
for (let i = 0; i < lines.length; i += 1) {
  const match = assignment.exec(lines[i]!);
  if (!match) continue;
  const statement = [match[2]!];
  let end = i;
  while (end < lines.length - 1 && !/;\s*$/.test(statement[statement.length - 1]!)) {
    end += 1;
    statement.push(lines[end]!);
  }
  const rhs = statement.join("\n");
  if (!/^\//.test(rhs.trim()) && !/new RegExp\s*\(/.test(rhs)) continue;
  const literalFlags = /\/([a-z]*)\s*;?\s*$/.exec(rhs)?.[1];
  const factoryFlags = /,\s*["'`]([a-z]*)["'`]\s*\)\s*;?\s*$/.exec(rhs)?.[1];
  targets.push({ name: match[1]!, start: i + 1, end: end + 1, flags: literalFlags ?? factoryFlags ?? "i" });
}

const runEval = () => {
  const result = spawnSync("pnpm", ["exec", "tsx", "scripts/eval-classifier.ts", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const stdout = result.stdout ?? "";
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`eval produced no JSON: ${stdout.slice(0, 200)} ${result.stderr ?? ""}`);
  return JSON.parse(stdout.slice(start, end + 1));
};

const shape = (report: ReturnType<typeof runEval>) => ({
  kind: report.kindAccuracy,
  full: report.fullAccuracy,
  tuningKind: report.bySplit.tuning.kindAccuracy,
  tuningFull: report.bySplit.tuning.fullAccuracy,
  heldKind: report.bySplit["held-out"].kindAccuracy,
  heldFull: report.bySplit["held-out"].fullAccuracy,
  failures: report.failures.map((row: { id: string }) => row.id).sort(),
});

const baseline = shape(runEval());
const rows = [];
try {
  for (const target of targets) {
    const variant = [...lines];
    variant.splice(target.start - 1, target.end - target.start + 1, `const ${target.name} = /(?!) /${target.flags};`.replace("(?!) /", "(?!)/"));
    writeFileSync(file, variant.join("\n"));
    const after = shape(runEval());
    rows.push({
      name: target.name,
      line: target.start,
      before: { ...baseline, failures: undefined },
      after: { ...after, failures: undefined },
      sameMetrics: JSON.stringify({ ...baseline, failures: undefined }) === JSON.stringify({ ...after, failures: undefined }),
      sameFailures: JSON.stringify(baseline.failures) === JSON.stringify(after.failures),
      newlyFailing: after.failures.filter((id: string) => !baseline.failures.includes(id)),
      newlyPassing: baseline.failures.filter((id: string) => !after.failures.includes(id)),
    });
  }
} finally {
  writeFileSync(file, original);
}

const report = {
  source: "packages/worker/src/orchestrator/classifier.ts",
  baseline,
  ablated: targets.length,
  rows,
  zeroImpactCandidates: rows.filter((row) => row.sameMetrics && row.sameFailures).map((row) => ({ name: row.name, line: row.line })),
};
const out = path.resolve(import.meta.dirname, "../tests/eval/ablation.json");
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(`ablated ${targets.length} regexes; zero-impact ${report.zeroImpactCandidates.length} -> ${out}`);
