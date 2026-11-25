/**
 * Real-model classifier eval for plan 085. OPT-IN and paid: not part of
 * test:evals or CI. Uses the SAME grader as the deterministic harness.
 *   EVAL_MODEL=... EVAL_BASE_URL=... EVAL_API_KEY=... pnpm eval:model
 */
import { ALL_CASES, HELD_OUT_IDS, gradePrediction, runCase } from "../tests/eval/harness";
import { createGlobalLLMProvider } from "@/llm";
import { CLASSIFY_SYSTEM_PROMPT, SEMANTIC_SCHEMA_VERSION, classifyCommandSemantic } from "@/orchestrator/semanticClassifier";

const model = process.env.EVAL_MODEL;
const baseUrl = process.env.EVAL_BASE_URL;
const apiKey = process.env.EVAL_API_KEY;
if (!model || !baseUrl || !apiKey) {
  console.error("EVAL_MODEL, EVAL_BASE_URL and EVAL_API_KEY are required");
  process.exit(1);
}
const provider = createGlobalLLMProvider({ provider: "openai-compatible", model, baseUrl, apiKey });

async function main() {
const deterministic = ALL_CASES.map(runCase);
const byId = new Map(ALL_CASES.map((entry, index) => [entry.id, deterministic[index]!]));
const runs = await Promise.all([1, 2, 3].map(async (run) => {
  const rows: Array<{ id: string; lang: string; split: string; grade: ReturnType<typeof gradePrediction>; actual: string; source: string; reason: string }> = [];
  for (const entry of ALL_CASES) {
    let source = "fast-path";
    let reason = "FLAG_OFF";
    const semantic = await classifyCommandSemantic(entry.command, {
      enabled: true,
      complete: async (prompt) => {
        const result = await provider.complete(
          [{ role: "system", content: CLASSIFY_SYSTEM_PROMPT }, { role: "user", content: prompt }],
          model,
          { temperature: 0, responseFormat: "json" }
        );
        return { content: result.content };
      },
    });
    source = semantic.source;
    reason = semantic.reasonCode;
    rows.push({
      id: entry.id,
      lang: entry.lang,
      split: HELD_OUT_IDS.has(entry.id) ? "held-out" : "tuning",
      grade: gradePrediction(entry, semantic),
      actual: semantic.kind,
      source,
      reason,
    });
  }
  return { run, rows };
}));

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const count = (rows: typeof runs[number]["rows"], predicate: (row: typeof runs[number]["rows"][number]) => boolean) => rows.filter(predicate).length;
const range = (values: number[]) => `${values.length ? pct(Math.min(...values)) : "0.0"}–${values.length ? pct(Math.max(...values)) : "0.0"}`;

console.log(`model: ${model}`);
console.log(`schema: ${SEMANTIC_SCHEMA_VERSION}`);
console.log("temperature: 0, runs: 3, grading: shared harness (kind+strategy+capability+investigation+commands)");
const priceIn = Number(process.env.EVAL_INPUT_PRICE_PER_1K ?? 0);
const priceOut = Number(process.env.EVAL_OUTPUT_PRICE_PER_1K ?? 0);
console.log(`cost config: in ${priceIn}/1k, out ${priceOut}/1k (0 = price unavailable in registry)`);

for (const split of ["tuning", "held-out"] as const) {
  const base = deterministic.filter((row) => row.split === split);
  const acc: number[] = [];
  const kindAcc: number[] = [];
  for (const { rows } of runs) {
    const subset = rows.filter((row) => row.split === split);
    acc.push(count(subset, (row) => row.grade.ok) / subset.length);
    kindAcc.push(count(subset, (row) => row.grade.kindOk) / subset.length);
  }
  console.log(`${split}: cases ${base.length}  kind ${range(kindAcc)}  full ${range(acc)}`);
}

for (const run of runs) {
  const dist = (key: "source" | "reason") => {
    const values = new Map<string, number>();
    for (const row of run.rows) values.set(row[key], (values.get(row[key]) ?? 0) + 1);
    return [...values.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(" ");
  };
  console.log(`run ${run.run}: source {${dist("source")}} reason {${dist("reason")}}`);
}

const confusion: Record<string, Record<string, number>> = {};
for (const row of runs[2]!.rows) {
  confusion[row.grade.expectedKind] ??= {};
  confusion[row.grade.expectedKind][row.actual] = (confusion[row.grade.expectedKind][row.actual] ?? 0) + 1;
}
console.log("confusion (expected -> got, run 3)");
for (const [expected, row] of Object.entries(confusion)) {
  console.log(`  ${expected.padEnd(14)} ${Object.entries(row).map(([got, n]) => `${got}:${n}`).join("  ")}`);
}

for (const lang of ["en", "id", "other"] as const) {
  const values = runs.map(({ rows }) => {
    const subset = rows.filter((row) => row.lang === lang);
    return count(subset, (row) => row.grade.kindOk) / subset.length;
  });
  const baseSubset = deterministic.filter((row) => row.lang === lang);
  console.log(`lang ${lang}: cases ${baseSubset.length} kind ${range(values)}`);
}

for (const split of ["tuning", "held-out"] as const) {
  for (const lang of ["en", "id", "other"] as const) {
    const improved: number[] = [];
    const broken: number[] = [];
    for (const { rows } of runs) {
      const subset = rows.filter((row) => row.split === split && row.lang === lang);
      improved.push(count(subset, (row) => !byId.get(row.id)!.ok && row.grade.ok));
      broken.push(count(subset, (row) => byId.get(row.id)!.ok && !row.grade.ok));
    }
    console.log(`paired ${split}/${lang}: fixed ${Math.min(...improved)}–${Math.max(...improved)}  broken ${Math.min(...broken)}–${Math.max(...broken)}`);
  }
}
}

void main();
