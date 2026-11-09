/** One node of an execution plan and the vocabulary around it. */

export type SubtaskKind =
  | "analysis"
  | "code_change"
  | "review"
  | "qa"
  | "research"
  | "audit"
  | "shell";

export interface PlanSubtask {
  key: string;
  title: string;
  description: string;
  kind: SubtaskKind;
  capability: string;
  dependencies: string[];
  order: number;
  allowedPaths?: string[];
  origin?: "planned" | "dynamic";
  /** Review/QA round (1-based). UI composes "Review (round N)" from this, title stays stable. */
  reviewRound?: number;
}

/** Why a subtask was added after planning (persisted as its origin). */
export type DynamicSubtaskOrigin = "delegation" | "fix" | "review_fix";
