/** Verification / evaluation results shared by execution and the orchestrator. */

export type EvaluationVerdict = "passed" | "failed" | "inconclusive";

export interface EvaluationCheck {
  name: string;
  status: EvaluationVerdict;
  details?: string;
  /** Wall time of the step, when it ran (plan 019 verification card). */
  durationMs?: number;
  /** Test counts parsed from the runner output, when it printed them. */
  counts?: { passed: number; total: number };
}

/** Review verdicts as parsed from the reviewer agent. */
export type { ReviewFinding, ReviewResult } from "@/utils/json";
