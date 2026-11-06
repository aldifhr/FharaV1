import type { ConvexHttpClient } from "convex/browser";
import { api } from "@/api/convex/_generated/api";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import type { Doc } from "@/api/convex/_generated/dataModel";

/** Convex document shapes returned by the worker API. */
export type WorkerTask = Doc<"tasks">;
export type WorkerProject = Doc<"projects">;
export type WorkerAgent = Doc<"agents">;
export type WorkerPlanRecord = Doc<"plans">;
export type WorkerSubtask = Doc<"subtasks">;
export type WorkerFileChange = Doc<"fileChanges">;

export type WorkerTaskId = WorkerTask["_id"];
export type WorkerProjectId = WorkerProject["_id"];
export type WorkerAgentId = WorkerAgent["_id"];
export type WorkerExecutionId = Doc<"executions">["_id"];

/**
 * A simple type alias for Convex document IDs.
 * The actual Id type uses branded strings for type safety.
 */
type Id<T extends string> = string;

export class WorkerApi {
  constructor(
    private readonly client: ConvexHttpClient,
    private readonly token: string
  ) {}

  private args<T extends Record<string, unknown>>(value: T): T & { workerToken: string } {
    return { ...value, workerToken: this.token };
  }

  async claimTask(
    input: Omit<FunctionArgs<typeof api.worker.claimTask>, "workerToken">
  ): Promise<FunctionReturnType<typeof api.worker.claimTask>> {
    return await this.client.action(api.worker.claimTask, this.args(input));
  }

  async heartbeat(
    input: Omit<FunctionArgs<typeof api.worker.heartbeat>, "workerToken">
  ): Promise<FunctionReturnType<typeof api.worker.heartbeat>> {
    return await this.client.action(api.worker.heartbeat, this.args(input));
  }

  async markOffline(
    input: Omit<FunctionArgs<typeof api.worker.markOffline>, "workerToken">
  ): Promise<FunctionReturnType<typeof api.worker.markOffline>> {
    return await this.client.action(api.worker.markOffline, this.args(input));
  }

  async recover(
    input: Omit<FunctionArgs<typeof api.worker.recover>, "workerToken">
  ): Promise<FunctionReturnType<typeof api.worker.recover>> {
    return await this.client.action(api.worker.recover, this.args(input));
  }

  async getContext(
    input: Omit<FunctionArgs<typeof api.worker.getContext>, "workerToken">
  ): Promise<FunctionReturnType<typeof api.worker.getContext>> {
    return await this.client.action(api.worker.getContext, this.args(input));
  }

  async setPlanning(
    input: Omit<FunctionArgs<typeof api.worker.setPlanning>, "workerToken">
  ): Promise<FunctionReturnType<typeof api.worker.setPlanning>> {
    return await this.client.action(api.worker.setPlanning, this.args(input));
  }

  async savePlan(
    input: Omit<FunctionArgs<typeof api.worker.savePlan>, "workerToken">
  ): Promise<FunctionReturnType<typeof api.worker.savePlan>> {
    return await this.client.action(api.worker.savePlan, this.args(input));
  }

  async startExecution(
    input: Omit<FunctionArgs<typeof api.worker.startExecution>, "workerToken">
  ): Promise<FunctionReturnType<typeof api.worker.startExecution>> {
    return await this.client.action(api.worker.startExecution, this.args(input));
  }

  async updateExecution(
    input: Omit<FunctionArgs<typeof api.worker.updateExecution>, "workerToken">
  ): Promise<FunctionReturnType<typeof api.worker.updateExecution>> {
    return await this.client.action(api.worker.updateExecution, this.args(input));
  }

  async updateSubtask(
    input: Omit<FunctionArgs<typeof api.worker.updateSubtask>, "workerToken">
  ): Promise<FunctionReturnType<typeof api.worker.updateSubtask>> {
    return await this.client.action(api.worker.updateSubtask, this.args(input));
  }

  async requestApproval(
    input: Omit<FunctionArgs<typeof api.worker.requestApproval>, "workerToken">
  ): Promise<FunctionReturnType<typeof api.worker.requestApproval>> {
    return await this.client.action(api.worker.requestApproval, this.args(input));
  }

  async getResumable(): Promise<FunctionReturnType<typeof api.worker.getResumable>> {
    return await this.client.action(api.worker.getResumable, this.args({}));
  }

  async getApprovals(
    input: Omit<FunctionArgs<typeof api.worker.getApprovals>, "workerToken">
  ): Promise<FunctionReturnType<typeof api.worker.getApprovals>> {
    return await this.client.action(api.worker.getApprovals, this.args(input));
  }

  async getFileChanges(
    input: Omit<FunctionArgs<typeof api.worker.getFileChanges>, "workerToken">
  ): Promise<FunctionReturnType<typeof api.worker.getFileChanges>> {
    return await this.client.action(api.worker.getFileChanges, this.args(input));
  }

  async saveFileChange(
    input: Omit<FunctionArgs<typeof api.worker.saveFileChange>, "workerToken">
  ): Promise<FunctionReturnType<typeof api.worker.saveFileChange>> {
    return await this.client.action(api.worker.saveFileChange, this.args(input));
  }

  async markFilesApplied(
    input: Omit<FunctionArgs<typeof api.worker.markFilesApplied>, "workerToken">
  ): Promise<FunctionReturnType<typeof api.worker.markFilesApplied>> {
    return await this.client.action(api.worker.markFilesApplied, this.args(input));
  }

  async completeTask(
    input: Omit<FunctionArgs<typeof api.worker.completeTask>, "workerToken">
  ): Promise<FunctionReturnType<typeof api.worker.completeTask>> {
    return await this.client.action(api.worker.completeTask, this.args(input));
  }

  async recordEvaluation(
    input: Omit<FunctionArgs<typeof api.worker.recordEvaluation>, "workerToken">
  ): Promise<FunctionReturnType<typeof api.worker.recordEvaluation>> {
    return await this.client.action(api.worker.recordEvaluation, this.args(input));
  }

  async logEvent(
    input: Omit<FunctionArgs<typeof api.worker.logEvent>, "workerToken">
  ): Promise<FunctionReturnType<typeof api.worker.logEvent>> {
    return await this.client.action(api.worker.logEvent, this.args(input));
  }

  async appendAgentMessage(
    input: Omit<FunctionArgs<typeof api.worker.appendAgentMessage>, "workerToken">
  ): Promise<FunctionReturnType<typeof api.worker.appendAgentMessage>> {
    return await this.client.action(api.worker.appendAgentMessage, this.args(input));
  }

  async recordAudit(
    input: Omit<FunctionArgs<typeof api.worker.recordAudit>, "workerToken">
  ): Promise<FunctionReturnType<typeof api.worker.recordAudit>> {
    return await this.client.action(api.worker.recordAudit, this.args(input));
  }

  async recordTokenUsage(
    input: Omit<FunctionArgs<typeof api.worker.recordTokenUsage>, "workerToken">
  ): Promise<FunctionReturnType<typeof api.worker.recordTokenUsage>> {
    return await this.client.action(api.worker.recordTokenUsage, this.args(input));
  }

  async createBranch(
    input: Omit<FunctionArgs<typeof api.worker.createBranch>, "workerToken">
  ): Promise<FunctionReturnType<typeof api.worker.createBranch>> {
    return await this.client.action(api.worker.createBranch, this.args(input));
  }

  async mergeBranch(
    input: Omit<FunctionArgs<typeof api.worker.mergeBranch>, "workerToken">
  ): Promise<FunctionReturnType<typeof api.worker.mergeBranch>> {
    return await this.client.action(api.worker.mergeBranch, this.args(input));
  }

  async discardBranch(
    input: Omit<FunctionArgs<typeof api.worker.discardBranch>, "workerToken">
  ): Promise<FunctionReturnType<typeof api.worker.discardBranch>> {
    return await this.client.action(api.worker.discardBranch, this.args(input));
  }

  async getTaskContext(
    input: Omit<FunctionArgs<typeof api.worker.getTaskContext>, "workerToken">
  ): Promise<FunctionReturnType<typeof api.worker.getTaskContext>> {
    return await this.client.action(api.worker.getTaskContext, this.args(input));
  }

  async upsertTaskContext(
    input: Omit<FunctionArgs<typeof api.worker.upsertTaskContext>, "workerToken">
  ): Promise<FunctionReturnType<typeof api.worker.upsertTaskContext>> {
    return await this.client.action(api.worker.upsertTaskContext, this.args(input));
  }

  async recordDelegation(
    input: Omit<FunctionArgs<typeof api.worker.recordDelegation>, "workerToken">
  ): Promise<FunctionReturnType<typeof api.worker.recordDelegation>> {
    return await this.client.action(api.worker.recordDelegation, this.args(input));
  }

  async recordLifecycle(
    input: Omit<FunctionArgs<typeof api.worker.recordLifecycle>, "workerToken">
  ): Promise<FunctionReturnType<typeof api.worker.recordLifecycle>> {
    return await this.client.action(api.worker.recordLifecycle, this.args(input));
  }

  async getTaskTokenUsage(
    input: Omit<FunctionArgs<typeof api.worker.getTaskTokenUsage>, "workerToken">
  ): Promise<FunctionReturnType<typeof api.worker.getTaskTokenUsage>> {
    return await this.client.action(api.worker.getTaskTokenUsage, this.args(input));
  }
}
