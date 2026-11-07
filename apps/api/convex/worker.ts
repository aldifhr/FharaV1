import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { assertServiceToken } from "./authz";
import {
  taskStatus,
  subtaskKind,
  subtaskStatus,
  executionStatus,
} from "./schema";

const tokenArg = { workerToken: v.string() };

/** Authenticate a worker action and return its args without the service token. */
function withoutToken<A extends object>(args: A): Omit<A, "workerToken"> {
  assertServiceToken((args as { workerToken?: string }).workerToken);
  const { workerToken: _token, ...rest } = args as A & { workerToken: string };
  return rest;
}

export const claimTask = action({
  args: {
    ...tokenArg,
    workerId: v.string(),
    leaseMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    const { workerId, leaseMs } = withoutToken(args);
    return await ctx.runMutation(internal.orchestration.claimNextTask, {
      workerId,
      leaseMs,
    });
  },
});

export const heartbeat = action({
  args: {
    ...tokenArg,
    workerId: v.string(),
    hostname: v.optional(v.string()),
    capacity: v.number(),
    activeTasks: v.number(),
    leaseMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    const { workerId, hostname, capacity, activeTasks, leaseMs } =
      withoutToken(args);
    return await ctx.runMutation(internal.orchestration.heartbeat, {
      workerId,
      hostname,
      capacity,
      activeTasks,
      leaseMs,
    });
  },
});

export const markOffline = action({
  args: { ...tokenArg, workerId: v.string() },
  handler: async (ctx, args): Promise<any> => {
    const { workerId } = withoutToken(args);
    await ctx.runMutation(internal.orchestration.markWorkerOffline, {
      workerId,
    });
  },
});

export const recover = action({
  args: {
    ...tokenArg,
    staleGraceMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    const { staleGraceMs } = withoutToken(args);
    return await ctx.runMutation(internal.orchestration.recoverStale, {
      now: Date.now(),
      staleGraceMs,
    });
  },
});

export const getContext = action({
  args: { ...tokenArg, taskId: v.id("tasks") },
  handler: async (ctx, args): Promise<any> => {
    const { taskId } = withoutToken(args);
    return await ctx.runQuery(internal.orchestration.getRunContext, { taskId });
  },
});

export const setPlanning = action({
  args: {
    ...tokenArg,
    taskId: v.id("tasks"),
    classification: v.string(),
    strategy: v.string(),
    planVersion: v.number(),
  },
  handler: async (ctx, args): Promise<any> => {
    await ctx.runMutation(internal.orchestration.setPlanning, withoutToken(args));
  },
});

export const savePlan = action({
  args: {
    ...tokenArg,
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    version: v.number(),
    strategy: v.string(),
    createdBy: v.union(v.literal("orchestrator"), v.literal("fallback")),
    goal: v.string(),
    payload: v.any(),
    subtasks: v.array(
      v.object({
        key: v.string(),
        title: v.string(),
        description: v.string(),
        kind: subtaskKind,
        capability: v.string(),
        dependencies: v.array(v.string()),
        order: v.number(),
      })
    ),
  },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runMutation(
      internal.orchestration.savePlan,
      withoutToken(args)
    );
  },
});

export const saveDynamicSubtasks = action({
  args: {
    ...tokenArg,
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    version: v.number(),
    payload: v.any(),
    subtasks: v.array(
      v.object({
        key: v.string(),
        title: v.string(),
        description: v.string(),
        kind: subtaskKind,
        capability: v.string(),
        dependencies: v.array(v.string()),
        order: v.number(),
        origin: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runMutation(
      internal.orchestration.upsertDynamicSubtasks,
      withoutToken(args)
    );
  },
});

export const startExecution = action({
  args: {
    ...tokenArg,
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    subtaskKey: v.string(),
    agentId: v.optional(v.id("agents")),
    agentName: v.string(),
    capability: v.string(),
    workerId: v.string(),
    attempt: v.number(),
    leaseMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runMutation(
      internal.orchestration.startExecution,
      withoutToken(args)
    );
  },
});

export const updateExecution = action({
  args: {
    ...tokenArg,
    executionId: v.id("executions"),
    subtaskKey: v.optional(v.string()),
    status: executionStatus,
    output: v.optional(v.string()),
    error: v.optional(v.string()),
    meta: v.optional(v.any()),
    leaseMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    await ctx.runMutation(
      internal.orchestration.updateExecution,
      withoutToken(args)
    );
  },
});

export const updateSubtask = action({
  args: {
    ...tokenArg,
    taskId: v.id("tasks"),
    key: v.string(),
    status: subtaskStatus,
    output: v.optional(v.string()),
    error: v.optional(v.string()),
    agentId: v.optional(v.id("agents")),
    agentName: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runMutation(
      internal.orchestration.updateSubtask,
      withoutToken(args)
    );
  },
});

export const requestApproval = action({
  args: {
    ...tokenArg,
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    executionId: v.optional(v.id("executions")),
    subtaskKey: v.optional(v.string()),
    kind: v.union(
      v.literal("apply_changes"),
      v.literal("git_push"),
      v.literal("run_command"),
      v.literal("merge_pr")
    ),
    summary: v.string(),
    payload: v.optional(v.any()),
    requestedByAgentId: v.optional(v.id("agents")),
    planVersion: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runMutation(
      internal.orchestration.requestApproval,
      withoutToken(args)
    );
  },
});

export const getResumable = action({
  args: { ...tokenArg },
  handler: async (ctx, args): Promise<any> => {
    withoutToken(args);
    return await ctx.runQuery(internal.orchestration.getResumableTasks, {});
  },
});

export const getApprovals = action({
  args: { ...tokenArg, taskId: v.id("tasks") },
  handler: async (ctx, args): Promise<any> => {
    const { taskId } = withoutToken(args);
    return await ctx.runQuery(internal.orchestration.getTaskApprovals, {
      taskId,
    });
  },
});

export const getFileChanges = action({
  args: { ...tokenArg, taskId: v.id("tasks") },
  handler: async (ctx, args): Promise<any> => {
    const { taskId } = withoutToken(args);
    return await ctx.runQuery(internal.orchestration.getTaskFileChanges, {
      taskId,
    });
  },
});

export const saveFileChange = action({
  args: {
    ...tokenArg,
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    filePath: v.string(),
    changeType: v.union(
      v.literal("new"),
      v.literal("modified"),
      v.literal("deleted")
    ),
    oldContent: v.optional(v.string()),
    newContent: v.optional(v.string()),
    oldContentHash: v.optional(v.string()),
    newContentHash: v.optional(v.string()),
    diff: v.string(),
    subtaskKey: v.optional(v.string()),
    executionId: v.optional(v.id("executions")),
  },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runMutation(
      internal.orchestration.saveFileChange,
      withoutToken(args)
    );
  },
});

export const markFilesApplied = action({
  args: {
    ...tokenArg,
    taskId: v.id("tasks"),
    filePaths: v.array(v.string()),
    workerId: v.string(),
  },
  handler: async (ctx, args): Promise<any> => {
    const { taskId, filePaths, workerId } = withoutToken(args);
    await ctx.runMutation(internal.orchestration.markFileChangesApplied, {
      taskId,
      filePaths,
      workerId,
    });
  },
});

export const completeTask = action({
  args: {
    ...tokenArg,
    taskId: v.id("tasks"),
    status: taskStatus,
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    const { taskId, status, errorMessage } = withoutToken(args);
    await ctx.runMutation(internal.orchestration.completeTask, {
      taskId,
      status,
      errorMessage,
    });
  },
});

export const setTaskStatus = action({
  args: { ...tokenArg, taskId: v.id("tasks"), status: taskStatus },
  handler: async (ctx, args): Promise<any> => {
    const { taskId, status } = withoutToken(args);
    await ctx.runMutation(internal.orchestration.setTaskStatus, {
      taskId,
      status,
    });
  },
});

export const recordEvaluation = action({
  args: {
    ...tokenArg,
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    planVersion: v.number(),
    verdict: v.union(
      v.literal("passed"),
      v.literal("failed"),
      v.literal("inconclusive")
    ),
    checks: v.any(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    await ctx.runMutation(
      internal.orchestration.recordEvaluation,
      withoutToken(args)
    );
  },
});

export const logEvent = action({
  args: {
    ...tokenArg,
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    type: v.string(),
    payload: v.optional(v.any()),
    executionId: v.optional(v.id("executions")),
    subtaskKey: v.optional(v.string()),
    level: v.optional(v.union(v.literal("info"), v.literal("warn"), v.literal("error"))),
  },
  handler: async (ctx, args): Promise<any> => {
    await ctx.runMutation(
      internal.orchestration.logEvent,
      withoutToken(args)
    );
  },
});

export const appendAgentMessage = action({
  args: {
    ...tokenArg,
    projectId: v.id("projects"),
    taskId: v.id("tasks"),
    agentId: v.optional(v.id("agents")),
    content: v.string(),
    subtaskKey: v.optional(v.string()),
    executionId: v.optional(v.id("executions")),
  },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runMutation(
      internal.orchestration.appendAgentMessage,
      withoutToken(args)
    );
  },
});

export const recordAudit = action({
  args: {
    ...tokenArg,
    taskId: v.optional(v.id("tasks")),
    projectId: v.optional(v.id("projects")),
    executionId: v.optional(v.id("executions")),
    workerId: v.optional(v.string()),
    actor: v.string(),
    tool: v.string(),
    action: v.string(),
    decision: v.union(
      v.literal("allowed"),
      v.literal("denied"),
      v.literal("pending"),
      v.literal("recorded")
    ),
    target: v.optional(v.string()),
    details: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<any> => {
    await ctx.runMutation(internal.audit.record, withoutToken(args));
  },
});

export const recordTokenUsage = action({
  args: {
    ...tokenArg,
    projectId: v.id("projects"),
    taskId: v.optional(v.id("tasks")),
    agentId: v.optional(v.id("agents")),
    agentName: v.string(),
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    // Phase 5: serving connection + registry model + estimated cost.
    providerId: v.optional(v.id("llmProviders")),
    modelId: v.optional(v.id("llmModels")),
    estimatedCost: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    await ctx.runMutation(
      internal.orchestration.recordTokenUsage,
      withoutToken(args)
    );
  },
});

export const reportProviderHealth = action({
  args: {
    ...tokenArg,
    // Phase 5: one circuit snapshot per provider connection, mirrored
    // by the worker's health registry reporter (Settings UI panel).
    providerId: v.id("llmProviders"),
    providerName: v.string(),
    consecutiveTransientFailures: v.number(),
    totalSuccesses: v.number(),
    totalTransientFailures: v.number(),
    circuitOpenUntil: v.optional(v.number()),
    lastSuccessAt: v.optional(v.number()),
    lastFailureAt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    await ctx.runMutation(
      internal.orchestration.reportProviderHealth,
      withoutToken(args)
    );
  },
});

export const createBranch = action({
  args: { ...tokenArg, taskId: v.id("tasks"), projectId: v.id("projects") },
  handler: async (ctx, args): Promise<any> => {
    const { taskId, projectId } = withoutToken(args);
    return await ctx.runAction(internal.worktreeNode.createBranch, {
      taskId,
      projectId,
    });
  },
});

export const getDiff = action({
  args: { ...tokenArg, taskId: v.id("tasks") },
  handler: async (ctx, args): Promise<any> => {
    const { taskId } = withoutToken(args);
    return await ctx.runAction(internal.worktreeNode.getDiff, { taskId });
  },
});

export const mergeBranch = action({
  args: { ...tokenArg, taskId: v.id("tasks") },
  handler: async (ctx, args): Promise<any> => {
    const { taskId } = withoutToken(args);
    return await ctx.runAction(internal.worktreeNode.mergeBranch, { taskId });
  },
});

export const discardBranch = action({
  args: { ...tokenArg, taskId: v.id("tasks") },
  handler: async (ctx, args): Promise<any> => {
    const { taskId } = withoutToken(args);
    return await ctx.runAction(internal.worktreeNode.discardBranch, { taskId });
  },
});

export const getTaskContext = action({
  args: { ...tokenArg, taskId: v.id("tasks") },
  handler: async (ctx, args): Promise<any> => {
    const { taskId } = withoutToken(args);
    return await ctx.runQuery(internal.orchestration.getTaskContext, { taskId });
  },
});

export const upsertTaskContext = action({
  args: {
    ...tokenArg,
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    originalRequest: v.string(),
    objective: v.string(),
    status: taskStatus,
    decisions: v.array(v.any()),
    artifacts: v.array(v.any()),
    outstandingIssues: v.array(v.any()),
    // Phase 5 (additive): persisted budget snapshot.
    budgetSnapshot: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runMutation(
      internal.orchestration.upsertTaskContext,
      withoutToken(args)
    );
  },
});

export const recordDelegation = action({
  args: {
    ...tokenArg,
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    fromAgentId: v.optional(v.id("agents")),
    toAgentId: v.optional(v.id("agents")),
    decision: v.union(
      v.literal("APPROVE"),
      v.literal("REJECT"),
      v.literal("REVISE"),
      v.literal("COMPLETE"),
      v.literal("BLOCKED")
    ),
    reason: v.optional(v.string()),
    capability: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runMutation(
      internal.orchestration.recordDelegation,
      withoutToken(args)
    );
  },
});

export const recordLifecycle = action({
  args: {
    ...tokenArg,
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    state: v.string(),
    prevState: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runMutation(
      internal.orchestration.recordLifecycle,
      withoutToken(args)
    );
  },
});

export const getTaskTokenUsage = action({
  args: { ...tokenArg, taskId: v.id("tasks") },
  handler: async (ctx, args): Promise<any> => {
    const { taskId } = withoutToken(args);
    return await ctx.runQuery(internal.orchestration.getTaskTokenUsage, {
      taskId,
    });
  },
});
