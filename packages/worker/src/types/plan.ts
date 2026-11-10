import type { PlanSubtask } from "./subtask";
import type { Requirement } from "@/api/convex/lib/requirements";

export type { Requirement } from "@/api/convex/lib/requirements";

export const CAPABILITY = {
  COORDINATION: "project-coordination",
  ARCHITECTURE: "architecture",
  DESIGN: "ui-ux-design",
  FRONTEND: "frontend-development",
  BACKEND: "backend-development",
  BROWSER_TESTING: "browser-testing",
  CODE_REVIEW: "code-review",
  SECURITY: "security-audit",
  GROWTH: "growth-marketing",
  DOCUMENTATION: "documentation-support",
  RESEARCH: "research",
  WEB_BROWSING: "web-browsing",
  GITHUB: "github",
  SHELL_EXECUTION: "shell-execution",
  GENERAL: "general",
} as const;

export type Capability = (typeof CAPABILITY)[keyof typeof CAPABILITY];

export interface ExecutionPlan {
  version: 1;
  goal: string;
  strategy: "direct" | "single" | "dag";
  requiresApproval: boolean;
  maxConcurrency: number;
  subtasks: PlanSubtask[];
  /**
   * Plan-level visual-QA intent. Decided once at planning time and consumed
   * by the executor, so planning and execution can never disagree about
   * whether screenshots/baselines/viewports are wanted. Absent on plans
   * persisted before plan 011 — the executor then falls back to its legacy
   * command heuristic.
   */
  visualQa?: boolean;
  /** Planner output only: why nodes were removed in a replan (stripped before persist). */
  replanRemovals?: Array<{ key: string; reasoning: string }>;
  /** Set on a replanned version: the diff, scope and reasoning (Replan Intelligence). */
  replan?: ReplanRecord;
  /**
   * Plan 025: the requirements extracted from the user's request at plan
   * time (LLM, with a deterministic fallback). Subtasks map to them by
   * `requirementIds`; the coverage check before "done" reads them.
   */
  requirements?: Requirement[];
}

export interface Classification {
  kind: "conversation" | "audit" | "research" | "code_change" | "multi" | "command";
  strategy: ExecutionPlan["strategy"];
  reasons: string[];
  suggestedCapabilities: string[];
  /**
   * Size of the requested change (code_change/multi only): low = one
   * focused concern, medium = two, high = three or a risky/multi-domain
   * change, ultra = four or more concerns. Drives the subtask timeout,
   * per-concern planning and the review hint.
   */
  complexity?: "low" | "medium" | "high" | "ultra";
  /** The separate concerns of a change request, in request order. */
  concerns?: Concern[];
  /**
   * kind "command" only: the allowlisted command lines the user asked to run
   * ("npm run test"), in request order. Each becomes one shell subtask.
   */
  commands?: string[];
  /**
   * kind "research" only: a vague bug hunt ("cari bug", "find bugs") with no
   * symptom. Planned as a read-only Reviewer investigation (code-review)
   * that reports findings: no code_change, no browser QA.
   */
  investigation?: boolean;
}

/** One concern of a multi-part change request ("tambah test", "update README"). */
export interface Concern {
  /** Category: theme | refactor | tests | docs | style | change. */
  category: "theme" | "refactor" | "tests" | "docs" | "style" | "change";
  /** The clause of the request this concern came from. */
  text: string;
}

/* Replan Intelligence records (built by orchestrator/replanIntelligence). */

export interface ReplanDiffEntry {
  key: string;
  title: string;
  kind: string;
  capability: string;
  /** Changed fields (modified only). */
  fields?: string[];
  /** The planner's Replan Reasoning for this change (added / modified / removed). */
  reasoning?: string;
  /** Frozen completed node (preserved, never re-run). */
  frozen?: boolean;
  /** The planner rewrote a frozen node; the guard restored it. */
  restored?: boolean;
  /** Changed although it was neither failed nor downstream of a failure. */
  outsideImpact?: boolean;
}

export interface ReplanDiff {
  added: ReplanDiffEntry[];
  removed: ReplanDiffEntry[];
  modified: ReplanDiffEntry[];
  preserved: ReplanDiffEntry[];
}

/** What one accepted replan stored on its plan version (payload.replan). */
export interface ReplanRecord {
  fromVersion: number;
  toVersion: number;
  reason: string;
  failedKeys: string[];
  impactKeys: string[];
  frozenKeys: string[];
  restoredKeys: string[];
  diff: ReplanDiff;
  /** Planner calls this replan took (1, or 2 after a quality reject). */
  attempts: number;
  /** Messages of the violations that made an earlier attempt retry. */
  rejected: string[];
  /** Changed nodes that still had no reasoning after the retry. */
  reasoningMissing: string[];
}

