import type { AgentDefinition, Classification } from "./types";
import { classifyCommand } from "./classifier";
import { routeCapability, capabilitiesOf, isAgentEnabled } from "./capabilities";

export type DelegationDecision = "APPROVE" | "REJECT" | "REVISE" | "COMPLETE" | "BLOCKED";

export interface AgentResult {
  agentId?: string;
  agentName: string;
  capability: string;
  success: boolean;
  summary: string;
  findings?: string[];
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
  findings?: string[];
  startedAt?: number;
  completedAt?: number;
  attempt?: number;
}

export interface TaskDecision {
  decision: DelegationDecision;
  reason: string;
  capability?: string;
  fromAgent?: string;
  toAgent?: string;
  createdAt: number;
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
  decisions: TaskDecision[];
  agentExecutions: ExecutionHistoryEntry[];
  artifacts: TaskArtifact[];
  outstandingIssues: OutstandingIssue[];
  fileChanges?: string[];
  updatedAt: number;
}

export function createSharedTaskContext(input: {
  taskId: string;
  projectId: string;
  originalRequest: string;
  title: string;
  classification: Classification;
  objective?: string;
  priorExecutions?: ExecutionHistoryEntry[];
}): SharedTaskContext {
  return {
    taskId: input.taskId,
    projectId: input.projectId,
    originalRequest: input.originalRequest,
    objective: input.objective ?? input.originalRequest.slice(0, 500),
    title: input.title,
    classification: input.classification,
    status: "RUNNING",
    decisions: [],
    agentExecutions: input.priorExecutions ?? [],
    artifacts: [],
    outstandingIssues: [],
    fileChanges: [],
    updatedAt: Date.now(),
  };
}

export function appendExecution(
  ctx: SharedTaskContext,
  entry: ExecutionHistoryEntry,
  artifacts?: TaskArtifact[],
  issues?: OutstandingIssue[]
): SharedTaskContext {
  return {
    ...ctx,
    agentExecutions: [...ctx.agentExecutions, entry],
    artifacts: artifacts ? [...ctx.artifacts, ...artifacts] : ctx.artifacts,
    outstandingIssues: issues ? [...ctx.outstandingIssues, ...issues] : ctx.outstandingIssues,
    updatedAt: Date.now(),
  };
}

export function addDecision(
  ctx: SharedTaskContext,
  decision: TaskDecision
): SharedTaskContext {
  return {
    ...ctx,
    decisions: [...ctx.decisions, decision],
    updatedAt: Date.now(),
  };
}

export function extractDecisionsAndArtifactsFromResult(
  result: AgentResult
): { decisions: TaskDecision[]; artifacts: TaskArtifact[]; issues: OutstandingIssue[] } {
  const decisions: TaskDecision[] = [];
  const artifacts: TaskArtifact[] = [];
  const issues: OutstandingIssue[] = [];

  if (result.meta?.filePaths && Array.isArray(result.meta.filePaths)) {
    for (const p of result.meta.filePaths) {
      artifacts.push({ kind: "file_change", path: String(p), summary: result.summary });
    }
  }

  if (result.findings) {
    for (const finding of result.findings) {
      issues.push({
        id: `issue-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        description: finding,
        severity: "medium",
        status: "open",
        raisedBy: result.agentName,
      });
    }
  }

  if (result.delegationRecommendation) {
    decisions.push({
      decision: "APPROVE",
      reason: result.delegationRecommendation.reason,
      capability: result.delegationRecommendation.targetCapability,
      fromAgent: result.agentName,
      createdAt: Date.now(),
    });
  }

  return { decisions, artifacts, issues };
}
