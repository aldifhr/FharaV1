import type { AgentLLMConfig } from "../llm";

export const CAPABILITY = {
  FRONTEND: "frontend-development",
  BACKEND: "backend-development",
  BROWSER_TESTING: "browser-testing",
  CODE_REVIEW: "code-review",
  ARCHITECTURE: "architecture",
  SECURITY: "security-audit",
  RESEARCH: "research",
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

export interface AgentDefinition extends AgentLLMConfig {
  _id: string;
  name: string;
  role: string;
  systemPrompt?: string;
  description?: string;
  capabilities?: string[];
  supportedTools?: string[];
  isEnabled?: boolean;
  priority?: number;
  maxConcurrency?: number;
  status?: string;
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
