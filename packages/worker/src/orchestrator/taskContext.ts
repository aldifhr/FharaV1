import type { Classification } from "@/types";
import type { ReviewFinding } from "../utils/json";
import type {
  AgentResult,
  ExecutionHistoryEntry,
  OutstandingIssue,
  SharedTaskContext,
  TaskArtifact,
  TaskDecision,
} from "@/types/task";

export type {
  DelegationDecision,
  TaskDecisionValue,
  AgentResult,
  ExecutionHistoryEntry,
  TaskDecision,
  TaskArtifact,
  OutstandingIssue,
  SharedTaskContext,
} from "@/types/task";

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

/** True when the issue was raised by QA itself (browser-testing work). */
export function isQaRaisedIssue(issue: OutstandingIssue, qaAgentNames: ReadonlySet<string> = new Set()): boolean {
  if (issue.source === "browser-testing" || issue.source === "qa") return true;
  if (issue.raisedBy && qaAgentNames.has(issue.raisedBy)) return true;
  return /^QA\b/.test(issue.description);
}

/**
 * A QA pass only proves what QA checked (the page renders, no console or
 * network errors). It therefore resolves ONLY issues QA itself raised —
 * never reviewer findings such as security or logic bugs, even when
 * their files were applied. A QA-raised issue resolves when its related
 * files are covered by applied work (or it has none: the re-run passed).
 */
export function resolveIssuesForQaPass(
  issues: OutstandingIssue[],
  approvedFiles: ReadonlySet<string>,
  opts: { qaAgentNames?: ReadonlySet<string> } = {}
): OutstandingIssue[] {
  return issues.map((issue) => {
    if (issue.status !== "open") return issue;
    if (!isQaRaisedIssue(issue, opts.qaAgentNames)) return issue;
    if (issue.relatedFiles && issue.relatedFiles.length > 0) {
      return issue.relatedFiles.every((file) => approvedFiles.has(file))
        ? { ...issue, status: "resolved" }
        : issue;
    }
    return { ...issue, status: "resolved" };
  });
}

export function createSharedTaskContext(input: {
  taskId: string;
  projectId: string;
  originalRequest: string;
  title: string;
  classification: Classification;
  objective?: string;
  instructions?: string;
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
    instructions: input.instructions,
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
        source: result.capability,
        relatedFiles: finding.filePath ? [finding.filePath] : undefined,
      });
    }
  }

  return { decisions, artifacts, issues };
}
