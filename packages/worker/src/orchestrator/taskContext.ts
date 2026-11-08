import type { AgentDefinition, Classification } from "./types";
import { classifyCommand } from "./classifier";
import { routeCapability, capabilitiesOf, isAgentEnabled } from "./capabilities";
import type { ReviewFinding } from "../utils/json";

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

/**
 * Issue lifecycle (plan 013 step 2): issues resolve only when later
 * APPROVED work actually covers them — never silently. Conservative
 * matching:
 * - an issue WITH relatedFiles resolves once every related file is in
 *   the approved-applied evidence set;
 * - an issue WITHOUT relatedFiles resolves only on an approving review
 *   by the same agent that raised it (same capability domain);
 * - "ignored" is user-driven and never written here.
 * Open critical/high issues therefore stay open (and block completion)
 * until real work covers them — recovery cannot loop forever.
 */
export function resolveIssuesForApproval(
  issues: OutstandingIssue[],
  opts: { approvedFiles: ReadonlySet<string>; approvingAgent?: string }
): OutstandingIssue[] {
  return issues.map((issue) => {
    if (issue.status !== "open") return issue;
    if (issue.relatedFiles && issue.relatedFiles.length > 0) {
      return issue.relatedFiles.every((file) => opts.approvedFiles.has(file))
        ? { ...issue, status: "resolved" }
        : issue;
    }
    if (opts.approvingAgent && issue.raisedBy === opts.approvingAgent) {
      return { ...issue, status: "resolved" };
    }
    return issue;
  });
}

/** A planned QA pass resolves issues whose relatedFiles are all covered
 *  by applied, already-approved work. */
export function resolveIssuesForQaPass(
  issues: OutstandingIssue[],
  approvedFiles: ReadonlySet<string>
): OutstandingIssue[] {
  return issues.map((issue) => {
    if (issue.status !== "open") return issue;
    if (issue.relatedFiles && issue.relatedFiles.length > 0) {
      return issue.relatedFiles.every((file) => approvedFiles.has(file))
        ? { ...issue, status: "resolved" }
        : issue;
    }
    return issue;
  });
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

/**
 * Normalize raw findings from an execution `meta` payload into structured
 * ReviewFindings. Reviewers already emit structured findings; code-change
 * and read-only agents emit plain strings via parseDelegation, which become
 * medium-severity findings with the string as the description.
 */
export function normalizeFindings(raw: unknown): ReviewFinding[] {
  if (!Array.isArray(raw)) return [];
  const findings: ReviewFinding[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      findings.push({ severity: "medium", filePath: "", description: item, suggestion: "" });
    } else if (
      item &&
      typeof item === "object" &&
      typeof (item as ReviewFinding).description === "string"
    ) {
      const f = item as ReviewFinding;
      findings.push({
        severity: f.severity ?? "medium",
        filePath: f.filePath ?? "",
        description: f.description,
        suggestion: f.suggestion ?? "",
      });
    }
  }
  return findings;
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
        description: finding.description,
        severity: finding.severity,
        status: "open",
        raisedBy: result.agentName,
        relatedFiles: finding.filePath ? [finding.filePath] : undefined,
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
