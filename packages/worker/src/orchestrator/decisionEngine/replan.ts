import { classifyProviderHold } from "@/api/convex/lib/providerHold";

/**
 * P1b phase 2 (one replan owner): the ONLY place that decides whether a run
 * is re-planned. Every boundary that used to decide inline now reports a
 * `replan_trigger` observation and performs the `ReplanDecision` it gets:
 *
 *   - `objective_unmet`     taskRunner, executePlan returned status "replan"
 *                           (engine objective, escalation, acceptance or
 *                           coverage hand-back, architecture revise)
 *   - `verify_failed`       taskRunner, finalize's verdict was "failed"
 *   - `terminal_failure`    taskRunner, executePlan returned status "failed"
 *   - `acceptance_rejected` executePlan, a required acceptance gate failed
 *   - `coverage_gaps`       executePlan, requirements without evidence
 *
 * A no-op run ("No effective change", nothing staged) is not a trigger of
 * its own: `objective_unmet` and `terminal_failure` both resolve to
 * `already_done` when the facts say so.
 *
 * Pure: facts in, decision out. The caller keeps every side effect (events,
 * completeTask, replanOnce, the bounded loop). Behaviour is unchanged from
 * the inline sites it replaced; tests/decisionEngine.golden.test.ts pins
 * the event sequence of every trigger recorded before the move.
 */

export type ReplanTrigger =
  | "objective_unmet"
  | "verify_failed"
  | "terminal_failure"
  | "acceptance_rejected"
  | "coverage_gaps";

/** Live run facts the replan decision reads. Only `replansLeft` is needed at the executePlan boundary. */
export interface ReplanFacts {
  /** Planning iterations still allowed (maxPlanningIterations - replans, floored at 0). */
  replansLeft: number;
  /** Replans already spent (reported in the exhaustion message). */
  replans?: number;
  /** The run's per-node feedback lines (`state.feedback`). */
  feedback?: ReadonlyArray<string>;
  /** Staged file changes (`state.fileChanges`); only the size is read. */
  fileChanges?: { size: number };
  /** A verify-fix loop's own terminal failure (`state.terminalFailure`). */
  terminalFailure?: string;
  /** The task's cancellation / deadline signal fired. */
  aborted?: boolean;
}

/** The `replan_trigger` observation (see `EngineObservation` in index.ts). */
export interface ReplanObservation {
  kind: "replan_trigger";
  trigger: ReplanTrigger;
  /** What the boundary observed: the replan feedback, the failed checks, the gate or coverage note. */
  reason?: string;
  facts: ReplanFacts;
}

/** What the caller does next. `replan` at the executePlan boundary means "hand a replan back to the loop". */
export type ReplanDecision =
  /** Re-plan once (bounded). The extra fields ride into replanOnce unchanged. */
  | { kind: "replan"; reason: string; eventFeedback?: string; timedOutFrom?: string }
  /** End the task failed with this message (`cause` says why, for logs and tests). */
  | { kind: "fail"; message: string; cause: "provider_hold" | "terminal_failure" | "exhausted" }
  /** A no-op run: the change is already there, end as done (task.no_change). */
  | { kind: "already_done"; files: string[] }
  /** Budget stop: terminal, budget.exhausted with this reason. */
  | { kind: "budget_exhausted"; reason: string }
  /** The cancellation / deadline won. */
  | { kind: "cancel" }
  /** No replan left at an executePlan gate: block the task with this feedback line. */
  | { kind: "block"; message: string }
  /** Nothing to replan: carry on with the normal path (verify_failed with no replan left). */
  | { kind: "proceed" };

/** Engine-requested reasons that already name their own cause (plan 022). */
const OWN_REASON = /^(Escalation from subtask|Acceptance gates failed|Requirements not covered|Architecture decision: revise)/;

/** The failure summary a failed run reports when no node left feedback. */
const NO_DETAIL_FAILURE =
  "Execution failed without a detailed error. Check the task events for the failing subtask.";

/** The one replan decision for a trigger. */
export function decideReplan(observation: ReplanObservation): ReplanDecision {
  const { facts } = observation;
  const canReplan = facts.replansLeft > 0;
  const feedback = facts.feedback ?? [];
  switch (observation.trigger) {
    case "acceptance_rejected": {
      // Plan 022: a failed required gate is a fix iteration, or blocks the task.
      const reason = observation.reason ?? "Acceptance gates failed";
      return canReplan ? { kind: "replan", reason } : { kind: "block", message: reason };
    }
    case "coverage_gaps": {
      // Plan 025: a gap is a bounded replan; with none left, "completed with gaps".
      const note = observation.reason ?? "";
      return canReplan ? { kind: "replan", reason: note } : { kind: "block", message: `Completed with gaps. ${note}` };
    }
    case "verify_failed": {
      if (!canReplan) return { kind: "proceed" };
      // No replan after cancellation/deadline (Phase 4 hardening).
      if (facts.aborted) return { kind: "cancel" };
      return { kind: "replan", reason: observation.reason ?? "Verification failed" };
    }
    case "objective_unmet": {
      const missing = observation.reason ?? "objective not satisfied";
      // O3 (bug c): a provider hold behind the replan holds the task.
      const held = findProviderHoldMessage([missing, ...feedback]);
      if (held) return { kind: "fail", message: held, cause: "provider_hold" };
      // A no-op: the change is already there; a replan would be a repeat.
      const files = noOpFiles(facts);
      if (files) return { kind: "already_done", files };
      if (canReplan) {
        return { kind: "replan", reason: OWN_REASON.test(missing) ? missing : `Objective not satisfied: ${missing}` };
      }
      return { kind: "fail", message: `Objective not satisfied after ${facts.replans ?? 0} replan(s): ${missing}`, cause: "exhausted" };
    }
    case "terminal_failure": {
      // A failure that is really a cancellation is never replanned.
      if (facts.aborted) return { kind: "cancel" };
      const summary = feedback.filter(Boolean).join("; ") || NO_DETAIL_FAILURE;
      // Phase 5: a budget stop is terminal, never replanned.
      if (summaryHasBudgetFailure(summary)) return { kind: "budget_exhausted", reason: budgetReasonFromSummary(summary) };
      const held = findProviderHoldMessage(feedback);
      if (held) return { kind: "fail", message: held, cause: "provider_hold" };
      const files = noOpFiles(facts);
      if (files) return { kind: "already_done", files };
      // A verify-fix loop that could change nothing ends here (live test 4).
      if (facts.terminalFailure) return { kind: "fail", message: facts.terminalFailure, cause: "terminal_failure" };
      if (canReplan) return { kind: "replan", reason: summary, eventFeedback: summary, timedOutFrom: summary };
      return { kind: "fail", message: summary, cause: "exhausted" };
    }
  }
}

function noOpFiles(facts: ReplanFacts): string[] | null {
  return alreadyDoneFiles({
    feedback: facts.feedback ?? [],
    fileChanges: facts.fileChanges ?? { size: 0 },
    terminalFailure: facts.terminalFailure,
  });
}

// ---------------------------------------------------------------------------
// The trigger facts, moved from services/runner/terminal.ts (which
// re-exports them) so the decision and its signals live in one place.
// ---------------------------------------------------------------------------

/**
 * Whether a failure SUMMARY carries a budget stop. Failure summaries
 * are the per-subtask feedback entries joined with "; ", each entry
 * prefixed with its subtask key ("s3 (attempt 1): Budget exhausted:
 * ..."), so the raw summary never STARTS with the prefix — the
 * recognition scans for it at any entry boundary (Phase 5).
 */
export function summaryHasBudgetFailure(summary: string): boolean {
  return summary
    .split("; ")
    .some((entry) => entry.includes("Budget exhausted:"));
}

/** The budget reason carried by a failure summary (prefix stripped). */
export function budgetReasonFromSummary(summary: string): string {
  const entry = summary
    .split("; ")
    .find((candidate) => candidate.includes("Budget exhausted:"));
  if (!entry) return summary;
  return entry.slice(entry.indexOf("Budget exhausted: ") + "Budget exhausted: ".length);
}

/**
 * O3 bug c: the provider error behind a replan, when there is one. A 429
 * (or an offline / out-of-quota / refused provider) on a subtask reaches
 * the decision step as a failed node, the engine asks for a replan, and
 * the replan is rejected as a repeat of the same node, so the task FAILED
 * instead of being held. The replan feedback and the run's feedback list
 * are checked here; the first provider failure found is returned as the
 * original provider message (the `node:` / `node (attempt n):` prefix the
 * runner adds is dropped) so the caller routes it to the hold path.
 */
export function findProviderHoldMessage(texts: ReadonlyArray<string | null | undefined>): string | null {
  for (const text of texts) {
    if (!text || !classifyProviderHold(text)) continue;
    const stripped = text.replace(/^[\w.:-]+(?: \(attempt \d+\))?: /, "");
    return classifyProviderHold(stripped) ? stripped : text;
  }
  return null;
}

const NO_EFFECTIVE_CHANGE = /No effective change: (.+?) would be identical to the current content/;
const NO_FILE_CHANGES = /^The implementation produced no file changes$/;

/**
 * A run whose only failures are "No effective change" (every file the
 * executor wrote already had that content) and that staged nothing: the
 * requested change is already in the repository. Replanning would ask for
 * the same edit again and be rejected as a repeat (e2e mock round 2), so
 * the caller ends the task cleanly instead. Returns the files that were
 * already up to date, or null when any other failure is present, a change
 * is staged, or a verify-fix loop set its own terminal failure.
 */
export function alreadyDoneFiles(state: {
  feedback: ReadonlyArray<string>;
  fileChanges: { size: number };
  terminalFailure?: string;
}): string[] | null {
  if (state.terminalFailure || state.fileChanges.size > 0) return null;
  const entries = state.feedback.filter((line) => line && line.trim());
  if (entries.length === 0) return null;
  const files = new Set<string>();
  for (const line of entries) {
    const stripped = line.replace(/^[\w.:-]+(?: \(attempt \d+\))?: /, "");
    const noop = NO_EFFECTIVE_CHANGE.exec(stripped);
    if (noop) {
      for (const file of noop[1].split(",")) if (file.trim()) files.add(file.trim());
      continue;
    }
    if (NO_FILE_CHANGES.test(stripped.trim())) continue;
    return null;
  }
  return files.size > 0 ? [...files] : null;
}
