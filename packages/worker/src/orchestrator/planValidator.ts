import type { ExecutionPlan, SubtaskKind } from "@/types";
import {
  findCycle,
  SUBTASK_KINDS as SHARED_SUBTASK_KINDS,
  validatePlan as validateSharedPlan,
  type ValidatePlanOptions,
  validateStoredPlan as validateSharedStoredPlan,
} from "@/api/convex/lib/planValidation";

// The validator itself lives in the shared backend lib
// (apps/api/convex/lib/planValidation.ts) so user plan edits are checked by
// the SAME rules on the backend before they are stored. This module keeps
// the worker's import path and plan types.

export { findCycle };
export { isReadOnlyTaskKind, READ_ONLY_TASK_KINDS, type ValidatePlanOptions } from "@/api/convex/lib/planValidation";

export const SUBTASK_KINDS: SubtaskKind[] = SHARED_SUBTASK_KINDS;

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  plan?: ExecutionPlan;
  /** Read-only lock changes (converted / dropped nodes). */
  notes?: string[];
}

/**
 * `options.taskKind` is the task's classification kind: research/question
 * (and conversation) plans are locked read-only — see the shared
 * validator.
 */
export function validatePlan(raw: unknown, maxSubtasks: number, options: ValidatePlanOptions = {}): ValidationResult {
  return validateSharedPlan(raw, maxSubtasks, options);
}

/** See the shared `validateStoredPlan` (planner cap relaxed for runner-added nodes). */
export function validateStoredPlan(raw: unknown, maxSubtasks: number): ValidationResult {
  return validateSharedStoredPlan(raw, maxSubtasks);
}
