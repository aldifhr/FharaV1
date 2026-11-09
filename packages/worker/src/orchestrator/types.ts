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

export type SubtaskKind =
  | "analysis"
  | "code_change"
  | "review"
  | "qa"
  | "research"
  | "audit"
  | "shell";

export interface AgentDefinition {
  _id: string;
  name: string;
  role: string;
  systemPrompt?: string;
  description?: string;
  capabilities?: string[];
  skills?: string[];
  supportedTools?: string[];
  isEnabled?: boolean;
  priority?: number;
  maxConcurrency?: number;
  status?: string;
  // LLM assignment (Phase 2 resolver): optional per-agent provider/model
  // preference + fallback + selection policy, independent of identity/role.
  llmProviderId?: string;
  llmModelId?: string;
  llmFallbackProviderId?: string;
  llmFallbackModelId?: string;
  llmSelectionPolicy?: "fixed" | "priority" | "weighted";
  // Execution runtime override: "api" (host tools + gated LLM) or
  // "opencode" (OpenCode CLI with native tools in the task worktree).
  // Unset = global ORCHESTRATOR_EXECUTION_RUNTIME default.
  executionRuntime?: "api" | "opencode";
  /** Optional OpenCode model (`provider/model`); unset = MOAgent's own LLM. */
  opencodeModel?: string;
}

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
}

export interface TaskContext {
  taskId: string;
  projectId: string;
  workspacePath: string;
  command: string;
  title: string;
  planVersion?: number;
  replanCount?: number;
}

export type AgentStatus = "idle" | "working" | "queued" | "needs_you";
