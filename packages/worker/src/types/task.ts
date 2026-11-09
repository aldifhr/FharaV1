import type { ReviewFinding } from "@/utils/json";
import type { Classification } from "./plan";

export interface TaskContext {
  taskId: string;
  projectId: string;
  workspacePath: string;
  command: string;
  title: string;
  planVersion?: number;
  replanCount?: number;
}

export type DelegationDecision = "APPROVE" | "REJECT" | "REVISE" | "COMPLETE" | "BLOCKED";

/**
 * Plan 005 Phase 4 Step 4.2: the decision trail must show the engine's
 * actions too, not only the evaluation layer's. `TaskDecision.decision`
 * therefore carries either vocabulary; replan feedback
 * (`buildReplanFeedback`) prints it verbatim.
 */
export type TaskDecisionValue =
  | DelegationDecision
  | "execute"
  | "delegate"
  | "call_agent"
  | "parallel"
  | "replan"
  | "complete"
  | "ask_user"
  | "user_answer";

export interface AgentResult {
  agentId?: string;
  agentName: string;
  capability: string;
  success: boolean;
  summary: string;
  findings?: ReviewFinding[];
  delegationRecommendation?: {
    targetCapability: string;
    reason: string;
    priority?: "high" | "medium" | "low";
  };
  output?: string;
  meta?: Record<string, unknown>;
}

export interface ExecutionHistoryEntry {
  executionId?: string;
  agentId?: string;
  agentName: string;
  capability: string;
  subtaskKey: string;
  title: string;
  status: "COMPLETED" | "FAILED" | "SKIPPED" | "RUNNING" | "PENDING";
  summary?: string;
  findings?: ReviewFinding[];
  startedAt?: number;
  completedAt?: number;
  attempt?: number;
}

export interface TaskDecision {
  decision: TaskDecisionValue;
  reason: string;
  capability?: string;
  fromAgent?: string;
  toAgent?: string;
  createdAt: number;
  /** Engine payload (plan 005 Phase 4 Step 4.2): id/action/target/decidedBy/planVersion/step. */
  id?: string;
  target?: { agentId?: string; capability?: string };
  decidedBy?: "deterministic" | "llm";
  planVersion?: number;
  step?: number;
  /** For `user_answer`: the backend taskInputs row it came from (delivery ack). */
  inputId?: string;
}

export interface TaskArtifact {
  kind: string;
  path?: string;
  summary: string;
  executionId?: string;
}

export interface OutstandingIssue {
  id: string;
  description: string;
  severity: "critical" | "high" | "medium" | "low";
  status: "open" | "resolved" | "ignored";
  raisedBy?: string;
  /** Capability of the subtask that raised the issue (e.g. "browser-testing" for QA). */
  source?: string;
  relatedFiles?: string[];
}

export interface SharedTaskContext {
  taskId: string;
  projectId: string;
  originalRequest: string;
  objective: string;
  title: string;
  classification: Classification;
  status: string;
  /** Plan 015: durable shared instructions from the project record. */
  instructions?: string;
  decisions: TaskDecision[];
  agentExecutions: ExecutionHistoryEntry[];
  artifacts: TaskArtifact[];
  outstandingIssues: OutstandingIssue[];
  fileChanges?: string[];
  updatedAt: number;
}
