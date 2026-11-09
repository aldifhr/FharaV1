/** One node of an execution plan and the vocabulary around it. */
import type { AcceptanceGate } from "@/api/convex/lib/subtaskContract";

export type {
  AcceptanceGate,
  Escalation,
  EscalationKind,
  GateResult,
  AcceptanceStatus,
} from "@/api/convex/lib/subtaskContract";

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
  /**
   * Plan 022 contract (scope = allowedPaths). Optional for back-compat:
   * plans that predate it get gates derived from the kind by the validator.
   */
  objective?: string;
  constraints?: string[];
  deliverable?: string;
  acceptance?: AcceptanceGate[];
}

/** Why a subtask was added after planning (persisted as its origin). */
export type DynamicSubtaskOrigin = "delegation" | "fix" | "review_fix";
