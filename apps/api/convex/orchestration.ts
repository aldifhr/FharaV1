import { internalMutation, internalQuery, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  taskStatus,
  subtaskKind,
  subtaskStatus,
  executionStatus,
} from "./schema";

const DEFAULT_LEASE_MS = 60_000;

export const getRunContext = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (
    ctx,
    args
  ): Promise<{
    task: Doc<"tasks">;
    project: Doc<"projects"> | null;
    agents: Doc<"agents">[];
    plan: Doc<"plans"> | null;
    subtasks: Doc<"subtasks">[];
    approvalMode: "ask" | "auto";
  } | null> => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return null;
    const project = await ctx.db.get(task.projectId);
    const allAgents = await ctx.db.query("agents").collect();
    const agents = project?.agentIds
      ? allAgents.filter((agent) => project.agentIds?.includes(agent._id))
      : allAgents;
    const plans = await ctx.db
      .query("plans")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .order("desc")
      .take(1);
    const subtasks = await ctx.db
      .query("subtasks")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .order("asc")
      .collect();
    return {
      task,
      project,
      agents,
      plan: plans[0] ?? null,
      subtasks,
      approvalMode: project?.approvalMode === "auto" ? "auto" : "ask",
    };
  },
});

export const claimNextTask = internalMutation({
  args: {
    workerId: v.string(),
    leaseMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Doc<"tasks"> | null> => {
    const now = Date.now();
    const leaseMs = args.leaseMs ?? DEFAULT_LEASE_MS;
    const candidates = await ctx.db
      .query("tasks")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .order("asc")
      .take(25);
    const task = candidates.find((candidate) => candidate.status === "queued");
    if (!task) return null;
    await ctx.db.patch(task._id, {
      status: "running",
      workerId: args.workerId,
      leaseExpiresAt: now + leaseMs,
      startedAt: task.startedAt ?? now,
      updatedAt: now,
      errorMessage: undefined,
    });
    await ctx.db.insert("taskEvents", {
      taskId: task._id,
      projectId: task.projectId,
      type: "task.claimed",
      payload: { workerId: args.workerId },
      level: "info",
    });
    return { ...task, status: "running", workerId: args.workerId, leaseExpiresAt: now + leaseMs };
  },
});

export const heartbeat = internalMutation({
  args: {
    workerId: v.string(),
    hostname: v.optional(v.string()),
    capacity: v.number(),
    activeTasks: v.number(),
    leaseMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const leaseMs = args.leaseMs ?? DEFAULT_LEASE_MS;
    const existing = await ctx.db
      .query("workers")
      .withIndex("by_worker_id", (q) => q.eq("workerId", args.workerId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        hostname: args.hostname ?? existing.hostname,
        capacity: args.capacity,
        activeTasks: args.activeTasks,
        status: "online",
        lastHeartbeatAt: now,
      });
    } else {
      await ctx.db.insert("workers", {
        workerId: args.workerId,
        hostname: args.hostname,
        capacity: args.capacity,
        activeTasks: args.activeTasks,
        status: "online",
        lastHeartbeatAt: now,
      });
    }

    const owned = await ctx.db
      .query("tasks")
      .withIndex("by_worker", (q) => q.eq("workerId", args.workerId))
      .collect();
    for (const task of owned) {
      if (task.status === "running") {
        await ctx.db.patch(task._id, {
          leaseExpiresAt: now + leaseMs,
          updatedAt: now,
        });
      }
    }

    const executions = await ctx.db
      .query("executions")
      .withIndex("by_worker", (q) => q.eq("workerId", args.workerId))
      .collect();
    for (const execution of executions) {
      if (execution.status === "running" || execution.status === "queued") {
        await ctx.db.patch(execution._id, { leaseExpiresAt: now + leaseMs });
      }
    }
    return { now };
  },
});

export const markWorkerOffline = internalMutation({
  args: { workerId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("workers")
      .withIndex("by_worker_id", (q) => q.eq("workerId", args.workerId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { status: "offline", activeTasks: 0 });
    }
  },
});

export const recoverStale = internalMutation({
  args: {
    now: v.number(),
    staleGraceMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const staleGraceMs = args.staleGraceMs ?? 30_000;
    const recovered: string[] = [];

    const workers = await ctx.db.query("workers").collect();
    const aliveWorkers = new Set(
      workers
        .filter((worker) => args.now - worker.lastHeartbeatAt < staleGraceMs)
        .map((worker) => worker.workerId)
    );

    const running = await ctx.db
      .query("tasks")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .collect();
    for (const task of running) {
      const leaseExpired = !task.leaseExpiresAt || task.leaseExpiresAt < args.now;
      const workerAlive = task.workerId ? aliveWorkers.has(task.workerId) : false;
      if (!leaseExpired && workerAlive) continue;

      await ctx.db.patch(task._id, {
        status: "failed",
        errorMessage: task.workerId
          ? `Worker lease expired (worker: ${task.workerId})`
          : "Worker lease missing",
        workerId: undefined,
        leaseExpiresAt: undefined,
        completedAt: args.now,
        updatedAt: args.now,
      });
      await ctx.db.insert("taskEvents", {
        taskId: task._id,
        projectId: task.projectId,
        type: "task.recovered",
        payload: { reason: "stale_lease", workerId: task.workerId ?? null },
        level: "warn",
      });
      recovered.push(task._id);
    }

    const executions = await ctx.db
      .query("executions")
      .withIndex("by_status_and_lease", (q) =>
        q.eq("status", "running").lt("leaseExpiresAt", args.now)
      )
      .collect();
    for (const execution of executions) {
      await ctx.db.patch(execution._id, {
        status: "failed",
        error: "Worker lease expired during execution",
        completedAt: args.now,
      });
      await refreshAgentStatus(ctx, execution.agentId);
    }

    for (const worker of workers) {
      if (args.now - worker.lastHeartbeatAt >= staleGraceMs && worker.status === "online") {
        await ctx.db.patch(worker._id, { status: "offline", activeTasks: 0 });
      }
    }

    return { recoveredTasks: recovered.length, recoveredExecutions: executions.length };
  },
});

export const setPlanning = internalMutation({
  args: {
    taskId: v.id("tasks"),
    classification: v.string(),
    strategy: v.string(),
    planVersion: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.taskId, {
      classification: args.classification,
      strategy: args.strategy,
      planVersion: args.planVersion,
      updatedAt: Date.now(),
    });
  },
});

export const savePlan = internalMutation({
  args: {
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
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("plans")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();
    for (const plan of existing) await ctx.db.delete(plan._id);

    await ctx.db.insert("plans", {
      taskId: args.taskId,
      projectId: args.projectId,
      version: args.version,
      strategy: args.strategy,
      createdBy: args.createdBy,
      goal: args.goal,
      payload: args.payload,
      createdAt: now,
    });

    const oldSubtasks = await ctx.db
      .query("subtasks")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();
    for (const subtask of oldSubtasks) await ctx.db.delete(subtask._id);

    for (const subtask of args.subtasks) {
      await ctx.db.insert("subtasks", {
        taskId: args.taskId,
        projectId: args.projectId,
        key: subtask.key,
        title: subtask.title,
        description: subtask.description,
        kind: subtask.kind,
        capability: subtask.capability,
        dependencies: subtask.dependencies,
        order: subtask.order,
        status: "pending",
        attempts: 0,
      });
    }

    await ctx.db.patch(args.taskId, {
      planVersion: args.version,
      strategy: args.strategy,
      updatedAt: now,
      errorMessage: undefined,
    });
    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      projectId: args.projectId,
      type: "plan.created",
      payload: {
        version: args.version,
        strategy: args.strategy,
        createdBy: args.createdBy,
        subtasks: args.subtasks.map((subtask) => subtask.key),
      },
      level: "info",
    });
    return args.version;
  },
});

export const startExecution = internalMutation({
  args: {
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
  handler: async (ctx, args): Promise<Id<"executions">> => {
    const now = Date.now();
    const leaseMs = args.leaseMs ?? DEFAULT_LEASE_MS;
    const subtask = await ctx.db
      .query("subtasks")
      .withIndex("by_task_and_key", (q) =>
        q.eq("taskId", args.taskId).eq("key", args.subtaskKey)
      )
      .unique();

    if (subtask) {
      await ctx.db.patch(subtask._id, {
        status: "running",
        assignedAgentId: args.agentId,
        assignedAgentName: args.agentName,
        attempts: args.attempt,
        startedAt: now,
      });
    } else {
      await ctx.db.insert("subtasks", {
        taskId: args.taskId,
        projectId: args.projectId,
        key: args.subtaskKey,
        title: args.subtaskKey,
        description: "",
        kind: "analysis",
        capability: args.capability,
        dependencies: [],
        order: 0,
        status: "running",
        assignedAgentId: args.agentId,
        assignedAgentName: args.agentName,
        attempts: args.attempt,
        startedAt: now,
      });
    }

    const executionId = await ctx.db.insert("executions", {
      taskId: args.taskId,
      projectId: args.projectId,
      subtaskId: subtask?._id,
      subtaskKey: args.subtaskKey,
      agentId: args.agentId,
      agentName: args.agentName,
      capability: args.capability,
      workerId: args.workerId,
      status: "running",
      attempt: args.attempt,
      leaseExpiresAt: now + leaseMs,
      startedAt: now,
      createdAt: now,
    });

    if (args.agentId) {
      const agent = await ctx.db.get(args.agentId);
      if (agent && agent.status !== "needs_you") {
        await ctx.db.patch(args.agentId, { status: "working" });
      }
    }

    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      projectId: args.projectId,
      type: "subtask.started",
      payload: {
        subtaskKey: args.subtaskKey,
        agent: args.agentName,
        capability: args.capability,
        attempt: args.attempt,
      },
      executionId,
      subtaskKey: args.subtaskKey,
      level: "info",
    });

    return executionId;
  },
});

export const updateExecution = internalMutation({
  args: {
    executionId: v.id("executions"),
    subtaskKey: v.optional(v.string()),
    status: executionStatus,
    output: v.optional(v.string()),
    error: v.optional(v.string()),
    meta: v.optional(v.any()),
    leaseMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const execution = await ctx.db.get(args.executionId);
    if (!execution) throw new Error("Execution not found");
    const subtaskKey = args.subtaskKey ?? execution.subtaskKey;

    await ctx.db.patch(args.executionId, {
      status: args.status,
      output: args.output ?? execution.output,
      error: args.error,
      meta: args.meta ?? execution.meta,
      leaseExpiresAt:
        args.status === "running" || args.status === "queued"
          ? now + (args.leaseMs ?? DEFAULT_LEASE_MS)
          : undefined,
      completedAt:
        args.status === "completed" || args.status === "failed" || args.status === "cancelled"
          ? now
          : undefined,
    });

    if (subtaskKey) {
      const subtask = await ctx.db
        .query("subtasks")
        .withIndex("by_task_and_key", (q) =>
          q.eq("taskId", execution.taskId).eq("key", subtaskKey)
        )
        .unique();
      if (subtask) {
        const mapped =
          args.status === "completed"
            ? "completed"
            : args.status === "failed"
              ? "failed"
              : args.status === "waiting_approval"
                ? "waiting_approval"
                : args.status === "cancelled"
                  ? "blocked"
                  : "running";
        await ctx.db.patch(subtask._id, {
          status: mapped,
          output: args.output ?? subtask.output,
          error: args.error,
          completedAt:
            mapped === "completed" || mapped === "failed" ? now : undefined,
        });
      }
    }

    await refreshAgentStatus(ctx, execution.agentId);

    await ctx.db.insert("taskEvents", {
      taskId: execution.taskId,
      projectId: execution.projectId,
      type: `subtask.${args.status}`,
      payload: {
        subtaskKey,
        agent: execution.agentName,
        ...(args.error ? { error: args.error.slice(0, 500) } : {}),
      },
      executionId: args.executionId,
      subtaskKey: subtaskKey ?? undefined,
      level: args.status === "failed" ? "error" : "info",
    });
  },
});

export const requestApproval = internalMutation({
  args: {
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
  handler: async (ctx, args): Promise<Id<"approvals">> => {
    const now = Date.now();
    const existing = await ctx.db
      .query("approvals")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();
    const pending = existing.find(
      (approval) =>
        approval.status === "pending" &&
        approval.kind === args.kind &&
        (approval.subtaskKey ?? null) === (args.subtaskKey ?? null)
    );
    if (pending) return pending._id;

    const approvalId = await ctx.db.insert("approvals", {
      taskId: args.taskId,
      projectId: args.projectId,
      kind: args.kind,
      summary: args.summary,
      payload: args.payload,
      requestedByAgentId: args.requestedByAgentId,
      executionId: args.executionId,
      subtaskKey: args.subtaskKey,
      planVersion: args.planVersion,
      status: "pending",
    });

    await ctx.db.patch(args.taskId, {
      status: "needs_approval",
      updatedAt: now,
      workerId: undefined,
      leaseExpiresAt: undefined,
    });

    if (args.executionId) {
      await ctx.db.patch(args.executionId, {
        status: "waiting_approval",
        leaseExpiresAt: undefined,
      });
    }
    if (args.subtaskKey) {
      const subtask = await ctx.db
        .query("subtasks")
        .withIndex("by_task_and_key", (q) =>
          q.eq("taskId", args.taskId).eq("key", args.subtaskKey as string)
        )
        .unique();
      if (subtask) await ctx.db.patch(subtask._id, { status: "waiting_approval" });
    }

    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      projectId: args.projectId,
      type: "approval.requested",
      payload: { kind: args.kind, summary: args.summary, subtaskKey: args.subtaskKey },
      executionId: args.executionId,
      subtaskKey: args.subtaskKey,
      level: "warn",
    });
    return approvalId;
  },
});

export const getResumableTasks = internalQuery({
  args: {},
  handler: async (ctx) => {
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_status", (q) => q.eq("status", "needs_approval"))
      .collect();
    const results = [];
    for (const task of tasks) {
      const approvals = await ctx.db
        .query("approvals")
        .withIndex("by_task", (q) => q.eq("taskId", task._id))
        .collect();
      const pending = approvals.filter((approval) => approval.status === "pending");
      const resolved = approvals.filter((approval) => approval.status !== "pending");
      results.push({ task, pendingCount: pending.length, approvals: resolved });
    }
    return results;
  },
});

export const getTaskApprovals = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("approvals")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();
  },
});

export const getTaskFileChanges = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("fileChanges")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();
  },
});

export const saveFileChange = internalMutation({
  args: {
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
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("fileChanges")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();
    const match = existing.find((change) => change.filePath === args.filePath);
    if (match) {
      await ctx.db.patch(match._id, { ...args });
      return match._id;
    }
    return await ctx.db.insert("fileChanges", args);
  },
});

export const markFileChangesApplied = internalMutation({
  args: {
    taskId: v.id("tasks"),
    filePaths: v.array(v.string()),
    workerId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const changes = await ctx.db
      .query("fileChanges")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();
    for (const change of changes) {
      if (!args.filePaths.includes(change.filePath)) continue;
      await ctx.db.patch(change._id, {
        appliedAt: now,
        appliedByWorkerId: args.workerId,
      });
    }
  },
});

export const completeTask = internalMutation({
  args: {
    taskId: v.id("tasks"),
    status: taskStatus,
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.patch(args.taskId, {
      status: args.status,
      errorMessage: args.errorMessage,
      completedAt: now,
      updatedAt: now,
      workerId: undefined,
      leaseExpiresAt: undefined,
    });
    const task = await ctx.db.get(args.taskId);
    if (task) {
      await ctx.db.insert("taskEvents", {
        taskId: task._id,
        projectId: task.projectId,
        type: `task.${args.status}`,
        payload: args.errorMessage ? { error: args.errorMessage.slice(0, 500) } : {},
        level: args.status === "failed" ? "error" : "info",
      });
      const executions = await ctx.db
        .query("executions")
        .withIndex("by_task", (q) => q.eq("taskId", task._id))
        .collect();
      const agentIds = new Set(
        executions
          .map((execution) => execution.agentId)
          .filter((agentId): agentId is Id<"agents"> => Boolean(agentId))
      );
      for (const agentId of agentIds) await refreshAgentStatus(ctx, agentId);
    }
  },
});

export const setTaskStatus = internalMutation({
  args: { taskId: v.id("tasks"), status: taskStatus },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.taskId, { status: args.status, updatedAt: Date.now() });
  },
});

export const updateSubtask = internalMutation({
  args: {
    taskId: v.id("tasks"),
    key: v.string(),
    status: subtaskStatus,
    output: v.optional(v.string()),
    error: v.optional(v.string()),
    agentId: v.optional(v.id("agents")),
    agentName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const subtask = await ctx.db
      .query("subtasks")
      .withIndex("by_task_and_key", (q) =>
        q.eq("taskId", args.taskId).eq("key", args.key)
      )
      .unique();
    if (!subtask) return false;
    await ctx.db.patch(subtask._id, {
      status: args.status,
      output: args.output ?? subtask.output,
      error: args.error,
      assignedAgentId: args.agentId ?? subtask.assignedAgentId,
      assignedAgentName: args.agentName ?? subtask.assignedAgentName,
      completedAt:
        args.status === "completed" || args.status === "failed"
          ? Date.now()
          : undefined,
    });
    return true;
  },
});

export const recordEvaluation = internalMutation({
  args: {
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
  handler: async (ctx, args) => {
    await ctx.db.insert("evaluations", { ...args, createdAt: Date.now() });
    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      projectId: args.projectId,
      type: "evaluation.completed",
      payload: { verdict: args.verdict, notes: args.notes ?? null },
      level: args.verdict === "failed" ? "error" : "info",
    });
  },
});

export const logEvent = internalMutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    type: v.string(),
    payload: v.optional(v.any()),
    executionId: v.optional(v.id("executions")),
    subtaskKey: v.optional(v.string()),
    level: v.optional(v.union(v.literal("info"), v.literal("warn"), v.literal("error"))),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("taskEvents", args);
  },
});

export const appendAgentMessage = internalMutation({
  args: {
    projectId: v.id("projects"),
    taskId: v.id("tasks"),
    agentId: v.optional(v.id("agents")),
    content: v.string(),
    subtaskKey: v.optional(v.string()),
    executionId: v.optional(v.id("executions")),
  },
  handler: async (ctx, args) => {
    if (!args.content.trim()) return null;
    return await ctx.db.insert("messages", {
      projectId: args.projectId,
      taskId: args.taskId,
      agentId: args.agentId,
      authorType: "agent",
      content: args.content,
      subtaskKey: args.subtaskKey,
      executionId: args.executionId,
    });
  },
});

async function refreshAgentStatus(
  ctx: { db: any },
  agentId: Id<"agents"> | undefined
): Promise<void> {
  if (!agentId) return;
  const agent = await ctx.db.get(agentId);
  if (!agent || agent.status === "needs_you") return;
  const executions = await ctx.db
    .query("executions")
    .withIndex("by_agent", (q: any) => q.eq("agentId", agentId))
    .collect();
  const busy = executions.some(
    (execution: Doc<"executions">) =>
      execution.status === "running" ||
      execution.status === "queued" ||
      execution.status === "waiting_approval"
  );
  const nextStatus = busy ? "working" : "idle";
  if (agent.status !== nextStatus) {
    await ctx.db.patch(agentId, { status: nextStatus });
  }
}

export const recordTokenUsage = internalMutation({
  args: {
    projectId: v.id("projects"),
    taskId: v.optional(v.id("tasks")),
    agentId: v.optional(v.id("agents")),
    agentName: v.string(),
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("tokenUsage", {
      projectId: args.projectId,
      taskId: args.taskId,
      agentId: args.agentId,
      agentName: args.agentName,
      model: args.model,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      createdAt: Date.now(),
    });
  },
});

export const tokenUsageStats = query({
  args: {},
  handler: async (ctx) => {
    const records = await ctx.db.query("tokenUsage").collect();
    const byAgent: Record<string, { inputTokens: number; outputTokens: number; calls: number }> = {};
    let totalInput = 0;
    let totalOutput = 0;
    // Bucket by hour: { hourStartUnixSec: tokens }
    const byHour: Record<number, number> = {};
    for (const r of records) {
      if (!byAgent[r.agentName]) {
        byAgent[r.agentName] = { inputTokens: 0, outputTokens: 0, calls: 0 };
      }
      byAgent[r.agentName].inputTokens += r.inputTokens;
      byAgent[r.agentName].outputTokens += r.outputTokens;
      byAgent[r.agentName].calls += 1;
      totalInput += r.inputTokens;
      totalOutput += r.outputTokens;
      const hourStart = Math.floor(r.createdAt / 1000 / 3600) * 3600; // unix seconds, start of hour UTC
      byHour[hourStart] = (byHour[hourStart] ?? 0) + r.inputTokens + r.outputTokens;
    }
    // Cumulative timeline for the chart
    const sortedHours = Object.keys(byHour)
      .map(Number)
      .sort((a, b) => a - b);
    const nowSec = Math.floor(Date.now() / 1000);
    // Liveline needs >=2 points to draw; seed with a zero baseline 24h back
    const seedStart = nowSec - 24 * 3600;
    let cumulative = 0;
    const timeline: { time: number; value: number }[] = [{ time: seedStart, value: 0 }];
    for (const hour of sortedHours) {
      cumulative += byHour[hour];
      timeline.push({ time: hour, value: cumulative });
    }
    if (timeline[timeline.length - 1].time < nowSec) {
      timeline.push({ time: nowSec, value: totalInput + totalOutput });
    }
    return { byAgent, totalInput, totalOutput, totalCalls: records.length, timeline };
  },
});

export const getBranchContext = internalQuery({
  args: { taskId: v.id("tasks"), projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    const project = await ctx.db.get(args.projectId);
    if (!task || !project) throw new Error("Task or project not found");
    return {
      taskTitle: task.title,
      workspacePath: project.workspacePath,
      worktreesPath: project.worktreesPath,
      mainBranch: project.mainBranch,
      projectName: project.name,
      existingBranchName: task.branchName,
      existingWorktreePath: task.worktreePath,
    };
  },
});

export const completeBranchCreation = internalMutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    branchName: v.string(),
    worktreePath: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.taskId, {
      branchName: args.branchName,
      worktreePath: args.worktreePath,
      updatedAt: Date.now(),
    });
    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      projectId: args.projectId,
      type: "branch.created",
      payload: { branchName: args.branchName, worktreePath: args.worktreePath },
      level: "info",
    });
  },
});

export const getDiffContext = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");
    if (!task.worktreePath) throw new Error("No worktreePath for task");
    const project = await ctx.db.get(task.projectId);
    return {
      worktreePath: task.worktreePath,
      branchName: task.branchName ?? "",
      mainBranch: project?.mainBranch ?? "main",
    };
  },
});

export const getMergeContext = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");
    if (!task.branchName || !task.worktreePath) {
      throw new Error("No branch/worktree for this task");
    }
    const project = await ctx.db.get(task.projectId);
    return {
      branchName: task.branchName,
      worktreePath: task.worktreePath,
      workspacePath: project?.workspacePath ?? "",
      mainBranch: project?.mainBranch ?? "main",
      projectId: task.projectId,
    };
  },
});

export const mergeBranchCompleted = internalMutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    branchName: v.string(),
    conflict: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.conflict) {
      await ctx.db.insert("taskEvents", {
        taskId: args.taskId,
        projectId: args.projectId,
        type: "branch.merge_conflict",
        payload: { branchName: args.branchName, error: args.conflict },
        level: "error",
      });
      throw new Error(`Merge failed: ${args.conflict}`);
    }
    await ctx.db.patch(args.taskId, {
      branchName: undefined,
      worktreePath: undefined,
    });
    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      projectId: args.projectId,
      type: "branch.merged",
      payload: { branchName: args.branchName },
      level: "info",
    });
    return { success: true };
  },
});

export const getDiscardContext = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return null;
    const project = await ctx.db.get(task.projectId);
    return {
      workspacePath: project?.workspacePath ?? "",
      worktreePath: task.worktreePath,
      branchName: task.branchName,
      projectId: task.projectId,
    };
  },
});

export const discardBranchDone = internalMutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    branchName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.taskId, {
      branchName: undefined,
      worktreePath: undefined,
    });
    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      projectId: args.projectId,
      type: "branch.discarded",
      payload: { branchName: args.branchName },
      level: "warn",
    });
  },
});

export const cleanupWorktreeContext = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return null;
    const project = await ctx.db.get(task.projectId);
    if (!project) return null;
    return {
      workspacePath: project.workspacePath,
      worktreesPath: project.worktreesPath,
      branchPrefix: `moagent/${args.taskId}/`,
    };
  },
});