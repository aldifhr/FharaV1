import type { ConvexClient, ConvexHttpClient } from "convex/browser";
import { api } from "@/api/convex/_generated/api";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import type { Doc } from "@/api/convex/_generated/dataModel";
import type { PromptSkill } from "@/api/convex/lib/skills";
import { redactDeep } from "@/utils/redact";

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

  /**
   * L2: text written to Convex from a run (events, messages, audit rows,
   * cards, subtask output, live tails) is masked first: the worker's known
   * secret values and secret shapes never leave the process. File contents
   * (saveFileChange) and the plan structure are not touched.
   */
  private masked<T>(input: T): T {
    return redactDeep(input);
  }

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

  /** Settings modal: knob overrides + child env (lib/appSettings.ts). */
  async getAppSettings(): Promise<FunctionReturnType<typeof api.worker.getAppSettings>> {
    return await this.client.action(api.worker.getAppSettings, this.args({}));
  }

  /** Settings modal: this worker's env value for each worker-read knob. */
  async reportKnobEnv(
    input: ActionInput<typeof api.worker.reportKnobEnv>
  ): Promise<FunctionReturnType<typeof api.worker.reportKnobEnv>> {
    return await this.client.action(api.worker.reportKnobEnv, this.args(input));
  }

  /** Plan 033: publish the model list the local OpenCode CLI reported. */
  async reportOpencodeModels(
    input: ActionInput<typeof api.worker.reportOpencodeModels>
  ): Promise<FunctionReturnType<typeof api.worker.reportOpencodeModels>> {
    return await this.client.action(api.worker.reportOpencodeModels, this.args(input));
  }

  /** Plan 033: is a refresh pending, and when did this worker last report? */
  async getOpencodeModelState(
    input: ActionInput<typeof api.worker.getOpencodeModelState>
  ): Promise<FunctionReturnType<typeof api.worker.getOpencodeModelState>> {
    return await this.client.action(api.worker.getOpencodeModelState, this.args(input));
  }

  /** Plan 038: store the result of the Settings "Test" probe for OpenCode. */
  async reportOpencodeTest(
    input: ActionInput<typeof api.worker.reportOpencodeTest>
  ): Promise<FunctionReturnType<typeof api.worker.reportOpencodeTest>> {
    return await this.client.action(api.worker.reportOpencodeTest, this.args(input));
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
      this.args({ workerId: this.workerId, ...this.masked(input) })
    );
  }

  async updateSubtask(
    input: ActionInput<typeof api.worker.updateSubtask>
  ): Promise<FunctionReturnType<typeof api.worker.updateSubtask>> {
    return await this.client.action(
      api.worker.updateSubtask,
      this.args({ workerId: this.workerId, ...this.masked(input) })
    );
  }

  async setSubtaskActivity(
    input: ActionInput<typeof api.worker.setSubtaskActivity>
  ): Promise<FunctionReturnType<typeof api.worker.setSubtaskActivity>> {
    return await this.client.action(
      api.worker.setSubtaskActivity,
      this.args({ workerId: this.workerId, ...this.masked(input) })
    );
  }

  async setSubtaskLiveOutput(
    input: ActionInput<typeof api.worker.setSubtaskLiveOutput>
  ): Promise<FunctionReturnType<typeof api.worker.setSubtaskLiveOutput>> {
    return await this.client.action(
      api.worker.setSubtaskLiveOutput,
      this.args({ workerId: this.workerId, ...this.masked(input) })
    );
  }

  async requestApproval(
    input: ActionInput<typeof api.worker.requestApproval>
  ): Promise<FunctionReturnType<typeof api.worker.requestApproval>> {
    // Lease fencing: the backend refuses the write when another worker
    // holds the task lease ("Lease lost" throw / {applied:false}).
    return await this.client.action(
      api.worker.requestApproval,
      this.args({ workerId: this.workerId, ...this.masked(input) })
    );
  }

  /** Chat UX: in-process run_command approval (the task keeps its lease). */
  async requestCommandApproval(
    input: ActionInput<typeof api.worker.requestCommandApproval>
  ): Promise<FunctionReturnType<typeof api.worker.requestCommandApproval>> {
    return await this.client.action(
      api.worker.requestCommandApproval,
      this.args({ workerId: this.workerId, ...this.masked(input) })
    );
  }

  async getCommandApproval(
    input: ActionInput<typeof api.worker.getCommandApproval>
  ): Promise<FunctionReturnType<typeof api.worker.getCommandApproval>> {
    return await this.client.action(api.worker.getCommandApproval, this.args(input));
  }

  async cancelCommandApproval(
    input: ActionInput<typeof api.worker.cancelCommandApproval>
  ): Promise<FunctionReturnType<typeof api.worker.cancelCommandApproval>> {
    return await this.client.action(api.worker.cancelCommandApproval, this.args(input));
  }

  /** The waiter saw the decision: consume its durable signal (one-time allow). */
  async ackCommandApproval(
    input: ActionInput<typeof api.worker.ackCommandApproval>
  ): Promise<FunctionReturnType<typeof api.worker.ackCommandApproval>> {
    return await this.client.action(
      api.worker.ackCommandApproval,
      this.args({ workerId: this.workerId, ...input })
    );
  }

  /**
   * Wake-up subscription (ConvexClient.onUpdate): fires `onChange` whenever
   * the oldest queued task or the newest unconsumed approval signal changes.
   * Returns the unsubscribe. The caller keeps a slow poll as the fallback.
   */
  subscribePendingWork(
    subscriber: Pick<ConvexClient, "onUpdate">,
    onChange: (result: FunctionReturnType<typeof api.worker.pendingWork>) => void,
    onError?: (error: Error) => void
  ): () => void {
    const unsubscribe = subscriber.onUpdate(api.worker.pendingWork, { workerToken: this.token }, onChange, onError);
    return () => unsubscribe();
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
      this.args({ workerId: this.workerId, ...this.masked(input) })
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
    return await this.client.action(api.worker.setTaskStatus, this.args(this.masked(input)));
  }

  // Plan 013 step 4: pause a task for a user answer (`waiting_input`).
  async pauseForInput(
    input: ActionInput<typeof api.worker.pauseForInput>
  ): Promise<FunctionReturnType<typeof api.worker.pauseForInput>> {
    return await this.client.action(api.worker.pauseForInput, this.args(this.masked(input)));
  }

  async recordEvaluation(
    input: ActionInput<typeof api.worker.recordEvaluation>
  ): Promise<FunctionReturnType<typeof api.worker.recordEvaluation>> {
    return await this.client.action(api.worker.recordEvaluation, this.args(this.masked(input)));
  }

  // Plan 009: MCP status reports from the worker (best-effort).
  async updateMcpServerStatus(
    input: ActionInput<typeof api.worker.updateMcpServerStatus>
  ): Promise<FunctionReturnType<typeof api.worker.updateMcpServerStatus>> {
    return await this.client.action(api.worker.updateMcpServerStatus, this.args(this.masked(input)));
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
    return await this.client.action(api.worker.completeRepoToolCall, this.args(this.masked(input)));
  }

  async completeMcpServerTest(
    input: ActionInput<typeof api.worker.completeMcpServerTest>
  ): Promise<FunctionReturnType<typeof api.worker.completeMcpServerTest>> {
    return await this.client.action(api.worker.completeMcpServerTest, this.args(this.masked(input)));
  }

  /** Plan 022: a subtask's acceptance (gate results / escalation). Lease-fenced. */
  async recordSubtaskAcceptance(
    input: ActionInput<typeof api.worker.recordSubtaskAcceptance>
  ): Promise<FunctionReturnType<typeof api.worker.recordSubtaskAcceptance>> {
    return await this.client.action(
      api.worker.recordSubtaskAcceptance,
      this.args({ workerId: this.workerId, ...this.masked(input) })
    );
  }

  /** Plan 025: the requirement coverage check before "done". Lease-fenced. */
  async recordRequirementCoverage(
    input: ActionInput<typeof api.worker.recordRequirementCoverage>
  ): Promise<FunctionReturnType<typeof api.worker.recordRequirementCoverage>> {
    return await this.client.action(
      api.worker.recordRequirementCoverage,
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
    return await this.client.action(api.worker.logEvent, this.args(this.masked(input)));
  }

  async appendAgentMessage(
    input: ActionInput<typeof api.worker.appendAgentMessage>
  ): Promise<FunctionReturnType<typeof api.worker.appendAgentMessage>> {
    return await this.client.action(api.worker.appendAgentMessage, this.args(this.masked(input)));
  }

  async recordAudit(
    input: ActionInput<typeof api.worker.recordAudit>
  ): Promise<FunctionReturnType<typeof api.worker.recordAudit>> {
    return await this.client.action(api.worker.recordAudit, this.args(this.masked(input)));
  }

  async recordContextSnapshot(
    input: ActionInput<typeof api.worker.recordContextSnapshot>
  ): Promise<FunctionReturnType<typeof api.worker.recordContextSnapshot>> {
    return await this.client.action(api.worker.recordContextSnapshot, this.args(input));
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
    return await this.client.action(api.worker.upsertTaskContext, this.args(this.masked(input)));
  }

  /** Plan L3: the task brief (null when none was written yet). */
  async getTaskBrief(
    input: ActionInput<typeof api.worker.getTaskBrief>
  ): Promise<FunctionReturnType<typeof api.worker.getTaskBrief>> {
    return await this.client.action(api.worker.getTaskBrief, this.args(input));
  }

  /** Plan L3: partial brief update (absent = keep, null = clear). */
  async updateTaskBrief(
    input: ActionInput<typeof api.worker.updateTaskBrief>
  ): Promise<FunctionReturnType<typeof api.worker.updateTaskBrief>> {
    return await this.client.action(api.worker.updateTaskBrief, this.args(input));
  }

  async recordDelegation(
    input: ActionInput<typeof api.worker.recordDelegation>
  ): Promise<FunctionReturnType<typeof api.worker.recordDelegation>> {
    return await this.client.action(api.worker.recordDelegation, this.args(this.masked(input)));
  }

  async recordLifecycle(
    input: ActionInput<typeof api.worker.recordLifecycle>
  ): Promise<FunctionReturnType<typeof api.worker.recordLifecycle>> {
    return await this.client.action(api.worker.recordLifecycle, this.args(this.masked(input)));
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
    return await this.client.action(api.worker.completeMessage, this.args(this.masked(input)));
  }

  async failMessage(
    input: ActionInput<typeof api.worker.failMessage>
  ): Promise<FunctionReturnType<typeof api.worker.failMessage>> {
    return await this.client.action(api.worker.failMessage, this.args(this.masked(input)));
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
      this.args({ workerId: this.workerId, ...this.masked(input) })
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
    return await this.client.action(api.worker.completePushRequest, this.args(this.masked(input)));
  }

  // L6: no-replay side-effect ledger (apps/api/convex/sideEffects.ts).
  async armSideEffect(
    input: ActionInput<typeof api.worker.armSideEffect>
  ): Promise<FunctionReturnType<typeof api.worker.armSideEffect>> {
    return await this.client.action(api.worker.armSideEffect, this.args(input));
  }

  async acceptSideEffect(
    input: ActionInput<typeof api.worker.acceptSideEffect>
  ): Promise<FunctionReturnType<typeof api.worker.acceptSideEffect>> {
    return await this.client.action(api.worker.acceptSideEffect, this.args(input));
  }

  async settleSideEffect(
    input: ActionInput<typeof api.worker.settleSideEffect>
  ): Promise<FunctionReturnType<typeof api.worker.settleSideEffect>> {
    return await this.client.action(api.worker.settleSideEffect, this.args(this.masked(input)));
  }

  async markSideEffectAmbiguous(
    input: ActionInput<typeof api.worker.markSideEffectAmbiguous>
  ): Promise<FunctionReturnType<typeof api.worker.markSideEffectAmbiguous>> {
    return await this.client.action(api.worker.markSideEffectAmbiguous, this.args(this.masked(input)));
  }

  // Workload Manager: running executions per agent (load-aware routing).
  async getAgentLoad(
    input: ActionInput<typeof api.worker.getAgentLoad>
  ): Promise<FunctionReturnType<typeof api.worker.getAgentLoad>> {
    return await this.client.action(api.worker.getAgentLoad, this.args(input));
  }

  // Plan 027: performance scores per agent + capability (performance routing).
  async getPerformanceScores(
    input: ActionInput<typeof api.worker.getPerformanceScores>
  ): Promise<FunctionReturnType<typeof api.worker.getPerformanceScores>> {
    return await this.client.action(api.worker.getPerformanceScores, this.args(input));
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

  /** Direct threads (threadbear T2): claim the oldest queued direct thread. */
  async claimDirectThread(
    input: ActionInput<typeof api.worker.claimDirectThread>
  ): Promise<FunctionReturnType<typeof api.worker.claimDirectThread>> {
    return await this.client.action(api.worker.claimDirectThread, this.args(input));
  }

  /** Status, Stop, the permission mode now and undelivered messages. */
  async pollDirectThread(
    input: ActionInput<typeof api.worker.pollDirectThread>
  ): Promise<FunctionReturnType<typeof api.worker.pollDirectThread>> {
    return await this.client.action(api.worker.pollDirectThread, this.args(input));
  }

  /** Persist engine events in order (lease-fenced), with an optional state patch. */
  async appendDirectEvents(
    input: ActionInput<typeof api.worker.appendDirectEvents>
  ): Promise<FunctionReturnType<typeof api.worker.appendDirectEvents>> {
    return await this.client.action(api.worker.appendDirectEvents, this.args(input));
  }

  /** Hot stream rows (~300 ms per item). */
  async flushDirectStream(
    input: ActionInput<typeof api.worker.flushDirectStream>
  ): Promise<FunctionReturnType<typeof api.worker.flushDirectStream>> {
    return await this.client.action(api.worker.flushDirectStream, this.args(input));
  }

  async clearDirectStreams(
    input: ActionInput<typeof api.worker.clearDirectStreams>
  ): Promise<FunctionReturnType<typeof api.worker.clearDirectStreams>> {
    return await this.client.action(api.worker.clearDirectStreams, this.args(input));
  }

  /** One ACP permission request: auto row or pending card (lease kept). */
  async requestDirectApproval(
    input: ActionInput<typeof api.worker.requestDirectApproval>
  ): Promise<FunctionReturnType<typeof api.worker.requestDirectApproval>> {
    return await this.client.action(api.worker.requestDirectApproval, this.args(input));
  }

  async getDirectApproval(
    input: ActionInput<typeof api.worker.getDirectApproval>
  ): Promise<FunctionReturnType<typeof api.worker.getDirectApproval>> {
    return await this.client.action(api.worker.getDirectApproval, this.args(input));
  }

  async cancelDirectApproval(
    input: ActionInput<typeof api.worker.cancelDirectApproval>
  ): Promise<FunctionReturnType<typeof api.worker.cancelDirectApproval>> {
    return await this.client.action(api.worker.cancelDirectApproval, this.args(input));
  }

  /** Let go of a thread (idle release, shutdown, engine error). */
  async releaseDirectThread(
    input: ActionInput<typeof api.worker.releaseDirectThread>
  ): Promise<FunctionReturnType<typeof api.worker.releaseDirectThread>> {
    return await this.client.action(api.worker.releaseDirectThread, this.args(input));
  }

  async getDirectHistory(
    input: ActionInput<typeof api.worker.getDirectHistory>
  ): Promise<FunctionReturnType<typeof api.worker.getDirectHistory>> {
    return await this.client.action(api.worker.getDirectHistory, this.args(input));
  }
}
