import { internalMutation, internalQuery, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { loadProviderPool, type PoolConnectionPayload } from "./llmResolver";
import {
  taskStatus,
  subtaskKind,
  subtaskStatus,
  executionStatus,
} from "./schema";

const DEFAULT_LEASE_MS = 60_000;

/**
 * Phase 4 recovery bound: a stale task with a valid stored plan is
 * requeued at most this many times; beyond that the failure is treated
 * as durable and the task is failed, so a poisoned plan cannot loop
 * through workers forever.
 */
const MAX_TASK_RECOVERIES = 3;

/**
 * Terminal task statuses are ABSORBING (Phase 4 hardening): once a task
 * is done, failed or rejected — user cancellation lands on "failed" via
 * tasks.cancel — no late write (a zombie worker finishing after the
 * fact, a stale completion racing the cancel) may move it back to a
 * live state or overwrite the terminal outcome. The write-layer guards
 * below enforce this in completeTask / setTaskStatus / requestApproval
 * and report a refused write as a VALUE, not an error, so a late worker
 * can stop cleanly instead of crashing on its own completion call.
 */
const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  "done",
  "failed",
  "rejected",
]);

/**
 * Monotonic subtask status (Phase 4 hardening): "completed" is
 * absorbing for late writes. Dynamic-DAG upserts and execution updates
 * can race (two outcomes settling together, a recovery pass overlapping
 * a late update); a completed row must never be rewritten to
 * pending/running/blocked by a write that was issued before the
 * completion landed.
 */
function monotonicSubtaskStatus(
  current: string,
  next: string
): string {
  if (current === "completed" && next !== "completed") return current;
  return next;
}

/**
 * Strip legacy per-agent LLM fields — above all the plaintext `llmApiKey` —
 * before agent rows cross the internal boundary to the worker. The worker
 * never reads them (its toAgentDefinition drops them); returning the raw
 * documents only distributes plaintext credentials needlessly (spec §5).
 */
function projectAgentForWorker(agent: Doc<"agents">): Doc<"agents"> {
  const {
    llmApiKey: _llmApiKey,
    llmApiKeyEnv: _llmApiKeyEnv,
    llmBaseUrl: _llmBaseUrl,
    llmModel: _llmModel,
    llmProvider: _llmProvider,
    ...rest
  } = agent;
  return rest;
}

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
    llmProviders: PoolConnectionPayload[];
    /** Enabled MCP server configs for this project (Plan 009). Config-only. */
    mcpServers: Doc<"mcpServers">[];
  } | null> => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return null;
    const project = await ctx.db.get(task.projectId);
    const allAgents = await ctx.db.query("agents").collect();
    const assigned = task.assignedAgentIds?.length
      ? task.assignedAgentIds
      : project?.agentIds;
    const agents = assigned?.length
      ? allAgents.filter((agent) => assigned.includes(agent._id) && agent.isEnabled !== false)
      : [];
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

    // Provider pool (connections + model registry) assembled by the shared
    // backend helper. Only the ENCRYPTED key crosses to the worker — the
    // worker decrypts on its side (spec §5); plaintext is never returned.
    const llmProviders: PoolConnectionPayload[] = project
      ? await loadProviderPool(ctx)
      : [];
    // MCP config crosses to the worker: name/command/args/allowedDirectories
    // only. There is no credential material in this row; a disabled server is
    // not delivered at all.
    const mcpServers = project
      ? (
          await ctx.db
            .query("mcpServers")
            .withIndex("by_project", (q) => q.eq("projectId", project._id))
            .collect()
        ).filter((row) => row.enabled !== false)
      : [];

    return {
      task,
      project,
      agents: agents.map(projectAgentForWorker),
      plan: plans[0] ?? null,
      subtasks,
      approvalMode: project?.approvalMode === "auto" ? "auto" : "ask",
      llmProviders,
      mcpServers,
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

      // Phase 4 recovery semantics: a stale task is only a loss when
      // there is nothing valid to resume from. When the latest stored
      // plan is structurally valid AND subtask rows exist, the task is
      // REQUEUED (lease cleared, recovery counted) — the next worker to
      // claim it rebuilds state from the DB and skips the subtasks that
      // already completed. It is failed only when no valid plan /
      // checkpoint exists, or the recovery bound has been reached.
      const plans = await ctx.db
        .query("plans")
        .withIndex("by_task", (q) => q.eq("taskId", task._id))
        .order("desc")
        .take(1);
      const latestPlan = plans[0];
      const payload = latestPlan?.payload as
        | { subtasks?: unknown }
        | null
        | undefined;
      const planValid =
        !!latestPlan &&
        Array.isArray(payload?.subtasks) &&
        payload.subtasks.length > 0;
      const subtaskRows = planValid
        ? await ctx.db
            .query("subtasks")
            .withIndex("by_task", (q) => q.eq("taskId", task._id))
            .collect()
        : [];
      const recoveryCount = task.recoveryCount ?? 0;

      if (planValid && subtaskRows.length > 0 && recoveryCount < MAX_TASK_RECOVERIES) {
        await ctx.db.patch(task._id, {
          status: "queued",
          workerId: undefined,
          leaseExpiresAt: undefined,
          errorMessage: undefined,
          completedAt: undefined,
          recoveryCount: recoveryCount + 1,
          updatedAt: args.now,
        });
        // Subtasks left "running" by the dead worker have no executor
        // anymore: return them to pending so the resumed run (and the
        // dashboard) sees them as work still to do. Completed rows are
        // untouched — they are the checkpoint being resumed from.
        for (const subtask of subtaskRows) {
          if (subtask.status === "running") {
            await ctx.db.patch(subtask._id, {
              status: "pending",
              startedAt: undefined,
            });
          }
        }
        await ctx.db.insert("taskEvents", {
          taskId: task._id,
          projectId: task.projectId,
          type: "task.recovered",
          payload: {
            action: "requeued",
            reason: "stale_lease",
            workerId: task.workerId ?? null,
            recoveryCount: recoveryCount + 1,
          },
          level: "warn",
        });
        recovered.push(task._id);
        continue;
      }

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
        payload: {
          action: "failed",
          reason: planValid
            ? "recovery_bound_exceeded"
            : "no_valid_stored_plan",
          workerId: task.workerId ?? null,
          recoveryCount,
        },
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

/**
 * Persist dynamically spawned subtasks (Phase 4 hardening): the
 * delegation and fix subtasks the orchestrator adds mid-run (Phase 3)
 * previously lived only in the worker's memory, so a worker restart
 * lost them and recovery could only rebuild the initial plan.
 *
 * Two writes, both idempotent and safe against concurrent callers:
 *  1. PLAN CHECKPOINT — the current plan row's payload is extended
 *     with the subtasks it does not already contain, merged BY KEY.
 *     Only applied when the stored plan's version matches the version
 *     the nodes were spawned under (a stale write from a superseded
 *     plan version must not pollute the current plan). Merging by key
 *     means a repeated or racing call converges to the same payload
 *     instead of duplicating nodes.
 *  2. SUBTASK ROWS — insert-only upsert by (taskId, key) via the
 *     by_task_and_key index: a missing key is inserted as "pending"
 *     with its full definition (dependencies, capability, origin); an
 *     existing row is NEVER patched here, so a late persist can never
 *     resurrect or downgrade a row that has already started or
 *     completed (monotonic status, see monotonicSubtaskStatus).
 * Convex mutations execute serially, so the check-then-insert cannot
 * interleave with another mutation; combined with the key-stable
 * upsert this makes the whole operation safe to call twice, or from
 * two outcomes settling at the same moment.
 */
export const upsertDynamicSubtasks = internalMutation({
  args: {
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
  handler: async (ctx, args) => {
    const inserted: string[] = [];
    const existing: string[] = [];

    for (const subtask of args.subtasks) {
      const row = await ctx.db
        .query("subtasks")
        .withIndex("by_task_and_key", (q) =>
          q.eq("taskId", args.taskId).eq("key", subtask.key)
        )
        .unique();
      if (row) {
        existing.push(subtask.key);
        continue;
      }
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
        origin: subtask.origin ?? "dynamic",
        attempts: 0,
      });
      inserted.push(subtask.key);
    }

    let payloadUpdated = false;
    const plans = await ctx.db
      .query("plans")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .order("desc")
      .take(1);
    const planRow = plans[0];
    if (planRow && planRow.version === args.version) {
      const currentPayload = (planRow.payload ?? {}) as {
        subtasks?: Array<{ key: string }>;
      };
      const currentSubtasks = Array.isArray(currentPayload.subtasks)
        ? currentPayload.subtasks
        : [];
      const knownKeys = new Set(currentSubtasks.map((subtask) => subtask.key));
      const incoming = (
        args.payload as { subtasks?: Array<{ key: string }> } | null
      )?.subtasks;
      const additions = Array.isArray(incoming)
        ? incoming.filter((subtask) => !knownKeys.has(subtask.key))
        : [];
      if (additions.length > 0) {
        await ctx.db.patch(planRow._id, {
          payload: {
            ...currentPayload,
            subtasks: [...currentSubtasks, ...additions],
          },
        });
        payloadUpdated = true;
      }
    }

    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      projectId: args.projectId,
      type: "plan.dynamic_subtasks_persisted",
      payload: {
        version: args.version,
        inserted,
        existing,
        payloadUpdated,
        payloadVersionMatched: Boolean(
          planRow && planRow.version === args.version
        ),
      },
      level: "info",
    });
    return { inserted, existing, payloadUpdated };
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
        // Monotonic (Phase 4 hardening): a late update for an older
        // attempt must not rewrite a row that has since completed.
        const nextStatus = monotonicSubtaskStatus(
          subtask.status,
          mapped
        ) as typeof mapped;
        await ctx.db.patch(subtask._id, {
          status: nextStatus,
          output: args.output ?? subtask.output,
          error: args.error,
          completedAt:
            nextStatus === "completed" || nextStatus === "failed"
              ? now
              : undefined,
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
    // Terminal guard (Phase 4 hardening): this mutation moves the task
    // to needs_approval — a status transition — so a late request from
    // a worker whose task was already cancelled/completed must not
    // resurrect it. An approval that already exists is returned as-is;
    // otherwise the request is refused with a clear error (the caller
    // is already winding down: its task is over).
    const task = await ctx.db.get(args.taskId);
    if (task && TERMINAL_TASK_STATUSES.has(task.status)) {
      const prior = existing.find((approval) => approval.kind === args.kind);
      if (prior) return prior._id;
      throw new Error(
        `Task is already ${task.status}; approvals can no longer be requested`
      );
    }
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

export const claimResumableTask = internalMutation({
  args: {
    taskId: v.id("tasks"),
    workerId: v.string(),
    leaseMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task || task.status !== "needs_approval") return null;
    const now = Date.now();
    if (task.workerId && task.workerId !== args.workerId && (task.leaseExpiresAt ?? 0) >= now) {
      return null;
    }
    const leaseExpiresAt = now + (args.leaseMs ?? DEFAULT_LEASE_MS);
    await ctx.db.patch(task._id, { workerId: args.workerId, leaseExpiresAt, updatedAt: now });
    await ctx.db.insert("taskEvents", {
      taskId: task._id,
      projectId: task.projectId,
      type: "task.claimed",
      payload: { workerId: args.workerId, reason: "approval_resume" },
      level: "info",
    });
    return { ...task, workerId: args.workerId, leaseExpiresAt };
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
    // Terminal guard (Phase 4 hardening): a task that already reached
    // a terminal status keeps it. A worker that finishes late — after
    // a user cancellation, a recovery failure, or another worker's
    // completion — gets a clear refusal VALUE ({ applied: false }),
    // not an error, so it can stop cleanly; the stored outcome, its
    // error message and its completion timestamp are left untouched.
    const before = await ctx.db.get(args.taskId);
    if (before && TERMINAL_TASK_STATUSES.has(before.status)) {
      return {
        applied: false,
        reason: "task_already_terminal" as const,
        status: before.status,
      };
    }
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
    return { applied: true, status: args.status };
  },
});

export const setTaskStatus = internalMutation({
  args: { taskId: v.id("tasks"), status: taskStatus },
  handler: async (ctx, args) => {
    // Terminal guard (Phase 4 hardening): same absorbing rule as
    // completeTask — a raw status write may not resurrect a terminal
    // task. Rewriting the SAME terminal status stays allowed
    // (idempotent), anything else is refused with a false return.
    const task = await ctx.db.get(args.taskId);
    if (!task) return false;
    if (
      TERMINAL_TASK_STATUSES.has(task.status) &&
      task.status !== args.status
    ) {
      return false;
    }
    await ctx.db.patch(args.taskId, { status: args.status, updatedAt: Date.now() });
    return true;
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
    // Monotonic (Phase 4 hardening): see monotonicSubtaskStatus — a
    // blocked/pending write that was issued before a completion landed
    // must not downgrade the completed row.
    const nextStatus = monotonicSubtaskStatus(
      subtask.status,
      args.status
    ) as typeof args.status;
    await ctx.db.patch(subtask._id, {
      status: nextStatus,
      output: args.output ?? subtask.output,
      error: args.error,
      assignedAgentId: args.agentId ?? subtask.assignedAgentId,
      assignedAgentName: args.agentName ?? subtask.assignedAgentName,
      completedAt:
        nextStatus === "completed" || nextStatus === "failed"
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
    agentId: v.optional(v.id("agents")),
    message: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("taskEvents", {
      ...args,
      createdAt: Date.now(),
    });
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
    // Phase 5: which connection + registry model actually served the
    // call, and the estimated cost from that model's pricing. Absent
    // when the serving handle had no registry identity / no pricing —
    // never guessed (see worker effects/llmCall usageMetaFor).
    providerId: v.optional(v.id("llmProviders")),
    modelId: v.optional(v.id("llmModels")),
    estimatedCost: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("tokenUsage", {
      projectId: args.projectId,
      taskId: args.taskId,
      agentId: args.agentId,
      agentName: args.agentName,
      model: args.model,
      providerId: args.providerId,
      modelId: args.modelId,
      estimatedCost: args.estimatedCost,
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
    // Phase 5: usage per serving provider connection / registry model.
    // Attribution columns exist only on calls recorded after Phase 5;
    // older rows aggregate under the "(unattributed)" bucket instead of
    // being guessed into a provider.
    const byProvider: Record<
      string,
      { inputTokens: number; outputTokens: number; calls: number; estimatedCost: number }
    > = {};
    const byModel: Record<
      string,
      { inputTokens: number; outputTokens: number; calls: number; estimatedCost: number }
    > = {};
    let totalInput = 0;
    let totalOutput = 0;
    let totalEstimatedCost = 0;
    // Bucket by hour: { hourStartUnixSec: tokens }
    const byHour: Record<number, number> = {};
    // Resolve display names for the attribution ids in one pass.
    const providerNames = new Map<string, string>();
    for (const provider of await ctx.db.query("llmProviders").collect()) {
      providerNames.set(provider._id, provider.name);
    }
    const modelNames = new Map<string, string>();
    for (const model of await ctx.db.query("llmModels").collect()) {
      modelNames.set(model._id, model.modelId);
    }
    for (const r of records) {
      if (!byAgent[r.agentName]) {
        byAgent[r.agentName] = { inputTokens: 0, outputTokens: 0, calls: 0 };
      }
      byAgent[r.agentName].inputTokens += r.inputTokens;
      byAgent[r.agentName].outputTokens += r.outputTokens;
      byAgent[r.agentName].calls += 1;
      totalInput += r.inputTokens;
      totalOutput += r.outputTokens;
      const providerKey = r.providerId
        ? (providerNames.get(r.providerId) ?? r.providerId)
        : "(unattributed)";
      if (!byProvider[providerKey]) {
        byProvider[providerKey] = {
          inputTokens: 0,
          outputTokens: 0,
          calls: 0,
          estimatedCost: 0,
        };
      }
      byProvider[providerKey].inputTokens += r.inputTokens;
      byProvider[providerKey].outputTokens += r.outputTokens;
      byProvider[providerKey].calls += 1;
      const modelKey = r.modelId
        ? (modelNames.get(r.modelId) ?? r.model)
        : "(unattributed)";
      if (!byModel[modelKey]) {
        byModel[modelKey] = {
          inputTokens: 0,
          outputTokens: 0,
          calls: 0,
          estimatedCost: 0,
        };
      }
      byModel[modelKey].inputTokens += r.inputTokens;
      byModel[modelKey].outputTokens += r.outputTokens;
      byModel[modelKey].calls += 1;
      if (r.estimatedCost !== undefined) {
        byProvider[providerKey].estimatedCost += r.estimatedCost;
        byModel[modelKey].estimatedCost += r.estimatedCost;
        totalEstimatedCost += r.estimatedCost;
      }
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
    // Delegation metrics from the delegations table — real subtask-
    // producing decisions since Phase 3 (count per decision outcome).
    const delegationRows = await ctx.db.query("delegations").collect();
    const byDecision: Record<string, number> = {};
    for (const row of delegationRows) {
      byDecision[row.decision] = (byDecision[row.decision] ?? 0) + 1;
    }
    const delegations = {
      total: delegationRows.length,
      byDecision,
      approvedRate:
        delegationRows.length > 0
          ? (byDecision.APPROVE ?? 0) / delegationRows.length
          : 0,
    };
    return {
      byAgent,
      byProvider,
      byModel,
      totalInput,
      totalOutput,
      totalCalls: records.length,
      totalEstimatedCost,
      delegations,
      timeline,
    };
  },
});

/**
 * Provider health snapshots for the Settings UI (Phase 5 observability):
 * the worker-mirrored circuit state per connection, keyed by provider
 * name. Public read — the values are operational counters only (no
 * credentials, no request data). Rows exist only after a provisioned
 * worker reported; the UI renders the absence honestly.
 */
export const providerHealthStats = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("providerHealth").collect();
    const snapshots: Record<
      string,
      {
        providerId: string;
        consecutiveTransientFailures: number;
        totalSuccesses: number;
        totalTransientFailures: number;
        circuitOpenUntil: number | null;
        lastSuccessAt?: number;
        lastFailureAt?: number;
        reportedAt: number;
      }
    > = {};
    for (const row of rows) {
      const name =
        (await ctx.db.get(row.providerId))?.name ?? row.providerName;
      snapshots[name] = {
        providerId: row.providerId,
        consecutiveTransientFailures: row.consecutiveTransientFailures,
        totalSuccesses: row.totalSuccesses,
        totalTransientFailures: row.totalTransientFailures,
        circuitOpenUntil: row.circuitOpenUntil ?? null,
        lastSuccessAt: row.lastSuccessAt,
        lastFailureAt: row.lastFailureAt,
        reportedAt: row.reportedAt,
      };
    }
    return { snapshots, updatedAt: Date.now() };
  },
});

/**
 * Mirror one provider-health snapshot from a worker (Phase 5). INTERNAL
 * and deliberately not exposed through the token-gated worker action
 * surface: the worker's service token must not reach a client, and a
 * client-callable mirror would let anyone forge circuit state. The
 * worker reaches this only through its deployment-provisioned internal
 * channel — same provisioning model as the encryption key (operator
 * sets it up once); unprovisioned deployments simply never write here.
 */
export const reportProviderHealth = internalMutation({
  args: {
    providerId: v.id("llmProviders"),
    providerName: v.string(),
    consecutiveTransientFailures: v.number(),
    totalSuccesses: v.number(),
    totalTransientFailures: v.number(),
    circuitOpenUntil: v.optional(v.number()),
    lastSuccessAt: v.optional(v.number()),
    lastFailureAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("providerHealth")
      .withIndex("by_provider", (q) => q.eq("providerId", args.providerId))
      .first();
    const doc = { ...args, reportedAt: Date.now() };
    if (existing) {
      await ctx.db.patch(existing._id, doc);
      return existing._id;
    }
    return await ctx.db.insert("providerHealth", doc);
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

// Intelligent orchestrator — shared task context

export const getTaskContext = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const contexts = await ctx.db
      .query("taskContexts")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .order("desc")
      .take(1);
    return contexts[0] ?? null;
  },
});

export const upsertTaskContext = internalMutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    originalRequest: v.string(),
    objective: v.string(),
    status: taskStatus,
    decisions: v.array(v.any()),
    artifacts: v.array(v.any()),
    outstandingIssues: v.array(v.any()),
    // Phase 5 (additive): persisted budget snapshot. Callers that do
    // not supply one leave the stored snapshot untouched (see handler).
    budgetSnapshot: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("taskContexts")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .first();
    const now = Date.now();
    // An omitted budgetSnapshot means "no new snapshot this write" —
    // keep the stored one instead of patching it away.
    const { budgetSnapshot, ...rest } = args;
    const patch =
      budgetSnapshot === undefined
        ? { ...rest, updatedAt: now }
        : { ...rest, budgetSnapshot, updatedAt: now };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    return await ctx.db.insert("taskContexts", patch);
  },
});

export const recordDelegation = internalMutation({
  args: {
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
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("delegations", { ...args, createdAt: Date.now() });
    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      projectId: args.projectId,
      type: "orchestrator.delegation",
      payload: { decision: args.decision, reason: args.reason ?? null, capability: args.capability ?? null },
      level: args.decision === "BLOCKED" ? "warn" : "info",
    });
    return id;
  },
});

export const recordLifecycle = internalMutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    state: v.string(),
    prevState: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("lifecycleHistory", { ...args, createdAt: Date.now() });
  },
});

export const getTaskTokenUsage = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const usage = await ctx.db
      .query("tokenUsage")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();
    return {
      calls: usage.length,
      inputTokens: usage.reduce((s, u) => s + u.inputTokens, 0),
      outputTokens: usage.reduce((s, u) => s + u.outputTokens, 0),
    };
  },
});