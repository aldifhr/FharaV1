/**
 * Item 7: why a run ended, more precise than its task status. The status
 * values ("failed", "cancelled", "rejected") stay as they are for the UI and
 * filters; this optional, additive field rides on the terminal event
 * (task.error, task.cancelled, budget.exhausted, llm.provider_hold,
 * orchestrator.step_limit, task.outcome). Pure.
 */
export const FAILURE_KINDS = [
  "review_rejected",
  "verify_failed",
  "qa_failed",
  "budget_exhausted",
  "approval_rejected",
  "apply_conflict",
  "provider_hold",
  "no_change",
  "cancelled",
  "error",
] as const;

export type FailureKind = (typeof FAILURE_KINDS)[number];

export function isFailureKind(value: unknown): value is FailureKind {
  return typeof value === "string" && (FAILURE_KINDS as readonly string[]).includes(value);
}

/**
 * The failure kind of one executePlan terminal exit: cancellation and the
 * step bound first, then the exit's own explicit kind, a budget halt, a
 * re-review that rejected the final snapshot inside verify / QA, and
 * finally the kind of the phase that ended the run.
 */
export function failureKindForExit(facts: {
  status: string;
  explicit?: FailureKind;
  phaseKind?: FailureKind;
  budgetHalt?: boolean;
  /** The latest review verdict on the final snapshot (a re-review inside verify / QA may reject it). */
  snapshotReview?: "approved" | "changes_requested";
}): FailureKind | undefined {
  if (facts.status === "cancelled") return "cancelled";
  if (facts.status === "step_limit") return "budget_exhausted";
  if (facts.status !== "failed") return undefined;
  if (facts.explicit) return facts.explicit;
  if (facts.budgetHalt) return "budget_exhausted";
  if (facts.snapshotReview === "changes_requested" && (facts.phaseKind === "verify_failed" || facts.phaseKind === "qa_failed")) {
    return "review_rejected";
  }
  return facts.phaseKind ?? "error";
}

/** The failure kind processTask / resume end a failed run with, after decideReplan. */
export function failureKindForEnding(facts: { trigger: string; executeKind?: FailureKind }): FailureKind {
  if (facts.trigger === "verify_failed") return "verify_failed";
  return facts.executeKind ?? "error";
}
