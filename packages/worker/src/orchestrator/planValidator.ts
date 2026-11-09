import type { ExecutionPlan, SubtaskKind } from "@/types";
import {
  findCycle,
  SUBTASK_KINDS as SHARED_SUBTASK_KINDS,
  validatePlan as validateSharedPlan,
  validateStoredPlan as validateSharedStoredPlan,
} from "@/api/convex/lib/planValidation";

// The validator itself lives in the shared backend lib
// (apps/api/convex/lib/planValidation.ts) so user plan edits are checked by
// the SAME rules on the backend before they are stored. This module keeps
// the worker's import path and plan types.

export { findCycle };

export const SUBTASK_KINDS: SubtaskKind[] = SHARED_SUBTASK_KINDS;

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  plan?: ExecutionPlan;
}

export function validatePlan(raw: unknown, maxSubtasks: number): ValidationResult {
  return validateSharedPlan(raw, maxSubtasks);
}

/** See the shared `validateStoredPlan` (planner cap relaxed for runner-added nodes). */
export function validateStoredPlan(raw: unknown, maxSubtasks: number): ValidationResult {
  return validateSharedStoredPlan(raw, maxSubtasks);
}
