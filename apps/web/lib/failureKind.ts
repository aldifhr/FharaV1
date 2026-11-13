/**
 * Item 7: the precise reason a task run ended, carried as an optional
 * `failureKind` on its terminal event payload (task.error, task.cancelled,
 * budget.exhausted, llm.provider_hold, orchestrator.step_limit,
 * task.outcome). Task status values are unchanged; this only labels them.
 */
const LABELS: Record<string, string> = {
  review_rejected: "Review rejected the changes",
  verify_failed: "Verification failed",
  qa_failed: "QA failed",
  budget_exhausted: "Budget exhausted",
  approval_rejected: "Changes rejected",
  apply_conflict: "Changes could not be applied",
  provider_hold: "Model provider unavailable",
  no_change: "No changes produced",
  cancelled: "Cancelled",
  error: "Agent error",
};

/** Label for a failure kind; unknown or missing kinds (older events) fall back to "Agent error". */
export function failureKindLabel(kind: unknown): string {
  return typeof kind === "string" && LABELS[kind] ? LABELS[kind] : "Agent error";
}

/** The failure kind of the latest event (events oldest-first) that carries a known one, or null. */
export function latestFailureKind(events: ReadonlyArray<{ payload?: { failureKind?: unknown } | null }> | null | undefined): string | null {
  for (let index = (events?.length ?? 0) - 1; index >= 0; index -= 1) {
    const kind = events![index]?.payload?.failureKind;
    if (typeof kind === "string" && LABELS[kind]) return kind;
  }
  return null;
}
