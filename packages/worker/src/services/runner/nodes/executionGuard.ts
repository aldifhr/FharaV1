import type { RunContext } from "../types";

/**
 * Deadline, cancellation and budget checks of the DAG nodes runner: the
 * scheduler's halt / cancel / retry vetoes. Part of `runNodes` (split out
 * with no behaviour change); retry DECISIONS stay in decisionEngine/retry.
 */

/** Plan 022: a user pause stops new dispatch; running nodes finish. */
export function shouldHaltNewNodes(ctx: RunContext): boolean {
  return ctx.budgetHalt || ctx.stepLimitHit || ctx.decisionTerminal || ctx.paused;
}

/** How long a task-status read is reused before the next poll. */
const STATUS_POLL_MS = 1500;

/** The scheduler's cancel check: the task deadline / abort signal, then a throttled status poll. */
export function createCancelCheck(ctx: RunContext): () => Promise<boolean> {
  const { deps, input, taskId } = ctx;
  return async () => {
    // The task deadline fired the shared abort controller (or a
    // cancel already propagated): the task is cancelled NOW. This
    // check bypasses the status-poll throttle below so a deadline
    // is honored within one scheduler pass, not up to 1.5s later.
    if (input.taskAbort?.signal.aborted) {
      ctx.cancelled = true;
      return true;
    }
    const now = Date.now();
    if (now - ctx.lastStatusCheck < STATUS_POLL_MS) return ctx.cancelled;
    ctx.lastStatusCheck = now;
    const current = await deps.api.getContext({ taskId });
    // "cancelled" is the user's Stop (tasks.cancel); it was missing here, so a stop never aborted running nodes.
    ctx.cancelled = !current || ["failed", "done", "rejected", "cancelled"].includes(current.task.status);
    // Plan 022: paused is not cancelled — it only halts new dispatch.
    // A resume that lands while this run drains does not un-halt it;
    // the run ends at its boundary and the release re-queues it.
    if (current?.task.status === "paused") ctx.paused = true;
    if (ctx.cancelled) {
      // Propagate beyond this scheduler: in-flight LLM calls, QA
      // and verification observe the same per-task signal.
      input.taskAbort?.abort();
    }
    return ctx.cancelled;
  };
}

/**
 * Retries respect the task's bounds (Phase 4): no retry once the
 * deadline/cancel has fired, and no retry the LLM call budget cannot pay
 * for. (The permanent/transient classification runs before this veto.)
 */
export function retryAllowed(input: Pick<RunContext["input"], "taskAbort" | "budget">): boolean {
  if (input.taskAbort?.signal.aborted) return false;
  // A retry re-runs the node and spends another LLM call: veto it
  // whenever the budget gate would stop that call (Phase 5 — in
  // warn mode the gate does not throw, so the check is made on
  // the tracker's LLM exhaustion state directly).
  if (input.budget && input.budget.isLlmBudgetExhausted().exhausted) return false;
  return true;
}

/**
 * A node blocked while the budget halt is latched (Phase 5): the budget
 * failure line for the run feedback, so the runner ends the task as
 * budget.exhausted — a halted node never reaches the pre-call gate.
 */
export function budgetHaltFeedback(ctx: Pick<RunContext, "budgetHalt" | "input">, nodeKey: string): string | undefined {
  if (!ctx.budgetHalt || !ctx.input.budget) return undefined;
  const llmBudget = ctx.input.budget.isLlmBudgetExhausted();
  return llmBudget.exhausted ? `${nodeKey}: Budget exhausted: ${llmBudget.reason}` : undefined;
}
