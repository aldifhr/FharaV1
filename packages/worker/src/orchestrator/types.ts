export const CAPABILITY = {
  FRONTEND: "frontend-development",
  BACKEND: "backend-development",
  BROWSER_TESTING: "browser-testing",
  CODE_REVIEW: "code-review",
  ARCHITECTURE: "architecture",
  SECURITY: "security-audit",
  RESEARCH: "research",
  WEB_BROWSING: "web-browsing",
  GITHUB: "github",
  GENERAL: "general",
} as const;

export type Capability = (typeof CAPABILITY)[keyof typeof CAPABILITY];

export type SubtaskKind =
  | "analysis"
  | "code_change"
  | "review"
  | "qa"
  | "research"
  | "audit";

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
}

export interface PlanSubtask {
  key: string;
  title: string;
  description: string;
  kind: SubtaskKind;
  capability: string;
  dependencies: string[];
  order: number;
}

export interface ExecutionPlan {
  version: 1;
  goal: string;
  strategy: "direct" | "single" | "dag";
  requiresApproval: boolean;
  maxConcurrency: number;
  subtasks: PlanSubtask[];
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
