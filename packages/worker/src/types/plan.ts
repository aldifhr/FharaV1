import type { PlanSubtask } from "./subtask";

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
}

export interface Classification {
  kind: "conversation" | "audit" | "research" | "code_change" | "multi";
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
}

/** One concern of a multi-part change request ("tambah test", "update README"). */
export interface Concern {
  /** Category: theme | refactor | tests | docs | style | change. */
  category: "theme" | "refactor" | "tests" | "docs" | "style" | "change";
  /** The clause of the request this concern came from. */
  text: string;
}
