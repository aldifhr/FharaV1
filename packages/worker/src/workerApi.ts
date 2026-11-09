import type { ConvexHttpClient } from "convex/browser";
import { api } from "@/api/convex/_generated/api";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import type { Doc } from "@/api/convex/_generated/dataModel";
import type { PromptSkill } from "@/api/convex/lib/skills";

/** Convex document shapes returned by the worker API. */
export type WorkerTask = Doc<"tasks">;
export type WorkerProject = Doc<"projects">;
export type WorkerAgent = Doc<"agents">;
/**
 * Agent row as getRunContext delivers it: plus its attached library skills
 * and its pre-rendered "## Memory" section (pinned memories, capped).
 */
export type WorkerRunAgent = WorkerAgent & { attachedSkills?: PromptSkill[]; memorySection?: string };
export type WorkerPlanRecord = Doc<"plans">;
export type WorkerSubtask = Doc<"subtasks">;
export type WorkerFileChange = Doc<"fileChanges">;
export type WorkerApproval = Doc<"approvals">;

export type WorkerTaskId = WorkerTask["_id"];
export type WorkerProjectId = WorkerProject["_id"];
export type WorkerAgentId = WorkerAgent["_id"];
export type WorkerExecutionId = Doc<"executions">["_id"];

/**
 * Relax Convex branded ID types to allow plain string IDs across the worker boundary.
 */
type RelaxId<T> = T extends string & { __tableName?: any }
  ? string
  : T extends (string & { __tableName?: any }) | undefined
    ? string | undefined
    : T;

type ActionInput<T extends FunctionReference<any, any, any, any>> = {
  [K in keyof Omit<FunctionArgs<T>, "workerToken">]: RelaxId<Omit<FunctionArgs<T>, "workerToken">[K]>;
};

export class WorkerApi {
  constructor(
    private readonly client: ConvexHttpClient,
    private readonly token: string,
    /**
     * Lease owner identity. Fenced writes (completeTask, updateSubtask,
     * saveFileChange) refuse to run when another worker holds the task
     * lease, so a displaced worker cannot interleave with the new owner.
     */
    private readonly workerId?: string
  ) {}

  private args<T extends Record<string, unknown>>(value: T): any {
    return { ...value, workerToken: this.token };
  }

  async syncFixedTeam(): Promise<FunctionReturnType<typeof api.worker.syncFixedTeam>> {
    return await this.client.action(api.worker.syncFixedTeam, this.args({}));
  }

  async claimTask(
    input: ActionInput<typeof api.worker.claimTask>
  ): Promise<FunctionReturnType<typeof api.worker.claimTask>> {
    return await this.client.action(api.worker.claimTask, this.args(input));
  }

  async heartbeat(
    input: ActionInput<typeof api.worker.heartbeat>
  ): Promise<FunctionReturnType<typeof api.worker.heartbeat>> {
    return await this.client.action(api.worker.heartbeat, this.args(input));
  }

  async markOffline(
    input: ActionInput<typeof api.worker.markOffline>
  ): Promise<FunctionReturnType<typeof api.worker.markOffline>> {
    return await this.client.action(api.worker.markOffline, this.args(input));
  }

  async recover(
    input: ActionInput<typeof api.worker.recover>
  ): Promise<FunctionReturnType<typeof api.worker.recover>> {
    return await this.client.action(api.worker.recover, this.args(input));
  }

  async getContext(
    input: ActionInput<typeof api.worker.getContext>
  ): Promise<FunctionReturnType<typeof api.worker.getContext>> {
    return await this.client.action(api.worker.getContext, this.args(input));
  }

  async setPlanning(
    input: ActionInput<typeof api.worker.setPlanning>
  ): Promise<FunctionReturnType<typeof api.worker.setPlanning>> {
    // Lease fencing: the backend refuses the write when another worker
    // holds the task lease ("Lease lost" throw / {applied:false}).
    return await this.client.action(
      api.worker.setPlanning,
      this.args({ workerId: this.workerId, ...input })
    );
  }

  async savePlan(
    input: ActionInput<typeof api.worker.savePlan>
  ): Promise<FunctionReturnType<typeof api.worker.savePlan>> {
    // Lease fencing: the backend refuses the write when another worker
    // holds the task lease ("Lease lost" throw / {applied:false}).
    return await this.client.action(
      api.worker.savePlan,
      this.args({ workerId: this.workerId, ...input })
    );
  }

  async saveDynamicSubtasks(
    input: ActionInput<typeof api.worker.saveDynamicSubtasks>
  ): Promise<FunctionReturnType<typeof api.worker.saveDynamicSubtasks>> {
    // Lease fencing: the backend refuses the write when another worker
    // holds the task lease ("Lease lost" throw / {applied:false}).
    return await this.client.action(
      api.worker.saveDynamicSubtasks,
      this.args({ workerId: this.workerId, ...input })
    );
  }

  async startExecution(
    input: ActionInput<typeof api.worker.startExecution>
  ): Promise<FunctionReturnType<typeof api.worker.startExecution>> {
    return await this.client.action(api.worker.startExecution, this.args(input));
  }

  async updateExecution(
    input: ActionInput<typeof api.worker.updateExecution>
  ): Promise<FunctionReturnType<typeof api.worker.updateExecution>> {
    // Lease fencing: the backend refuses the write when another worker
    // holds the task lease ("Lease lost" throw / {applied:false}).
    return await this.client.action(
      api.worker.updateExecution,
      this.args({ workerId: this.workerId, ...input })
    );
  }

  async updateSubtask(
    input: ActionInput<typeof api.worker.updateSubtask>
  ): Promise<FunctionReturnType<typeof api.worker.updateSubtask>> {
    return await this.client.action(
      api.worker.updateSubtask,
      this.args({ workerId: this.workerId, ...input })
    );
  }

  async setSubtaskActivity(
    input: ActionInput<typeof api.worker.setSubtaskActivity>
  ): Promise<FunctionReturnType<typeof api.worker.setSubtaskActivity>> {
    return await this.client.action(
      api.worker.setSubtaskActivity,
      this.args({ workerId: this.workerId, ...input })
    );
  }

  async setSubtaskLiveOutput(
    input: ActionInput<typeof api.worker.setSubtaskLiveOutput>
  ): Promise<FunctionReturnType<typeof api.worker.setSubtaskLiveOutput>> {
    return await this.client.action(
      api.worker.setSubtaskLiveOutput,
      this.args({ workerId: this.workerId, ...input })
    );
  }

  async requestApproval(
    input: ActionInput<typeof api.worker.requestApproval>
  ): Promise<FunctionReturnType<typeof api.worker.requestApproval>> {
    // Lease fencing: the backend refuses the write when another worker
    // holds the task lease ("Lease lost" throw / {applied:false}).
    return await this.client.action(
      api.worker.requestApproval,
      this.args({ workerId: this.workerId, ...input })
    );
  }

  /** Plan 020: approve automatically under the task's permission mode (backend re-checks). */
  async autoApprove(
    input: ActionInput<typeof api.worker.autoApprove>
  ): Promise<FunctionReturnType<typeof api.worker.autoApprove>> {
    return await this.client.action(
      api.worker.autoApprove,
      this.args({ workerId: this.workerId, ...input })
    );
  }

  /** Plan 015: central broker verdict (Allow/Deny/Ask) for a risky action. */
  async checkPermission(
    input: ActionInput<typeof api.worker.checkPermission>
  ): Promise<FunctionReturnType<typeof api.worker.checkPermission>> {
    return await this.client.action(api.worker.checkPermission, this.args(input));
  }

  async getResumable(): Promise<FunctionReturnType<typeof api.worker.getResumable>> {
    return await this.client.action(api.worker.getResumable, this.args({}));
  }

  async claimResumable(
    input: ActionInput<typeof api.worker.claimResumable>
  ): Promise<FunctionReturnType<typeof api.worker.claimResumable>> {
    return await this.client.action(api.worker.claimResumable, this.args(input));
  }

  async getApprovals(
    input: ActionInput<typeof api.worker.getApprovals>
  ): Promise<WorkerApproval[]> {
    return await this.client.action(api.worker.getApprovals, this.args(input));
  }

  async getFileChanges(
    input: ActionInput<typeof api.worker.getFileChanges>
  ): Promise<WorkerFileChange[]> {
    return await this.client.action(api.worker.getFileChanges, this.args(input));
  }

  async saveFileChange(
    input: ActionInput<typeof api.worker.saveFileChange>
  ): Promise<FunctionReturnType<typeof api.worker.saveFileChange>> {
    return await this.client.action(
      api.worker.saveFileChange,
      this.args({ workerId: this.workerId, ...input })
    );
  }

  async discardFileChange(
    input: ActionInput<typeof api.worker.discardFileChange>
  ): Promise<FunctionReturnType<typeof api.worker.discardFileChange>> {
    return await this.client.action(
      api.worker.discardFileChange,
      this.args({ workerId: this.workerId, ...input })
    );
  }

  async markFilesApplied(
    input: ActionInput<typeof api.worker.markFilesApplied>
  ): Promise<FunctionReturnType<typeof api.worker.markFilesApplied>> {
    return await this.client.action(api.worker.markFilesApplied, this.args(input));
  }

  async completeTask(
    input: ActionInput<typeof api.worker.completeTask>
  ): Promise<FunctionReturnType<typeof api.worker.completeTask>> {
    return await this.client.action(
      api.worker.completeTask,
      this.args({ workerId: this.workerId, ...input })
    );
  }

  /**
   * Transition the task row without ending it. The resume path uses this to
   * leave `needs_approval` once it starts executing again; otherwise the UI
   * keeps saying "needs approval" while the approved run is in flight and
   * there is no pending approval left to show a button for.
   */
  async setTaskStatus(
    input: ActionInput<typeof api.worker.setTaskStatus>
  ): Promise<FunctionReturnType<typeof api.worker.setTaskStatus>> {
    return await this.client.action(api.worker.setTaskStatus, this.args(input));
  }

  // Plan 013 step 4: pause a task for a user answer (`waiting_input`).
  async pauseForInput(
    input: ActionInput<typeof api.worker.pauseForInput>
  ): Promise<FunctionReturnType<typeof api.worker.pauseForInput>> {
    return await this.client.action(api.worker.pauseForInput, this.args(input));
  }

  async recordEvaluation(
    input: ActionInput<typeof api.worker.recordEvaluation>
  ): Promise<FunctionReturnType<typeof api.worker.recordEvaluation>> {
    return await this.client.action(api.worker.recordEvaluation, this.args(input));
  }

  // Plan 009: MCP status reports from the worker (best-effort).
  async updateMcpServerStatus(
    input: ActionInput<typeof api.worker.updateMcpServerStatus>
  ): Promise<FunctionReturnType<typeof api.worker.updateMcpServerStatus>> {
    return await this.client.action(api.worker.updateMcpServerStatus, this.args(input));
  }

  async claimMcpServerTest(
    input: ActionInput<typeof api.worker.claimMcpServerTest>
  ): Promise<FunctionReturnType<typeof api.worker.claimMcpServerTest>> {
    return await this.client.action(api.worker.claimMcpServerTest, this.args(input));
  }

  async claimRepoToolCall(
    input: ActionInput<typeof api.worker.claimRepoToolCall>
  ): Promise<FunctionReturnType<typeof api.worker.claimRepoToolCall>> {
    return await this.client.action(api.worker.claimRepoToolCall, this.args(input));
  }

  async completeRepoToolCall(
    input: ActionInput<typeof api.worker.completeRepoToolCall>
  ): Promise<FunctionReturnType<typeof api.worker.completeRepoToolCall>> {
    return await this.client.action(api.worker.completeRepoToolCall, this.args(input));
  }

  async completeMcpServerTest(
    input: ActionInput<typeof api.worker.completeMcpServerTest>
  ): Promise<FunctionReturnType<typeof api.worker.completeMcpServerTest>> {
    return await this.client.action(api.worker.completeMcpServerTest, this.args(input));
  }

  /** Plan 022: a subtask's acceptance (gate results / escalation). Lease-fenced. */
  async recordSubtaskAcceptance(
    input: ActionInput<typeof api.worker.recordSubtaskAcceptance>
  ): Promise<FunctionReturnType<typeof api.worker.recordSubtaskAcceptance>> {
    return await this.client.action(
      api.worker.recordSubtaskAcceptance,
      this.args({ workerId: this.workerId, ...input })
    );
  }

  /** Plan 022: hand a paused task back after its run drained. */
  async releasePausedTask(
    input: ActionInput<typeof api.worker.releasePausedTask>
  ): Promise<FunctionReturnType<typeof api.worker.releasePausedTask>> {
    return await this.client.action(api.worker.releasePausedTask, this.args(input));
  }

  async logEvent(
    input: ActionInput<typeof api.worker.logEvent>
  ): Promise<FunctionReturnType<typeof api.worker.logEvent>> {
    return await this.client.action(api.worker.logEvent, this.args(input));
  }

  async appendAgentMessage(
    input: ActionInput<typeof api.worker.appendAgentMessage>
  ): Promise<FunctionReturnType<typeof api.worker.appendAgentMessage>> {
    return await this.client.action(api.worker.appendAgentMessage, this.args(input));
  }

  async recordAudit(
    input: ActionInput<typeof api.worker.recordAudit>
  ): Promise<FunctionReturnType<typeof api.worker.recordAudit>> {
    return await this.client.action(api.worker.recordAudit, this.args(input));
  }

  async recordTokenUsage(
    input: ActionInput<typeof api.worker.recordTokenUsage>
  ): Promise<FunctionReturnType<typeof api.worker.recordTokenUsage>> {
    return await this.client.action(api.worker.recordTokenUsage, this.args(input));
  }

  async reportProviderHealth(
    input: ActionInput<typeof api.worker.reportProviderHealth>
  ): Promise<FunctionReturnType<typeof api.worker.reportProviderHealth>> {
    return await this.client.action(api.worker.reportProviderHealth, this.args(input));
  }

  async createBranch(
    input: ActionInput<typeof api.worker.createBranch>
  ): Promise<FunctionReturnType<typeof api.worker.createBranch>> {
    return await this.client.action(api.worker.createBranch, this.args(input));
  }

  async mergeBranch(
    input: ActionInput<typeof api.worker.mergeBranch>
  ): Promise<FunctionReturnType<typeof api.worker.mergeBranch>> {
    return await this.client.action(api.worker.mergeBranch, this.args(input));
  }

  async discardBranch(
    input: ActionInput<typeof api.worker.discardBranch>
  ): Promise<FunctionReturnType<typeof api.worker.discardBranch>> {
    return await this.client.action(api.worker.discardBranch, this.args(input));
  }

  async getTaskContext(
    input: ActionInput<typeof api.worker.getTaskContext>
  ): Promise<FunctionReturnType<typeof api.worker.getTaskContext>> {
    return await this.client.action(api.worker.getTaskContext, this.args(input));
  }

  async listPendingTaskInputs(
    input: ActionInput<typeof api.worker.listPendingTaskInputs>
  ): Promise<FunctionReturnType<typeof api.worker.listPendingTaskInputs>> {
    return await this.client.action(api.worker.listPendingTaskInputs, this.args(input));
  }

  async markTaskInputsDelivered(
    input: ActionInput<typeof api.worker.markTaskInputsDelivered>
  ): Promise<FunctionReturnType<typeof api.worker.markTaskInputsDelivered>> {
    return await this.client.action(api.worker.markTaskInputsDelivered, this.args(input));
  }

  async upsertTaskContext(
    input: ActionInput<typeof api.worker.upsertTaskContext>
  ): Promise<FunctionReturnType<typeof api.worker.upsertTaskContext>> {
    return await this.client.action(api.worker.upsertTaskContext, this.args(input));
  }

  async recordDelegation(
    input: ActionInput<typeof api.worker.recordDelegation>
  ): Promise<FunctionReturnType<typeof api.worker.recordDelegation>> {
    return await this.client.action(api.worker.recordDelegation, this.args(input));
  }

  async recordLifecycle(
    input: ActionInput<typeof api.worker.recordLifecycle>
  ): Promise<FunctionReturnType<typeof api.worker.recordLifecycle>> {
    return await this.client.action(api.worker.recordLifecycle, this.args(input));
  }

  async getTaskTokenUsage(
    input: ActionInput<typeof api.worker.getTaskTokenUsage>
  ): Promise<FunctionReturnType<typeof api.worker.getTaskTokenUsage>> {
    return await this.client.action(api.worker.getTaskTokenUsage, this.args(input));
  }

  // Plan 006 Phase 4: durable queue (messages claimed with the task lease pattern).
  async claimNextMessage(
    input: ActionInput<typeof api.worker.claimNextMessage>
  ): Promise<FunctionReturnType<typeof api.worker.claimNextMessage> | null> {
    return await this.client.action(api.worker.claimNextMessage, this.args(input));
  }

  async completeMessage(
    input: ActionInput<typeof api.worker.completeMessage>
  ): Promise<FunctionReturnType<typeof api.worker.completeMessage>> {
    return await this.client.action(api.worker.completeMessage, this.args(input));
  }

  async failMessage(
    input: ActionInput<typeof api.worker.failMessage>
  ): Promise<FunctionReturnType<typeof api.worker.failMessage>> {
    return await this.client.action(api.worker.failMessage, this.args(input));
  }

  async retryMessage(
    input: ActionInput<typeof api.worker.retryMessage>
  ): Promise<FunctionReturnType<typeof api.worker.retryMessage>> {
    return await this.client.action(api.worker.retryMessage, this.args(input));
  }

  async cancelMessage(
    input: ActionInput<typeof api.worker.cancelMessage>
  ): Promise<FunctionReturnType<typeof api.worker.cancelMessage>> {
    return await this.client.action(api.worker.cancelMessage, this.args(input));
  }

  async recoverStaleMessages(
    input: ActionInput<typeof api.worker.recoverStaleMessages>
  ): Promise<FunctionReturnType<typeof api.worker.recoverStaleMessages>> {
    return await this.client.action(api.worker.recoverStaleMessages, this.args(input));
  }

  // Plan 019: stage cards + task-branch push flow.
  async postTaskCard(
    input: ActionInput<typeof api.worker.postTaskCard>
  ): Promise<FunctionReturnType<typeof api.worker.postTaskCard>> {
    // Lease fencing: a displaced worker's card is refused.
    return await this.client.action(
      api.worker.postTaskCard,
      this.args({ workerId: this.workerId, ...input })
    );
  }

  async recordTaskCommit(
    input: ActionInput<typeof api.worker.recordTaskCommit>
  ): Promise<FunctionReturnType<typeof api.worker.recordTaskCommit>> {
    return await this.client.action(
      api.worker.recordTaskCommit,
      this.args({ workerId: this.workerId, ...input })
    );
  }

  /** The result carries the project's GitHub token: never log it. */
  async claimPushRequest(
    input: ActionInput<typeof api.worker.claimPushRequest>
  ): Promise<FunctionReturnType<typeof api.worker.claimPushRequest>> {
    return await this.client.action(api.worker.claimPushRequest, this.args(input));
  }

  async completePushRequest(
    input: ActionInput<typeof api.worker.completePushRequest>
  ): Promise<FunctionReturnType<typeof api.worker.completePushRequest>> {
    return await this.client.action(api.worker.completePushRequest, this.args(input));
  }

  // Plan Inspector + Task Estimator (apps/api/convex/planReview.ts).
  async getEstimateSamples(
    input: ActionInput<typeof api.worker.getEstimateSamples>
  ): Promise<FunctionReturnType<typeof api.worker.getEstimateSamples>> {
    return await this.client.action(api.worker.getEstimateSamples, this.args(input));
  }

  async requestPlanReview(
    input: ActionInput<typeof api.worker.requestPlanReview>
  ): Promise<FunctionReturnType<typeof api.worker.requestPlanReview>> {
    // Lease fencing: a displaced worker cannot pause the new owner's run.
    return await this.client.action(
      api.worker.requestPlanReview,
      this.args({ workerId: this.workerId, ...input })
    );
  }
}
