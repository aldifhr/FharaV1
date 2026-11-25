import { z } from "zod";

export const TRACE_PROMPT_VERSION = "v1";
export const TRACE_SCHEMA_VERSION = "1";

const SOURCES = ["fast-path", "llm", "fallback", "validator-override"] as const;
const REASON_CODES = [
  "FLAG_OFF", "UNAMBIGUOUS_SHAPE", "LLM_SCHEMA_VALID", "LLM_INVALID", "LLM_UNAVAILABLE",
  "BUDGET_VETO", "VALIDATOR_OVERRIDE", "DECISION_EXECUTE", "DECISION_DELEGATE", "DECISION_REPLAN",
  "DECISION_COMPLETE", "DECISION_ASK_USER", "STEP_LIMIT", "FALLBACK_RECORDED",
] as const;

export type TraceSource = (typeof SOURCES)[number];
export type TraceReasonCode = (typeof REASON_CODES)[number];

const schema = z.object({
  at: z.number(),
  stage: z.enum(["classify", "route", "plan", "decide"]),
  choice: z.string().max(64),
  source: z.enum(SOURCES),
  reasonCode: z.enum(REASON_CODES),
  proposedChoice: z.string().max(64).optional(),
  model: z.string().max(64).optional(),
  tokensIn: z.number().optional(),
  tokensOut: z.number().optional(),
  decisionId: z.string().max(64).optional(),
  promptVersion: z.string().max(16),
  schemaVersion: z.string().max(16),
});

export type DecisionTrace = z.infer<typeof schema>;

/** Enum-only reason mapping: model prose is never written to taskEvents. */
export function reasonCodeFor(action: string, flags: { stepLimit?: boolean; fallback?: boolean; override?: boolean } = {}): TraceReasonCode {
  if (flags.stepLimit) return "STEP_LIMIT";
  if (flags.override) return "VALIDATOR_OVERRIDE";
  if (flags.fallback) return "FALLBACK_RECORDED";
  const map: Record<string, TraceReasonCode> = {
    execute: "DECISION_EXECUTE",
    delegate: "DECISION_DELEGATE",
    replan: "DECISION_REPLAN",
    complete: "DECISION_COMPLETE",
    ask_user: "DECISION_ASK_USER",
  };
  return map[action] ?? "DECISION_EXECUTE";
}

export function buildDecisionTrace(input: Omit<DecisionTrace, "at" | "promptVersion" | "schemaVersion">): DecisionTrace {
  return schema.parse({
    ...input,
    at: Date.now(),
    promptVersion: TRACE_PROMPT_VERSION,
    schemaVersion: TRACE_SCHEMA_VERSION,
  });
}
