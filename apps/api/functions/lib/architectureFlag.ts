/**
 * Orchestrator/CTO split O1: the planner's architecture flag and the CTO
 * decision verdict (pure, shared by the worker planner and the stored-plan
 * validator so a reviewed / resumed plan keeps its flag).
 *
 * The CTO is consulted only when a plan is flagged: a new dependency or
 * framework, a schema / data-model change, an auth or security boundary, a
 * new cross-component API contract, or an infra change that alters the
 * architecture. Small decisions inside a role's own scope get no CTO node.
 */

export const ARCHITECTURE_REASONS = [
  "new_dependency",
  "schema_change",
  "auth_boundary",
  "api_contract",
  "infra_deploy",
] as const;

export type ArchitectureReason = (typeof ARCHITECTURE_REASONS)[number];

export interface ArchitectureFlag {
  needed: boolean;
  reasons: ArchitectureReason[];
  /** The decision the CTO is asked to make, in one line. */
  question: string;
  /** Subtask keys that wait for the decision (empty = every write node). */
  gatedKeys: string[];
  /** Who raised the flag: the planner LLM, the deterministic backstop, or both. */
  source?: "planner" | "backstop" | "both";
}

/** Key of the CTO decision node the planner inserts for a flagged plan. */
export const ARCH_DECISION_KEY = "arch-decision";

const REASON_SET = new Set<string>(ARCHITECTURE_REASONS);

/** Normalizes the planner's `architecture` field; malformed input → undefined. */
export function parseArchitectureFlag(raw: unknown): ArchitectureFlag | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const candidate = raw as Record<string, unknown>;
  const reasons = Array.isArray(candidate.reasons)
    ? [...new Set(candidate.reasons.filter((r): r is ArchitectureReason => typeof r === "string" && REASON_SET.has(r)))]
    : [];
  const needed = candidate.needed === true && reasons.length > 0;
  const question = typeof candidate.question === "string" ? candidate.question.trim().slice(0, 300) : "";
  const gatedKeys = Array.isArray(candidate.gatedKeys)
    ? [...new Set(candidate.gatedKeys.filter((k): k is string => typeof k === "string" && k.trim() !== "").map((k) => k.trim()))]
    : [];
  const source =
    candidate.source === "planner" || candidate.source === "backstop" || candidate.source === "both"
      ? candidate.source
      : undefined;
  return { needed, reasons, question, gatedKeys, ...(source ? { source } : {}) };
}

export type ArchVerdict = "go" | "revise" | "stop";

/**
 * Reads the CTO's closing `Decision: go | revise | stop` line (last match
 * wins). A missing or unreadable verdict is treated as `go` with
 * `parsed: false`, so the CTO stays an advisor and never deadlocks a task.
 */
export function parseArchVerdict(text: string | undefined | null): { verdict: ArchVerdict; parsed: boolean } {
  const matches = [...(text ?? "").matchAll(/\bdecision\s*[:：-]\s*\**\s*(go|revise|stop)\b/gi)];
  const last = matches.at(-1)?.[1]?.toLowerCase();
  if (last === "go" || last === "revise" || last === "stop") return { verdict: last, parsed: true };
  return { verdict: "go", parsed: false };
}

/** Prefix of the replan feedback a `revise` verdict carries back to the planner. */
export const ARCH_REVISE_FEEDBACK_PREFIX = "Architecture decision: revise";
