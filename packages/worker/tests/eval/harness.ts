import { classifyCommand } from "@/orchestrator/classifier";
import { CLASSIFIER_CASES, type CaseKind, type ClassifierCase } from "./classifier.cases";
import { EXTRA_CASES } from "./classifier.extra-cases";
import heldOutFile from "./held-out.json";

export const ALL_CASES: ClassifierCase[] = [...CLASSIFIER_CASES, ...EXTRA_CASES];
export const HELD_OUT_IDS = new Set<string>(heldOutFile.heldOut);

export interface CaseResult {
  id: string;
  command: string;
  lang: string;
  expectedKind: CaseKind;
  actualKind: string;
  kindOk: boolean;
  split: "tuning" | "held-out";
  /** Every expectation the case defines (kind + optional fields) matched. */
  ok: boolean;
  mismatches: string[];
}

export interface KindStats {
  kind: string;
  support: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface SplitStats {
  total: number;
  kindAccuracy: number;
  fullAccuracy: number;
  failures: string[];
}

export interface EvalReport {
  total: number;
  kindAccuracy: number;
  fullAccuracy: number;
  bySplit: Record<"tuning" | "held-out", SplitStats>;
  byKind: KindStats[];
  byLang: Array<{ lang: string; total: number; kindAccuracy: number }>;
  confusion: Record<string, Record<string, number>>;
  failures: CaseResult[];
  results: CaseResult[];
}

export function runCase(testCase: ClassifierCase): CaseResult {
  const got = classifyCommand(testCase.command);
  const want = testCase.expect;
  const mismatches: string[] = [];

  const kindOk = got.kind === want.kind;
  if (!kindOk) mismatches.push(`kind: expected ${want.kind}, got ${got.kind}`);
  if (want.strategy && got.strategy !== want.strategy) {
    mismatches.push(`strategy: expected ${want.strategy}, got ${got.strategy}`);
  }
  if (want.primaryCapability && got.suggestedCapabilities[0] !== want.primaryCapability) {
    mismatches.push(`primaryCapability: expected ${want.primaryCapability}, got ${got.suggestedCapabilities[0] ?? "none"}`);
  }
  if (want.investigation !== undefined && Boolean(got.investigation) !== want.investigation) {
    mismatches.push(`investigation: expected ${want.investigation}, got ${Boolean(got.investigation)}`);
  }
  if (want.commands && JSON.stringify(got.commands ?? []) !== JSON.stringify(want.commands)) {
    mismatches.push(`commands: expected ${JSON.stringify(want.commands)}, got ${JSON.stringify(got.commands ?? [])}`);
  }

  return {
    id: testCase.id,
    command: testCase.command,
    lang: testCase.lang,
    expectedKind: want.kind,
    actualKind: got.kind,
    kindOk,
    split: HELD_OUT_IDS.has(testCase.id) ? "held-out" : "tuning",
    ok: mismatches.length === 0,
    mismatches,
  };
}

const ratio = (num: number, den: number) => (den === 0 ? 0 : num / den);

export function runClassifierEval(cases: ClassifierCase[] = ALL_CASES): EvalReport {
  const results = cases.map(runCase);

  const kinds = [...new Set([...results.map((r) => r.expectedKind), ...results.map((r) => r.actualKind)])].sort();
  const confusion: Record<string, Record<string, number>> = {};
  for (const r of results) {
    confusion[r.expectedKind] ??= {};
    confusion[r.expectedKind][r.actualKind] = (confusion[r.expectedKind][r.actualKind] ?? 0) + 1;
  }

  const byKind: KindStats[] = kinds
    .filter((kind) => results.some((r) => r.expectedKind === kind))
    .map((kind) => {
      const tp = results.filter((r) => r.expectedKind === kind && r.actualKind === kind).length;
      const predicted = results.filter((r) => r.actualKind === kind).length;
      const support = results.filter((r) => r.expectedKind === kind).length;
      const precision = ratio(tp, predicted);
      const recall = ratio(tp, support);
      return { kind, support, precision, recall, f1: ratio(2 * precision * recall, precision + recall) };
    });

  const langs = [...new Set(results.map((r) => r.lang))].sort();
  const byLang = langs.map((lang) => {
    const subset = results.filter((r) => r.lang === lang);
    return { lang, total: subset.length, kindAccuracy: ratio(subset.filter((r) => r.kindOk).length, subset.length) };
  });

  const bySplit = (["tuning", "held-out"] as const).reduce(
    (acc, split) => {
      const subset = results.filter((r) => r.split === split);
      acc[split] = {
        total: subset.length,
        kindAccuracy: ratio(subset.filter((r) => r.kindOk).length, subset.length),
        fullAccuracy: ratio(subset.filter((r) => r.ok).length, subset.length),
        failures: subset.filter((r) => !r.ok).map((r) => r.id),
      };
      return acc;
    },
    {} as Record<"tuning" | "held-out", SplitStats>
  );

  return {
    total: results.length,
    kindAccuracy: ratio(results.filter((r) => r.kindOk).length, results.length),
    fullAccuracy: ratio(results.filter((r) => r.ok).length, results.length),
    bySplit,
    byKind,
    byLang,
    confusion,
    failures: results.filter((r) => !r.ok),
    results,
  };
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

export function formatReport(report: EvalReport, verbose = false): string {
  const lines: string[] = [];
  lines.push("Classifier eval");
  lines.push("=".repeat(60));
  lines.push(`cases:              ${report.total}`);
  lines.push(`kind accuracy:      ${pct(report.kindAccuracy)}  (right task kind)`);
  lines.push(`full accuracy:      ${pct(report.fullAccuracy)}  (kind + strategy/capability/etc.)`);
  for (const split of ["tuning", "held-out"] as const) {
    const s = report.bySplit[split];
    lines.push(
      `${split.padEnd(19)} ${String(s.total).padStart(3)} cases  kind ${pct(s.kindAccuracy)}  full ${pct(s.fullAccuracy)}`
    );
  }
  lines.push("");
  lines.push("Per kind            support  precision  recall     f1");
  for (const s of report.byKind) {
    lines.push(`  ${s.kind.padEnd(16)} ${String(s.support).padStart(7)}  ${pct(s.precision).padStart(9)}  ${pct(s.recall).padStart(6)}  ${pct(s.f1).padStart(6)}`);
  }
  lines.push("");
  lines.push("Per language        cases  kind accuracy");
  for (const l of report.byLang) {
    lines.push(`  ${l.lang.padEnd(16)} ${String(l.total).padStart(5)}  ${pct(l.kindAccuracy).padStart(12)}`);
  }
  lines.push("");
  lines.push("Confusion (expected -> got)");
  for (const [expected, row] of Object.entries(report.confusion)) {
    const cells = Object.entries(row).map(([got, n]) => `${got}:${n}`).join("  ");
    lines.push(`  ${expected.padEnd(16)} ${cells}`);
  }
  lines.push("");
  lines.push(`Failures (${report.failures.length})`);
  for (const f of report.failures) {
    lines.push(`  [${f.id}] (${f.lang}) ${JSON.stringify(f.command)}`);
    for (const m of f.mismatches) lines.push(`      ${m}`);
  }
  if (verbose) {
    lines.push("");
    lines.push("Passing");
    for (const r of report.results.filter((x) => x.ok)) lines.push(`  [${r.id}] ${JSON.stringify(r.command)}`);
  }
  return lines.join("\n");
}
