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

export const claimTask = action({
  args: {
    ...tokenArg,
    workerId: v.string(),
    leaseMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    assertServiceToken(args.workerToken);
    return await ctx.runMutation(internal.orchestration.claimNextTask, {
      workerId: args.workerId,
      leaseMs: args.leaseMs,
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
    assertServiceToken(args.workerToken);
    return await ctx.runMutation(internal.orchestration.heartbeat, {
      workerId: args.workerId,
      hostname: args.hostname,
      capacity: args.capacity,
      activeTasks: args.activeTasks,
      leaseMs: args.leaseMs,
    });
  },
});

export const markOffline = action({
  args: { ...tokenArg, workerId: v.string() },
  handler: async (ctx, args): Promise<any> => {
    assertServiceToken(args.workerToken);
    await ctx.runMutation(internal.orchestration.markWorkerOffline, {
      workerId: args.workerId,
    });
  },
});

export const recover = action({
  args: {
    ...tokenArg,
    staleGraceMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    assertServiceToken(args.workerToken);
    return await ctx.runMutation(internal.orchestration.recoverStale, {
      now: Date.now(),
      staleGraceMs: args.staleGraceMs,
    });
  },
});

export const getContext = action({
  args: { ...tokenArg, taskId: v.id("tasks") },
  handler: async (ctx, args): Promise<any> => {
    assertServiceToken(args.workerToken);
    return await ctx.runQuery(internal.orchestration.getRunContext, {
      taskId: args.taskId,
    });
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
    assertServiceToken(args.workerToken);
    const { workerToken: _token, ...rest } = args;
    await ctx.runMutation(internal.orchestration.setPlanning, rest);
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
    assertServiceToken(args.workerToken);
    const { workerToken: _token, ...rest } = args;
    return await ctx.runMutation(internal.orchestration.savePlan, rest);
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
    assertServiceToken(args.workerToken);
    const { workerToken: _token, ...rest } = args;
    return await ctx.runMutation(internal.orchestration.startExecution, rest);
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
    assertServiceToken(args.workerToken);
    const { workerToken: _token, ...rest } = args;
    await ctx.runMutation(internal.orchestration.updateExecution, rest);
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
    assertServiceToken(args.workerToken);
    const { workerToken: _token, ...rest } = args;
    return await ctx.runMutation(internal.orchestration.updateSubtask, rest);
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
      v.literal("run_command")
    ),
    summary: v.string(),
    payload: v.optional(v.any()),
    requestedByAgentId: v.optional(v.id("agents")),
    planVersion: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    assertServiceToken(args.workerToken);
    const { workerToken: _token, ...rest } = args;
    return await ctx.runMutation(internal.orchestration.requestApproval, rest);
  },
});

export const getResumable = action({
  args: { ...tokenArg },
  handler: async (ctx, args): Promise<any> => {
    assertServiceToken(args.workerToken);
    return await ctx.runQuery(internal.orchestration.getResumableTasks, {});
  },
});

export const getApprovals = action({
  args: { ...tokenArg, taskId: v.id("tasks") },
  handler: async (ctx, args): Promise<any> => {
    assertServiceToken(args.workerToken);
    return await ctx.runQuery(internal.orchestration.getTaskApprovals, {
      taskId: args.taskId,
    });
  },
});

export const getFileChanges = action({
  args: { ...tokenArg, taskId: v.id("tasks") },
  handler: async (ctx, args): Promise<any> => {
    assertServiceToken(args.workerToken);
    return await ctx.runQuery(internal.orchestration.getTaskFileChanges, {
      taskId: args.taskId,
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
    assertServiceToken(args.workerToken);
    const { workerToken: _token, ...rest } = args;
    return await ctx.runMutation(internal.orchestration.saveFileChange, rest);
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
    assertServiceToken(args.workerToken);
    await ctx.runMutation(internal.orchestration.markFileChangesApplied, {
      taskId: args.taskId,
      filePaths: args.filePaths,
      workerId: args.workerId,
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
    assertServiceToken(args.workerToken);
    await ctx.runMutation(internal.orchestration.completeTask, {
      taskId: args.taskId,
      status: args.status,
      errorMessage: args.errorMessage,
    });
  },
});

export const setTaskStatus = action({
  args: { ...tokenArg, taskId: v.id("tasks"), status: taskStatus },
  handler: async (ctx, args): Promise<any> => {
    assertServiceToken(args.workerToken);
    await ctx.runMutation(internal.orchestration.setTaskStatus, {
      taskId: args.taskId,
      status: args.status,
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
    assertServiceToken(args.workerToken);
    const { workerToken: _token, ...rest } = args;
    await ctx.runMutation(internal.orchestration.recordEvaluation, rest);
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
    assertServiceToken(args.workerToken);
    const { workerToken: _token, ...rest } = args;
    await ctx.runMutation(internal.orchestration.logEvent, rest);
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
    assertServiceToken(args.workerToken);
    const { workerToken: _token, ...rest } = args;
    return await ctx.runMutation(internal.orchestration.appendAgentMessage, rest);
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
    assertServiceToken(args.workerToken);
    const { workerToken: _token, ...rest } = args;
    await ctx.runMutation(internal.audit.record, rest);
  },
});
