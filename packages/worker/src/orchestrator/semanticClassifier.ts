import { z } from "zod";
import { CAPABILITY, type Classification } from "@/types";
import { classifyCommand } from "./classifier";

export const SEMANTIC_PROMPT_VERSION = "v1";
export const SEMANTIC_SCHEMA_VERSION = "1";

export type TraceSource = "fast-path" | "llm" | "fallback" | "validator-override";

export interface SemanticClassification extends Classification {
  source: TraceSource;
  reasonCode: string;
}

const schema = z.object({
  kind: z.enum(["conversation", "audit", "research", "code_change", "multi", "command"]),
  capability: z.string().min(1).optional(),
  concerns: z.array(z.string()).max(8).optional(),
  investigation: z.boolean().optional(),
});

const FAST_PATH = /^(?:\/task\s+)?(?:hi|hello|hey|halo|hai|thanks|thank you|makasih|terima kasih)\b|^(?:fix|perbaiki)\s+typo\b/i;
const SYSTEM = `Classify the user's request. Return JSON only with keys kind, capability, concerns, investigation.
kind: conversation (social/pick), research (read-only question/verification), audit (review), code_change (explicit file edit), multi (two or more domains), command (allowlisted shell run).
Never infer code_change from an unknown or foreign-language phrase: use research when unsure.`;

export interface SemanticOptions {
  enabled: boolean;
  complete?: (prompt: string) => Promise<{ content: string }>;
  assertBudgetForCall?: () => void;
}

/** Regex fast path only for unambiguous shapes; everything else goes to the LLM. */
export function isSemanticFastPath(command: string): boolean {
  return FAST_PATH.test(command.trim());
}

function safeFallback(command: string, reasonCode: string): SemanticClassification {
  const base = classifyCommand(command);
  return {
    ...base,
    kind: "research",
    reasons: [`safe fallback: ${reasonCode}`],
    suggestedCapabilities: base.suggestedCapabilities.includes(CAPABILITY.RESEARCH)
      ? base.suggestedCapabilities
      : [CAPABILITY.RESEARCH, CAPABILITY.CODE_REVIEW],
    source: "fallback",
    reasonCode,
  };
}

/**
 * LLM-first classification behind ORCHESTRATOR_SEMANTIC_CLASSIFIER (default off).
 * The model may only propose; zod validates. Any failure falls back to a
 * read-only research classification, never to code_change.
 */
export async function classifyCommandSemantic(command: string, options: SemanticOptions): Promise<SemanticClassification> {
  if (!options.enabled) {
    return { ...classifyCommand(command), source: "fast-path", reasonCode: "FLAG_OFF" };
  }
  if (isSemanticFastPath(command)) {
    return { ...classifyCommand(command), source: "fast-path", reasonCode: "UNAMBIGUOUS_SHAPE" };
  }
  if (!options.complete) return safeFallback(command, "LLM_UNAVAILABLE");
  try {
    options.assertBudgetForCall?.();
    const reply = await options.complete(`${SYSTEM}\n\nRequest: ${command}`);
    const parsed = schema.parse(JSON.parse(reply.content));
    const base = classifyCommand(command);
    const capabilities = parsed.capability
      ? [parsed.capability, ...base.suggestedCapabilities]
      : base.suggestedCapabilities;
    return {
      ...base,
      kind: parsed.kind,
      concerns: base.concerns,
      investigation: parsed.investigation ?? base.investigation,
      reasons: ["semantic classification from LLM"],
      suggestedCapabilities: Array.from(new Set(capabilities)),
      source: "llm",
      reasonCode: "LLM_SCHEMA_VALID",
    };
  } catch (error) {
    const code = error instanceof Error && /budget/i.test(error.message) ? "BUDGET_VETO" : "LLM_INVALID";
    return safeFallback(command, code);
  }
}
