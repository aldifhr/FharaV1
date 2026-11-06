import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../../apps/api/convex/_generated/api";

export interface WorkerTask {
  _id: string;
  projectId: string;
  title: string;
  command: string;
  status: string;
  planVersion?: number;
  replanCount?: number;
  workerId?: string;
  leaseExpiresAt?: number;
}

export interface WorkerProject {
  _id: string;
  name: string;
  workspacePath: string;
  agentIds?: string[];
  approvalMode?: "ask" | "auto";
}

export interface WorkerAgent {
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
}

export interface WorkerPlanRecord {
  _id: string;
  taskId: string;
  version: number;
  strategy: string;
  createdBy: "orchestrator" | "fallback";
  goal: string;
  payload: any;
  createdAt: number;
}

export interface WorkerSubtask {
  _id: string;
  key: string;
  title: string;
  description: string;
  kind: string;
  capability: string;
  dependencies: string[];
  order: number;
  status: string;
  assignedAgentId?: string;
  assignedAgentName?: string;
  output?: string;
  error?: string;
  attempts: number;
}

export interface WorkerFileChange {
  _id: string;
  taskId: string;
  filePath: string;
  changeType: "new" | "modified" | "deleted";
  oldContent?: string;
  newContent?: string;
  oldContentHash?: string;
  newContentHash?: string;
  diff: string;
  appliedAt?: number;
  appliedByWorkerId?: string;
}

export interface WorkerApproval {
  _id: string;
  taskId: string;
  kind: "apply_changes" | "git_push" | "run_command" | "merge_pr";
  summary: string;
  status: "pending" | "approved" | "rejected";
  subtaskKey?: string;
  planVersion?: number;
  payload?: any;
}

export interface RunContextData {
  task: WorkerTask;
  project: WorkerProject | null;
  agents: WorkerAgent[];
  plan: WorkerPlanRecord | null;
  subtasks: WorkerSubtask[];
  approvalMode: "ask" | "auto";
  llmProviders?: Array<{
    _id: string;
    name: string;
    provider: string;
    model: string;
    baseUrl: string;
    apiKeyEnv: string;
    apiKey?: string;
    priority: number;
  }>;
}

export class WorkerApi {
  constructor(
    private readonly client: ConvexHttpClient,
    private readonly token: string
  ) {}

  private args<T extends Record<string, unknown>>(value: T): T & { workerToken: string } {
    return { ...value, workerToken: this.token };
  }

  async claimTask(workerId: string, leaseMs: number): Promise<WorkerTask | null> {
    return (await this.client.action(
      api.worker.claimTask as any,
      this.args({ workerId, leaseMs })
    )) as WorkerTask | null;
  }

  async heartbeat(input: {
    workerId: string;
    hostname?: string;
    capacity: number;
    activeTasks: number;
    leaseMs: number;
  }): Promise<{ now: number }> {
    return (await this.client.action(api.worker.heartbeat as any, this.args(input))) as {
      now: number;
    };
  }

  async markOffline(workerId: string): Promise<void> {
    await this.client.action(api.worker.markOffline as any, this.args({ workerId }));
  }

  async recover(staleGraceMs: number): Promise<{ recoveredTasks: number; recoveredExecutions: number }> {
    return (await this.client.action(api.worker.recover as any, this.args({ staleGraceMs }))) as {
      recoveredTasks: number;
      recoveredExecutions: number;
    };
  }

  async getContext(taskId: string): Promise<RunContextData | null> {
    return (await this.client.action(
      api.worker.getContext as any,
      this.args({ taskId })
    )) as RunContextData | null;
  }

  async setPlanning(input: {
    taskId: string;
    classification: string;
    strategy: string;
    planVersion: number;
  }): Promise<void> {
    await this.client.action(api.worker.setPlanning as any, this.args(input));
  }

  async savePlan(input: {
    taskId: string;
    projectId: string;
    version: number;
    strategy: string;
    createdBy: "orchestrator" | "fallback";
    goal: string;
    payload: unknown;
    subtasks: Array<{
      key: string;
      title: string;
      description: string;
      kind: string;
      capability: string;
      dependencies: string[];
      order: number;
    }>;
  }): Promise<number> {
    return (await this.client.action(api.worker.savePlan as any, this.args(input))) as number;
  }

  async startExecution(input: {
    taskId: string;
    projectId: string;
    subtaskKey: string;
    agentId?: string;
    agentName: string;
    capability: string;
    workerId: string;
    attempt: number;
    leaseMs: number;
  }): Promise<string> {
    return (await this.client.action(
      api.worker.startExecution as any,
      this.args(input)
    )) as string;
  }

  async updateExecution(input: {
    executionId: string;
    subtaskKey?: string;
    status: "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";
    output?: string;
    error?: string;
    meta?: unknown;
    leaseMs?: number;
  }): Promise<void> {
    await this.client.action(api.worker.updateExecution as any, this.args(input));
  }

  async updateSubtask(input: {
    taskId: string;
    key: string;
    status:
      | "pending"
      | "ready"
      | "running"
      | "waiting_approval"
      | "completed"
      | "failed"
      | "blocked"
      | "skipped";
    output?: string;
    error?: string;
    agentId?: string;
    agentName?: string;
  }): Promise<boolean> {
    return (await this.client.action(
      api.worker.updateSubtask as any,
      this.args(input)
    )) as boolean;
  }

  async requestApproval(input: {
    taskId: string;
    projectId: string;
    executionId?: string;
    subtaskKey?: string;
    kind: "apply_changes" | "git_push" | "run_command" | "merge_pr";
    summary: string;
    payload?: unknown;
    requestedByAgentId?: string;
    planVersion?: number;
  }): Promise<string> {
    return (await this.client.action(
      api.worker.requestApproval as any,
      this.args(input)
    )) as string;
  }

  async getResumable(): Promise<
    Array<{ task: WorkerTask; pendingCount: number; approvals: WorkerApproval[] }>
  > {
    return (await this.client.action(api.worker.getResumable as any, this.args({}))) as Array<{
      task: WorkerTask;
      pendingCount: number;
      approvals: WorkerApproval[];
    }>;
  }

  async getApprovals(taskId: string): Promise<WorkerApproval[]> {
    return (await this.client.action(
      api.worker.getApprovals as any,
      this.args({ taskId })
    )) as WorkerApproval[];
  }

  async getFileChanges(taskId: string): Promise<WorkerFileChange[]> {
    return (await this.client.action(
      api.worker.getFileChanges as any,
      this.args({ taskId })
    )) as WorkerFileChange[];
  }

  async saveFileChange(input: {
    taskId: string;
    projectId: string;
    filePath: string;
    changeType: "new" | "modified" | "deleted";
    oldContent?: string;
    newContent?: string;
    oldContentHash?: string;
    newContentHash?: string;
    diff: string;
    subtaskKey?: string;
    executionId?: string;
  }): Promise<string> {
    return (await this.client.action(
      api.worker.saveFileChange as any,
      this.args(input)
    )) as string;
  }

  async markFilesApplied(taskId: string, filePaths: string[], workerId: string): Promise<void> {
    await this.client.action(
      api.worker.markFilesApplied as any,
      this.args({ taskId, filePaths, workerId })
    );
  }

  async completeTask(
    taskId: string,
    status: "done" | "failed" | "rejected",
    errorMessage?: string
  ): Promise<void> {
    await this.client.action(
      api.worker.completeTask as any,
      this.args({ taskId, status, errorMessage })
    );
  }

  async recordEvaluation(input: {
    taskId: string;
    projectId: string;
    planVersion: number;
    verdict: "passed" | "failed" | "inconclusive";
    checks: unknown;
    notes?: string;
  }): Promise<void> {
    await this.client.action(api.worker.recordEvaluation as any, this.args(input));
  }

  async logEvent(input: {
    taskId: string;
    projectId: string;
    type: string;
    payload?: unknown;
    executionId?: string;
    subtaskKey?: string;
    level?: "info" | "warn" | "error";
  }): Promise<void> {
    await this.client.action(api.worker.logEvent as any, this.args(input));
  }

  async appendAgentMessage(input: {
    projectId: string;
    taskId: string;
    agentId?: string;
    content: string;
    subtaskKey?: string;
    executionId?: string;
  }): Promise<void> {
    await this.client.action(api.worker.appendAgentMessage as any, this.args(input));
  }

  async recordAudit(input: {
    taskId?: string;
    projectId?: string;
    executionId?: string;
    workerId?: string;
    actor: string;
    tool: string;
    action: string;
    decision: "allowed" | "denied" | "pending" | "recorded";
    target?: string;
    details?: unknown;
  }): Promise<void> {
    await this.client.action(api.worker.recordAudit as any, this.args(input));
  }

  async recordTokenUsage(input: {
    projectId: string;
    taskId?: string;
    agentId?: string;
    agentName: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  }): Promise<void> {
    await this.client.action(api.worker.recordTokenUsage as any, this.args(input));
  }

  async createBranch(input: {
    taskId: string;
    projectId: string;
  }): Promise<{ branchName: string; worktreePath: string }> {
    return (await this.client.action(api.worker.createBranch as any, this.args(input))) as {
      branchName: string;
      worktreePath: string;
    };
  }

  async mergeBranch(input: { taskId: string }): Promise<{ success: boolean }> {
    return (await this.client.action(api.worker.mergeBranch as any, this.args(input))) as {
      success: boolean;
    };
  }

  async discardBranch(input: { taskId: string }): Promise<void> {
    await this.client.action(api.worker.discardBranch as any, this.args(input));
  }

  async getTaskContext(taskId: string): Promise<any> {
    return (await this.client.action(api.worker.getTaskContext as any, this.args({ taskId }))) as any;
  }

  async upsertTaskContext(input: {
    taskId: string;
    projectId: string;
    originalRequest: string;
    objective: string;
    status: "queued" | "running" | "needs_approval" | "done" | "rejected" | "failed";
    decisions: unknown[];
    artifacts: unknown[];
    outstandingIssues: unknown[];
  }): Promise<any> {
    return (await this.client.action(api.worker.upsertTaskContext as any, this.args(input))) as any;
  }

  async recordDelegation(input: {
    taskId: string;
    projectId: string;
    fromAgentId?: string;
    toAgentId?: string;
    decision: "APPROVE" | "REJECT" | "REVISE" | "COMPLETE" | "BLOCKED";
    reason?: string;
    capability?: string;
  }): Promise<any> {
    return (await this.client.action(api.worker.recordDelegation as any, this.args(input))) as any;
  }

  async recordLifecycle(input: { taskId: string; projectId: string; state: string; prevState?: string }): Promise<void> {
    await this.client.action(api.worker.recordLifecycle as any, this.args(input));
  }

  async getTaskTokenUsage(taskId: string): Promise<{ calls: number; inputTokens: number; outputTokens: number }> {
    return (await this.client.action(api.worker.getTaskTokenUsage as any, this.args({ taskId }))) as { calls: number; inputTokens: number; outputTokens: number };
  }
}
