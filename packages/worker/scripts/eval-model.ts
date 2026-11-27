/**
 * Real-model classifier eval for plan 085. OPT-IN and paid: not part of
 * test:evals or CI. Reads all cases from tests/eval; never uses held-out cases
 * as few-shot examples. Prints tuning/held-out accuracy separately.
 *
 *   EVAL_MODEL=... EVAL_BASE_URL=... EVAL_API_KEY=... pnpm eval:model
 */
import { ALL_CASES, HELD_OUT_IDS } from "../tests/eval/harness";
import { createGlobalLLMProvider } from "@/llm";
import { SEMANTIC_SCHEMA_VERSION } from "@/orchestrator/semanticClassifier";
import { classifyCommandSemantic } from "@/orchestrator/semanticClassifier";

const model = process.env.EVAL_MODEL;
const baseUrl = process.env.EVAL_BASE_URL;
const apiKey = process.env.EVAL_API_KEY;
if (!model || !baseUrl || !apiKey) {
  console.error("EVAL_MODEL, EVAL_BASE_URL and EVAL_API_KEY are required");
  process.exit(1);
}
const provider = createGlobalLLMProvider({ provider: "openai-compatible", model, baseUrl, apiKey });
let inputTokens = 0;
let outputTokens = 0;
const counts = { "tuning-total": 0, "tuning-kind": 0, "tuning-full": 0, "held-out-total": 0, "held-out-kind": 0, "held-out-full": 0 };
for (const entry of ALL_CASES) {
  const semantic = await classifyCommandSemantic(entry.command, {
    enabled: true,
    complete: async (prompt) => {
      const result = await provider.complete([{ role: "user", content: prompt }]);
      inputTokens += result.inputTokens ?? 0;
      outputTokens += result.outputTokens ?? 0;
      return { content: result.content };
    },
  });
  const split = HELD_OUT_IDS.has(entry.id) ? "held-out" : "tuning";
  counts[`${split}-total`] += 1;
  if (semantic.kind === entry.expect.kind) counts[`${split}-kind`] += 1;
  if (semantic.kind === entry.expect.kind && (!entry.expect.primaryCapability || semantic.suggestedCapabilities[0] === entry.expect.primaryCapability)) {
    counts[`${split}-full`] += 1;
  }
}
const inPrice = Number(process.env.EVAL_INPUT_PRICE_PER_1K ?? 0);
const outPrice = Number(process.env.EVAL_OUTPUT_PRICE_PER_1K ?? 0);
const cost = (inputTokens / 1000) * inPrice + (outputTokens / 1000) * outPrice;
const pct = (a: number, b: number) => `${b ? ((a / b) * 100).toFixed(1) : "0.0"}%`;
console.log(`model: ${model}`);
console.log(`schema: ${SEMANTIC_SCHEMA_VERSION}`);
console.log(`tokens: in ${inputTokens}, out ${outputTokens}`);
console.log(`cost: ${cost.toFixed(4)} (set EVAL_INPUT_PRICE_PER_1K/EVAL_OUTPUT_PRICE_PER_1K for real pricing)`);
for (const split of ["tuning", "held-out"] as const) {
  console.log(`${split}: cases ${counts[`${split}-total`]}  kind ${pct(counts[`${split}-kind`], counts[`${split}-total`])}  full ${pct(counts[`${split}-full`], counts[`${split}-total`])}`);
}
