/**
 * Thrown by the pre-call budget gate (BudgetTracker.assertLlmCallAllowed)
 * in "enforce" mode when the task's LLM call or token budget is already
 * spent. Typed so the executor can convert it into a budget-exhausted
 * subtask outcome and the runner can end the task with an explicit
 * budget.exhausted status instead of a generic failure (spec §7).
 */
export class BudgetExhaustedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Budget exhausted: ${reason}`);
    this.name = "BudgetExhaustedError";
    this.reason = reason;
  }
}

export function isBudgetExhaustedError(error: unknown): error is BudgetExhaustedError {
  return error instanceof BudgetExhaustedError;
}
