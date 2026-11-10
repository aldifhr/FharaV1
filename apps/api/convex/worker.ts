import { action, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { usageLedgerFields } from "./lib/usageLedger";
import {
  acceptanceStatusValidator,
  escalationValidator,
  gateResultValidator,
  subtaskContractFields,
} from "./lib/contractValidators";
import { assertServiceToken } from "./lib/authz";
import { snapshotRecordArgs } from "./contextSnapshots";
import { permissionArgs } from "./permissionBroker";
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

export const syncFixedTeam = action({
  args: { ...tokenArg },
  handler: async (ctx, args): Promise<any> => {
    withoutToken(args);
    return await ctx.runMutation(internal.agents.syncFixedTeamInternal, {});
  },
});

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

/**
 * Wake-up subscription for the worker (ConvexClient.onUpdate; idea from
 * convex-orchestrator's subscribePendingWorkflows, re-implemented). Returns
 * the oldest claimable queued task and the oldest unconsumed approval
 * signal: any change (new work, a decision) re-runs the query and wakes the
 * worker's loop at once. Cheap (two indexed take(1)); the worker keeps a
 * slow poll as the correctness fallback.
 */
export const pendingWork = query({
  args: { ...tokenArg },
  handler: async (ctx, args) => {
    withoutToken(args);
    const queued = await ctx.db
      .query("tasks")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .order("asc")
      .take(1);
    const signal = await ctx.db
      .query("taskSignals")
      .withIndex("by_name_and_consumed", (q) => q.eq("name", "approval").eq("consumedAt", undefined))
      .order("desc")
      .take(1);
    return {
      queuedTaskId: queued[0]?._id ?? null,
      resumeSignalId: signal[0]?._id ?? null,
    };
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
    // Optional: ids of the tasks this worker is running right now; only
    // their leases are renewed (see orchestration.heartbeat).
    activeTaskIds: v.optional(v.array(v.string())),
    // Features this worker build serves (e.g. "repoTools").
    capabilities: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<any> => {
    const { workerId, hostname, capacity, activeTasks, leaseMs, activeTaskIds, capabilities } =
      withoutToken(args);
    return await ctx.runMutation(internal.orchestration.heartbeat, {
      workerId,
      hostname,
      capacity,
      activeTasks,
      leaseMs,
      activeTaskIds,
      capabilities,
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

/**
 * Plan 034: the worker publishes the model list its OpenCode CLI reported
 * (`opencode models`). Model ids only — never credential material.
 */
export const reportOpencodeModels = action({
  args: {
    ...tokenArg,
    workerId: v.string(),
    hostname: v.optional(v.string()),
    models: v.array(v.string()),
    available: v.boolean(),
    error: v.optional(v.string()),
    command: v.optional(v.string()),
    // Plan 038: detection (binary found, `--version`, where it was found).
    installed: v.optional(v.boolean()),
    version: v.optional(v.string()),
    path: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ models: number }> => {
    return await ctx.runMutation(internal.opencodeModels.report, withoutToken(args));
  },
});

/**
 * Plan 038: the worker stores the result of the Settings "Test" probe for
 * the OpenCode provider. Latency and an error string only.
 */
export const reportOpencodeTest = action({
  args: {
    ...tokenArg,
    workerId: v.string(),
    ok: v.boolean(),
    latencyMs: v.number(),
    model: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ ok: boolean }> => {
    return await ctx.runMutation(internal.opencodeModels.reportTest, withoutToken(args));
  },
});

/**
 * Plan 034: the worker asks whether the UI requested a refresh and when it
 * last reported, so it only re-reads the CLI when it has to.
 */
export const getOpencodeModelState = action({
  args: { ...tokenArg, workerId: v.string() },
  handler: async (
    ctx,
    args
  ): Promise<{
    hasCatalog: boolean;
    available: boolean;
    updatedAt: number;
    refreshRequestedAt: number;
    testRequestedAt: number;
    testModel: string;
  }> => {
    const { workerId } = withoutToken(args);
    return await ctx.runQuery(internal.opencodeModels.state, { workerId });
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
    // Lease fencing: pass the worker id so a displaced worker is refused.
    workerId: v.optional(v.string()),
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
        allowedPaths: v.optional(v.array(v.string())),
        origin: v.optional(v.string()),
        reviewRound: v.optional(v.number()),
        ...subtaskContractFields,
      })
    ),
    degradedReason: v.optional(v.string()),
    // Task Estimator result (lib/estimate.ts).
    estimate: v.optional(v.any()),
    // Lease fencing: pass the worker id so a displaced worker is refused.
    workerId: v.optional(v.string()),
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
        allowedPaths: v.optional(v.array(v.string())),
        origin: v.optional(v.string()),
        reviewRound: v.optional(v.number()),
        ...subtaskContractFields,
      })
    ),
    // Lease fencing: pass the worker id so a displaced worker is refused.
    workerId: v.optional(v.string()),
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
    // Lease fencing: pass the worker id so a displaced worker is refused.
    workerId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runMutation(
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
    workerId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runMutation(
      internal.orchestration.updateSubtask,
      withoutToken(args)
    );
  },
});

export const setSubtaskActivity = action({
  args: {
    ...tokenArg,
    taskId: v.id("tasks"),
    key: v.string(),
    activity: v.string(),
    workerId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runMutation(
      internal.orchestration.setSubtaskActivity,
      withoutToken(args)
    );
  },
});

/** Live output tail of a running subtask; empty `text` clears it. */
export const setSubtaskLiveOutput = action({
  args: {
    ...tokenArg,
    taskId: v.id("tasks"),
    key: v.string(),
    text: v.string(),
    workerId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runMutation(internal.subtaskLive.set, withoutToken(args));
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
    // Lease fencing: pass the worker id so a displaced worker is refused.
    workerId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runMutation(internal.orchestration.requestApproval, {
      ...withoutToken(args),
    });
  },
});

/**
 * Chat UX: in-process run_command approval. The worker keeps its lease and
 * waits on the returned row (commandApprovals.ts); the task status does not
 * change. Lease-fenced like requestApproval.
 */
export const requestCommandApproval = action({
  args: {
    ...tokenArg,
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    subtaskKey: v.optional(v.string()),
    executionId: v.optional(v.id("executions")),
    requestedByAgentId: v.optional(v.id("agents")),
    command: v.string(),
    args: v.array(v.string()),
    workspaceRoot: v.optional(v.string()),
    workerId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args
  ): Promise<{ status: "auto" | "pending"; approvalId: string; reason: string; offerAlways: boolean }> => {
    return await ctx.runMutation(internal.commandApprovals.request, withoutToken(args));
  },
});

export const getCommandApproval = action({
  args: { ...tokenArg, approvalId: v.id("approvals") },
  handler: async (
    ctx,
    args
  ): Promise<{ status: string; decision: "allow" | "always" | "deny" | null; note: string | null; taskStatus: string | null } | null> => {
    return await ctx.runQuery(internal.commandApprovals.get, withoutToken(args));
  },
});

export const cancelCommandApproval = action({
  args: { ...tokenArg, approvalId: v.id("approvals"), reason: v.string() },
  handler: async (ctx, args): Promise<{ applied: boolean }> => {
    return await ctx.runMutation(internal.commandApprovals.cancel, withoutToken(args));
  },
});

/** The waiter saw the decision: consume its durable signal (taskSignals.ts). */
export const ackCommandApproval = action({
  args: { ...tokenArg, approvalId: v.id("approvals"), workerId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ consumed: number }> => {
    return await ctx.runMutation(internal.commandApprovals.ack, withoutToken(args));
  },
});

/**
 * Plan 020: approve automatically under the task's permission mode. The
 * backend re-checks the mode from the task row; when it does not allow it
 * nothing is written and `autoApproved` is false.
 */
export const autoApprove = action({
  args: {
    ...tokenArg,
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
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
    workerId: v.optional(v.string()),
    risk: v.optional(
      v.object({
        deletes: v.optional(v.number()),
        policyFlagged: v.optional(v.boolean()),
        outsideWorkspace: v.optional(v.boolean()),
      })
    ),
  },
  handler: async (
    ctx,
    args
  ): Promise<{ autoApproved: boolean; reason: string; mode: "supervised" | "auto_edits" | "full_access"; approvalId?: string }> => {
    return await ctx.runMutation(internal.orchestration.autoApprove, {
      ...withoutToken(args),
    });
  },
});

/**
 * Plan 015: broker verdict for a risky action (Allow/Deny/Ask).
 * `targetPaths` (every file in the batch, absolute or workspace-relative),
 * `planVersion` and `workspaceRoot` (the worker's resolved absolute root)
 * are optional; `targetPath` alone keeps working.
 */
export const checkPermission = action({
  args: {
    ...tokenArg,
    ...permissionArgs,
  },
  handler: async (ctx, args): Promise<{ decision: "allow" | "deny" | "ask"; reason: string; approvalId?: string }> => {
    return await ctx.runQuery(internal.orchestration.checkPermission, {
      ...withoutToken(args),
    });
  },
});

export const getResumable = action({
  args: { ...tokenArg },
  handler: async (ctx, args): Promise<any> => {
    withoutToken(args);
    return await ctx.runQuery(internal.orchestration.getResumableTasks, {});
  },
});

export const claimResumable = action({
  args: { ...tokenArg, taskId: v.id("tasks"), workerId: v.string(), leaseMs: v.optional(v.number()) },
  handler: async (ctx, args): Promise<any> => {
    const { taskId, workerId, leaseMs } = withoutToken(args);
    return await ctx.runMutation(internal.orchestration.claimResumableTask, { taskId, workerId, leaseMs });
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
    workerId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runMutation(
      internal.orchestration.saveFileChange,
      withoutToken(args)
    );
  },
});

export const discardFileChange = action({
  args: {
    ...tokenArg,
    taskId: v.id("tasks"),
    filePath: v.string(),
    workerId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runMutation(
      internal.orchestration.discardFileChange,
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
    workerId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    const { taskId, status, errorMessage, workerId } = withoutToken(args);
    return await ctx.runMutation(internal.orchestration.completeTask, {
      taskId,
      status,
      errorMessage,
      workerId,
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

// Plan 013 step 4: the worker pauses a task for a user answer.
export const pauseForInput = action({
  args: {
    ...tokenArg,
    taskId: v.id("tasks"),
    question: v.string(),
    options: v.optional(v.array(v.string())),
    workerId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    const { taskId, question, options, workerId } = withoutToken(args);
    return await ctx.runMutation(internal.orchestration.pauseForInput, {
      taskId,
      question,
      options,
      workerId,
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
    agentId: v.optional(v.id("agents")),
    message: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<any> => {
    const input = withoutToken(args);
    // Raw event payload for local flow debugging. The service token is removed
    // by withoutToken(args) and is intentionally never logged.
    console.info("[worker.logEvent.raw]", JSON.stringify(input));
    await ctx.runMutation(internal.orchestration.logEvent, input);
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
    const input = withoutToken(args);
    // Raw message payload for local flow debugging. The service token is
    // removed by withoutToken(args) and is intentionally never logged.
    console.info("[worker.appendAgentMessage.raw]", JSON.stringify(input));
    return await ctx.runMutation(internal.orchestration.appendAgentMessage, input);
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
    // Runs trace: which execution attempt / subtask made the call.
    executionId: v.optional(v.id("executions")),
    subtaskKey: v.optional(v.string()),
    /** Counts are a chars/4 estimate (provider omitted usage). */
    estimated: v.optional(v.boolean()),
    // Plan 040 P3 ledger fields (all optional).
    ...usageLedgerFields,
  },
  handler: async (ctx, args): Promise<any> => {
    await ctx.runMutation(
      internal.orchestration.recordTokenUsage,
      withoutToken(args)
    );
  },
});

/**
 * Context Snapshot of one worker LLM call (planner, decision, executor,
 * reviewer, QA). Already redacted and capped by the worker; the internal
 * mutation re-applies both and honors CONTEXT_SNAPSHOTS=0.
 */
export const recordContextSnapshot = action({
  args: {
    ...tokenArg,
    ...snapshotRecordArgs,
  },
  handler: async (ctx, args): Promise<any> => {
    await ctx.runMutation(internal.contextSnapshots.record, withoutToken(args));
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

/** Undelivered user inputs (steer / answer) for a task, oldest first. */
export const listPendingTaskInputs = action({
  args: { ...tokenArg, taskId: v.id("tasks") },
  handler: async (ctx, args): Promise<Array<{ _id: string; kind: "steer" | "answer"; text: string; createdAt: number }>> => {
    const { taskId } = withoutToken(args);
    return await ctx.runQuery(internal.orchestration.listPendingTaskInputs, { taskId });
  },
});

/** Acknowledge inputs the worker actually rendered into an agent prompt. */
export const markTaskInputsDelivered = action({
  args: { ...tokenArg, inputIds: v.array(v.id("taskInputs")) },
  handler: async (ctx, args): Promise<{ marked: number }> => {
    const { inputIds } = withoutToken(args);
    return await ctx.runMutation(internal.orchestration.markTaskInputsDelivered, { inputIds });
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

// Plan 006 Phase 4: durable queue — messages claimed with the task lease
// pattern (worker-facing and token-gated like claimTask).
export const claimNextMessage = action({
  args: {
    ...tokenArg,
    workerId: v.string(),
    leaseMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    const { workerId, leaseMs } = withoutToken(args);
    return await ctx.runMutation(internal.messages.claimNextMessage, {
      workerId,
      leaseMs,
    });
  },
});

export const completeMessage = action({
  args: { ...tokenArg, messageId: v.id("messages"), workerId: v.string() },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runMutation(internal.messages.completeMessage, withoutToken(args));
  },
});

export const failMessage = action({
  args: { ...tokenArg, messageId: v.id("messages"), workerId: v.string(), error: v.string() },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runMutation(internal.messages.failMessage, withoutToken(args));
  },
});

export const retryMessage = action({
  args: { ...tokenArg, messageId: v.id("messages") },
  handler: async (ctx, args): Promise<any> => {
    const { messageId } = withoutToken(args);
    return await ctx.runMutation(internal.messages.retryMessage, { messageId });
  },
});

export const cancelMessage = action({
  args: { ...tokenArg, messageId: v.id("messages") },
  handler: async (ctx, args): Promise<any> => {
    const { messageId } = withoutToken(args);
    return await ctx.runMutation(internal.messages.cancelMessage, { messageId });
  },
});

export const recoverStaleMessages = action({
  args: { ...tokenArg, workerId: v.string() },
  handler: async (ctx, args): Promise<any> => {
    const { workerId } = withoutToken(args);
    return await ctx.runMutation(internal.messages.recoverStaleMessages, { workerId });
  },
});

// Plan 007 Phase 1: MCP server config. Plan 009 adds the worker-facing
// fields (enabled/autoConnect/transport/allowedDirectories) and the
// status report action.
export const addMcpServer = action({
  args: {
    ...tokenArg,
    projectId: v.optional(v.id("projects")),
    name: v.string(),
    type: v.union(v.literal("local"), v.literal("remote")),
    url: v.optional(v.string()),
    command: v.optional(v.string()),
    args: v.optional(v.string()),
    enabled: v.optional(v.boolean()),
    autoConnect: v.optional(v.boolean()),
    transport: v.optional(v.string()),
    allowedDirectories: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runMutation(internal.mcpServers.add, withoutToken(args));
  },
});

// Integrations page: preset-based MCP writes. Reached only through the
// Next.js server route (apps/web/app/api/mcp-servers), which injects the
// service token; env values arrive in plaintext and are sealed by the
// mutation before they are stored.
const mcpEditableArgs = {
  name: v.optional(v.string()),
  fields: v.optional(v.record(v.string(), v.string())),
  env: v.optional(v.record(v.string(), v.string())),
  agentRoles: v.optional(v.array(v.string())),
  toolAllowlist: v.optional(v.array(v.string())),
  enabled: v.optional(v.boolean()),
  autoConnect: v.optional(v.boolean()),
  useGithubOAuth: v.optional(v.boolean()),
  type: v.optional(v.union(v.literal("local"), v.literal("remote"))),
  command: v.optional(v.string()),
  commandArgs: v.optional(v.array(v.string())),
  url: v.optional(v.string()),
};

export const createMcpServerFromPreset = action({
  args: { ...tokenArg, presetId: v.string(), projectId: v.optional(v.id("projects")), ...mcpEditableArgs },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runMutation(internal.mcpServers.createFromPreset, withoutToken(args));
  },
});

export const updateMcpServer = action({
  args: {
    ...tokenArg,
    serverId: v.id("mcpServers"),
    projectId: v.optional(v.union(v.id("projects"), v.null())),
    removeEnvKeys: v.optional(v.array(v.string())),
    ...mcpEditableArgs,
  },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runMutation(internal.mcpServers.update, withoutToken(args));
  },
});

export const setMcpServerEnabled = action({
  args: { ...tokenArg, serverId: v.id("mcpServers"), enabled: v.boolean() },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runMutation(internal.mcpServers.setEnabled, withoutToken(args));
  },
});

export const requestMcpServerTest = action({
  args: { ...tokenArg, serverId: v.id("mcpServers") },
  handler: async (ctx, args): Promise<{ queued: boolean; message?: string }> => {
    return await ctx.runMutation(internal.mcpServers.requestTest, withoutToken(args));
  },
});

export const claimMcpServerTest = action({
  args: { ...tokenArg, workerId: v.string(), leaseMs: v.optional(v.number()) },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runMutation(internal.mcpServers.claimTest, withoutToken(args));
  },
});

export const completeMcpServerTest = action({
  args: {
    ...tokenArg,
    serverId: v.id("mcpServers"),
    workerId: v.string(),
    ok: v.boolean(),
    toolNames: v.optional(v.array(v.string())),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    return await ctx.runMutation(internal.mcpServers.completeTest, withoutToken(args));
  },
});

// Grounded chat: read-only repo tool calls queued by the chat action
// (repoTools.ts). The worker runs them inside the project workspace.
export const claimRepoToolCall = action({
  args: { ...tokenArg, workerId: v.string() },
  handler: async (
    ctx,
    args
  ): Promise<{ callId: string; tool: string; args: string; workspacePath: string | null } | null> => {
    return await ctx.runMutation(internal.repoTools.claimNext, withoutToken(args));
  },
});

export const completeRepoToolCall = action({
  args: {
    ...tokenArg,
    callId: v.id("repoToolCalls"),
    workerId: v.string(),
    ok: v.boolean(),
    result: v.string(),
    files: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<boolean> => {
    return await ctx.runMutation(internal.repoTools.complete, withoutToken(args));
  },
});

export const removeMcpServer = action({
  args: { ...tokenArg, serverId: v.id("mcpServers") },
  handler: async (ctx, args): Promise<any> => {
    const { serverId } = withoutToken(args);
    return await ctx.runMutation(internal.mcpServers.remove, { serverId });
  },
});

export const updateMcpServerStatus = action({
  args: {
    ...tokenArg,
    serverId: v.id("mcpServers"),
    status: v.union(v.literal("connected"), v.literal("disconnected"), v.literal("error"), v.literal("untested")),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runMutation(internal.mcpServers.updateStatus, withoutToken(args));
  },
});



// Plan 019: stage cards and the GitHub push flow. Card/commit writes are
// lease-fenced through `workerId` like every other task write; push
// requests are claimed with their own lease (githubPush.claimPushRequest).
export const postTaskCard = action({
  args: {
    ...tokenArg,
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    workerId: v.optional(v.string()),
    agentId: v.optional(v.id("agents")),
    kind: v.union(v.literal("verification"), v.literal("qa"), v.literal("changes")),
    content: v.optional(v.string()),
    data: v.any(),
  },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runMutation(internal.githubPush.postTaskCard, withoutToken(args));
  },
});

export const recordTaskCommit = action({
  args: {
    ...tokenArg,
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    workerId: v.optional(v.string()),
    agentId: v.optional(v.id("agents")),
    branchName: v.string(),
    commitSha: v.string(),
    commitMessage: v.string(),
    filesChanged: v.number(),
    additions: v.optional(v.number()),
    deletions: v.optional(v.number()),
    ahead: v.optional(v.number()),
    behind: v.optional(v.number()),
    comparedTo: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runMutation(internal.githubPush.recordTaskCommit, withoutToken(args));
  },
});

/**
 * Claim the next approved push request. The result carries the project's
 * GitHub token for the push; the worker passes it to git through the
 * environment only and never logs it.
 */
export const claimPushRequest = action({
  args: { ...tokenArg, workerId: v.string(), leaseMs: v.optional(v.number()) },
  handler: async (ctx, args): Promise<any> => {
    const { workerId, leaseMs } = withoutToken(args);
    return await ctx.runMutation(internal.githubPush.claimPushRequest, { workerId, leaseMs });
  },
});

export const completePushRequest = action({
  args: {
    ...tokenArg,
    pushId: v.id("taskPushes"),
    workerId: v.string(),
    outcome: v.union(v.literal("pushed"), v.literal("failed")),
    error: v.optional(v.string()),
    pr: v.optional(
      v.object({
        number: v.number(),
        url: v.string(),
        title: v.string(),
        state: v.union(v.literal("draft"), v.literal("open"), v.literal("merged"), v.literal("closed")),
      })
    ),
    repoFullName: v.optional(v.string()),
    baseBranch: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runMutation(internal.githubPush.completePushRequest, withoutToken(args));
  },
});

// ─── Workload Manager (orgIntel.ts) ──────────────────────────────────────

/** Running executions per agent across every task (load-aware routing). */
export const getAgentLoad = action({
  args: { ...tokenArg },
  handler: async (ctx, args): Promise<Record<string, number>> => {
    withoutToken(args);
    return await ctx.runQuery(internal.orgIntel.agentLoad, {});
  },
});

/** Plan 027: per-agent, per-capability performance scores for one project. */
export const getPerformanceScores = action({
  args: { ...tokenArg, projectId: v.id("projects"), sinceDays: v.optional(v.number()) },
  handler: async (ctx, args): Promise<any> => {
    const { projectId, sinceDays } = withoutToken(args);
    return await ctx.runQuery(internal.agentPerformance.scoresForProject, { projectId, ...(sinceDays ? { sinceDays } : {}) });
  },
});

// ─── Plan Inspector + Task Estimator (planReview.ts) ─────────────────────

/** Recent per-subtask usage samples for the estimator (lib/estimate.ts). */
export const getEstimateSamples = action({
  args: { ...tokenArg, projectId: v.id("projects") },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runQuery(internal.planReview.estimateSamples, withoutToken(args));
  },
});

/** Pause the run after plan.created: a `plan` approval + the Plan card. */
export const requestPlanReview = action({
  args: {
    ...tokenArg,
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    planVersion: v.number(),
    reason: v.optional(v.string()),
    workerId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runMutation(internal.planReview.requestReview, withoutToken(args));
  },
});

// ---------------------------------------------------------------------------
// Plan 022: subtask acceptance + user pause (worker side).
// ---------------------------------------------------------------------------

export const recordSubtaskAcceptance = action({
  args: {
    ...tokenArg,
    taskId: v.id("tasks"),
    key: v.string(),
    acceptanceStatus: acceptanceStatusValidator,
    acceptanceReason: v.optional(v.string()),
    gateResults: v.optional(v.array(gateResultValidator)),
    escalation: v.optional(escalationValidator),
    workerId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ applied: boolean; reason?: string }> => {
    return await ctx.runMutation(internal.contracts.recordSubtaskAcceptance, withoutToken(args));
  },
});

/** Plan 025: the requirement coverage check before "done". Lease-fenced. */
export const recordRequirementCoverage = action({
  args: {
    ...tokenArg,
    taskId: v.id("tasks"),
    outcome: v.union(v.literal("covered"), v.literal("gaps"), v.literal("completed_with_gaps")),
    covered: v.array(v.string()),
    missingEvidence: v.array(v.string()),
    uncovered: v.array(v.string()),
    workerId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ applied: boolean; reason?: string }> => {
    return await ctx.runMutation(internal.traceability.recordRequirementCoverage, withoutToken(args));
  },
});

export const releasePausedTask = action({
  args: { ...tokenArg, taskId: v.id("tasks"), workerId: v.string() },
  handler: async (ctx, args): Promise<{ result: string }> => {
    return await ctx.runMutation(internal.taskControl.releasePausedTask, withoutToken(args));
  },
});
