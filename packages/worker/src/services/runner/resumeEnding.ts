import { decideReplan, failureKindForEnding, type FailureKind, type ReplanDecision } from "@/orchestrator/decisionEngine";
import type { BudgetTracker } from "@/orchestrator/budget";
import type { WorkerProject, WorkerTask } from "@/workerApi";
import type { RunnerDeps, RunState } from "./types";
import { failTaskWithError, finishAlreadyDone, finishBudgetExhaustedTask, finishCancelledTask } from "./terminal";

/**
 * Fixall: how a resumed (post-approval) run ends when executePlan returned
 * "replan" or "failed". The decision is the Decision Engine's ONE replan
 * decision (decideReplan), so a resumed task decides exactly like a fresh
 * one: provider hold, budget stop, cancellation, no-op and failure messages
 * are the same. resumeTask has no re-plan loop (the replans budget is
 * processTask's), so it asks with no replan left.
 */
export function decideResumeEnding(input: {
  status: "replan" | "failed";
  replanFeedback?: string;
  state: Pick<RunState, "feedback" | "fileChanges" | "terminalFailure">;
  aborted: boolean;
}): ReplanDecision {
  const { state } = input;
  return decideReplan({
    kind: "replan_trigger",
    trigger: input.status === "replan" ? "objective_unmet" : "terminal_failure",
    reason: input.status === "replan" ? input.replanFeedback : undefined,
    facts: {
      replansLeft: 0,
      replans: 0,
      feedback: state.feedback,
      fileChanges: state.fileChanges,
      terminalFailure: state.terminalFailure,
      aborted: input.aborted,
    },
  });
}

/** Perform the resumed run's ending (the side effects of `decideResumeEnding`). */
export async function endResumedRun(input: {
  deps: RunnerDeps;
  task: WorkerTask;
  project: WorkerProject;
  budget: BudgetTracker;
  state: RunState;
  status: "replan" | "failed";
  replanFeedback?: string;
  signal: AbortSignal;
  /** Item 7: the failure kind executePlan's terminal exit reported. */
  failureKind?: FailureKind;
}): Promise<void> {
  const { deps, task, project, signal } = input;
  const next = decideResumeEnding({ ...input, aborted: signal.aborted });
  // The failed path never recorded a lifecycle transition on resume (its
  // RUNNING was recorded by the run before the approval); kept as it was.
  const lifecycle = input.status === "failed" ? false : undefined;
  switch (next.kind) {
    case "cancel":
      await finishCancelledTask({ deps, task, project, signal });
      return;
    case "budget_exhausted":
      await finishBudgetExhaustedTask({ deps, task, project, budget: input.budget, reason: next.reason });
      return;
    case "already_done":
      await finishAlreadyDone({ deps, taskId: task._id, projectId: project._id, files: next.files, lifecycle });
      return;
    case "fail":
    case "block":
      await failTaskWithError({
        deps,
        taskId: task._id,
        projectId: project._id,
        message: next.message,
        lifecycle,
        failureKind: failureKindForEnding({ trigger: input.status === "replan" ? "objective_unmet" : "terminal_failure", executeKind: input.failureKind }),
      });
      return;
    case "replan":
    case "proceed":
      // Unreachable with no replan left; never end silently.
      await failTaskWithError({
        deps,
        taskId: task._id,
        projectId: project._id,
        message: next.kind === "replan" ? next.reason : "Execution failed after approval",
        lifecycle,
      });
      return;
  }
}
