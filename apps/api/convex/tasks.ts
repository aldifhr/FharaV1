import { query, mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  assertProjectAccess,
  assertTaskAccess,
  getViewerId,
  visibleProjectIds,
} from "./authz";
import { refreshAgentStatus } from "./orchestration";
import { taskStatus } from "./schema";

/** A worker currently holds an unexpired lease on the task (e.g. resuming it). */
function holdsLiveLease(task: Doc<"tasks">): boolean {
  return Boolean(task.workerId) && (task.leaseExpiresAt ?? 0) > Date.now();
}

/**
 * Close a task's approvals in the given statuses as "cancelled" (no user
 * decision; ignored by the permission broker and by the worker's resume
 * selection). The previous status is appended to the row's history.
 */
async function closeApprovals(
  ctx: MutationCtx,
  taskId: Id<"tasks">,
  statuses: ReadonlyArray<"pending" | "approved" | "rejected">,
  reason: string,
  now: number
): Promise<number> {
  const rows = await ctx.db
    .query("approvals")
    .withIndex("by_task", (q) => q.eq("taskId", taskId))
    .collect();
  let closed = 0;
  for (const row of rows) {
    if (!(statuses as readonly string[]).includes(row.status)) continue;
    await ctx.db.patch(row._id, {
      status: "cancelled",
      resolvedAt: row.resolvedAt ?? now,
      history: [
        ...(row.history ?? []),
        { at: now, from: row.status, to: "cancelled", reason },
      ],
    });
    closed++;
  }
  return closed;
}

export const listByProject = query({
  args: { projectId: v.id("projects"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    return await ctx.db
      .query("tasks")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(Math.min(Math.max(args.limit ?? 200, 1), 500));
  },
});

export const listAll = query({
  args: {},
  handler: async (ctx) => {
    const tasks = await ctx.db.query("tasks").order("desc").take(500);
    const viewerId = await getViewerId(ctx);
    if (!viewerId) return tasks;
    // With an identity present, apply the same per-project visibility as
    // listByProject/get: tasks belonging to projects owned by someone else
    // are hidden (mirrors projects.list). Local mode without an identity
    // keeps returning everything.
    const visible: typeof tasks = [];
    for (const task of tasks) {
      const project = await ctx.db.get(task.projectId);
      if (!project) continue;
      if (!project.ownerId || project.ownerId === viewerId) {
        visible.push(task);
      }
    }
    return visible;
  },
});

export const get = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return null;
    await assertProjectAccess(ctx, task.projectId);
    return task;
  },
});

/**
 * Project ids that have a task in flight (queued/running/needs_approval/
 * waiting_input). The sidebar badge uses it so an idle project does not read
 * "in progress".
 */
export const activeTaskProjectIds = query({
  args: {},
  handler: async (ctx) => {
    // Bounded per status and limited to projects the caller may see.
    const visible = await visibleProjectIds(ctx);
    const ids = new Set<string>();
    for (const status of ["queued", "running", "needs_approval", "waiting_input"] as const) {
      const rows = await ctx.db
        .query("tasks")
        .withIndex("by_status", (q) => q.eq("status", status))
        .order("desc")
        .take(500);
      for (const row of rows) {
        if (visible.has(row.projectId as string)) ids.add(row.projectId as string);
      }
    }
    return [...ids];
  },
});

export const createFromCommand = mutation({
  args: {
    projectId: v.id("projects"),
    command: v.string(),
    title: v.optional(v.string()),
    assignedAgentIds: v.optional(v.array(v.id("agents"))),
  },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);
    const rawCommand = args.command.trim();
    if (!rawCommand) throw new Error("Command is required");
    if (rawCommand.length > 4000) throw new Error("Command is too long (max 4000 characters)");

    // Validate the requested assignees: every id must exist, and when the
    // project has a defined team (agentIds non-empty) every id must be a
    // member of it. The ids were previously stored verbatim, which let a
    // task pull any global agent into any project (spec §9.2). The error
    // names the offending id so callers can fix their request.
    if (args.assignedAgentIds) {
      const team = project.agentIds ?? [];
      for (const agentId of args.assignedAgentIds) {
        const agent = await ctx.db.get(agentId);
        if (!agent) {
          throw new Error(`Assigned agent not found: ${agentId}`);
        }
        if (team.length > 0 && !team.includes(agentId)) {
          throw new Error(
            `Assigned agent ${agentId} is not a member of this project's team`
          );
        }
      }
    }
    const title =
      args.title?.trim() ||
      (rawCommand.length > 80 ? rawCommand.slice(0, 80) + "..." : rawCommand);

    // Conversation context: opt-in, deduped, error-filtered.
    // Do NOT leak LLM/agent error chatter into the task command.
    const isErrorChatter = (content: string) =>
      /I couldn'?t reply|No LLM API key|LLM request failed|Unexpected non-whitespace|Check global LLM settings|I can'?t run shell|Gue nggak bisa jalanin|nggak punya akses terminal/i.test(content);
    const history = await ctx.db
      .query("messages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(30);
    // The current user message is inserted before the task is created
    // (chat send path), so it is always in this history — echoing it back
    // as "Conversation context" just doubles the command with itself.
    const conversationMsgs = history.filter(
      (m) =>
        !m.taskId &&
        !isErrorChatter(m.content) &&
        m.authorType === "user" &&
        m.content.trim() !== rawCommand.trim()
    );
    // Only include context if the user message itself is short / ambiguous
    const needsContext = rawCommand.length < 80 || /^(git pull|pull|push|checkout|buatin|buat)$/i.test(rawCommand);
    const historyLines = needsContext
      ? conversationMsgs.slice(0, 6).reverse().map((m) => `${m.authorType === "user" ? "User" : "Agent"}: ${m.content.slice(0, 500)}`).join("\n\n")
      : "";
    const contextBlock = historyLines ? `\n\n--- Conversation context ---\n${historyLines}` : "";
    let command = rawCommand + contextBlock;
    if (command.length > 4000) {
      const room = Math.max(0, 4000 - rawCommand.length - "\n\n--- Conversation context ---\n".length);
      command = rawCommand + "\n\n--- Conversation context ---\n" + historyLines.slice(-room);
    }

    const now = Date.now();
    const taskId = await ctx.db.insert("tasks", {
      projectId: args.projectId,
      title,
      command,
      status: "queued",
      assignedAgentIds: args.assignedAgentIds,
      updatedAt: now,
    });
    await ctx.db.insert("messages", {
      projectId: args.projectId,
      taskId,
      authorType: "user",
      content: command,
    });
    return taskId;
  },
});

export const remove = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await assertTaskAccess(ctx, args.taskId);
    if (task.status === "running") {
      throw new Error("Running tasks cannot be deleted");
    }
    if (holdsLiveLease(task)) {
      throw new Error("A worker is resuming this task; cancel it first");
    }

    const deleteByTask = async (
      table:
        | "messages"
        | "approvals"
        | "taskEvents"
        | "fileChanges"
        | "subtasks"
        | "executions"
        | "evaluations"
        | "plans"
        | "taskContexts"
        | "agentEvents"
        | "delegations"
        | "lifecycleHistory"
    ) => {
      const records = await ctx.db
        .query(table)
        .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
        .collect();
      for (const record of records) await ctx.db.delete(record._id);
    };

    for (const table of [
      "messages",
      "approvals",
      "taskEvents",
      "fileChanges",
      "subtasks",
      "executions",
      "evaluations",
      "plans",
      "taskContexts",
      "agentEvents",
      "delegations",
      "lifecycleHistory",
    ] as const) {
      await deleteByTask(table);
    }
    await ctx.db.delete(args.taskId);
    return true;
  },
});

export const cancel = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await assertTaskAccess(ctx, args.taskId);
    if (task.status === "done" || task.status === "rejected") return false;
    const now = Date.now();
    await ctx.db.patch(args.taskId, {
      status: "failed",
      errorMessage: "Cancelled by user",
      completedAt: now,
      updatedAt: now,
      workerId: undefined,
      leaseExpiresAt: undefined,
    });

    // Clean up what the cancelled run left open (core M8): pending
    // approvals would otherwise stay actionable in the inbox, and running
    // executions would read "running" until their lease lapsed and then
    // "Worker lease expired".
    const cancelledApprovals = await closeApprovals(ctx, task._id, ["pending"], "task_cancelled", now);
    const affectedAgents = new Set<Id<"agents">>();
    let cancelledExecutions = 0;
    const executions = await ctx.db
      .query("executions")
      .withIndex("by_task", (q) => q.eq("taskId", task._id))
      .collect();
    for (const execution of executions) {
      if (
        execution.status !== "running" &&
        execution.status !== "queued" &&
        execution.status !== "waiting_approval"
      ) {
        continue;
      }
      await ctx.db.patch(execution._id, {
        status: "cancelled",
        error: "Cancelled by user",
        leaseExpiresAt: undefined,
        completedAt: now,
      });
      cancelledExecutions++;
      if (execution.agentId) affectedAgents.add(execution.agentId);
    }
    const subtasks = await ctx.db
      .query("subtasks")
      .withIndex("by_task", (q) => q.eq("taskId", task._id))
      .collect();
    for (const subtask of subtasks) {
      if (subtask.status === "running" || subtask.status === "waiting_approval") {
        await ctx.db.patch(subtask._id, { status: "blocked", error: "Cancelled by user" });
      }
    }
    for (const agentId of affectedAgents) await refreshAgentStatus(ctx, agentId);

    await ctx.db.insert("taskEvents", {
      taskId: task._id,
      projectId: task.projectId,
      type: "task.cancelled",
      payload: { cancelledApprovals, cancelledExecutions },
      level: "warn",
    });
    return true;
  },
});

export const retry = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await assertTaskAccess(ctx, args.taskId);
    if (task.status === "running") throw new Error("Running tasks cannot be retried");
    // A needs_approval task a worker is resuming holds a live lease:
    // re-queuing it would run it twice.
    if (holdsLiveLease(task)) {
      throw new Error("A worker is resuming this task; wait or cancel it first");
    }
    const now = Date.now();
    // The previous attempt's approvals are superseded: a pending one would
    // stay actionable, an old rejection would make the resumed run reject
    // again (and the broker deny), and an old approval must not silently
    // grant the new attempt. History is kept on each row.
    await closeApprovals(ctx, task._id, ["pending", "approved", "rejected"], "task_retried", now);
    await ctx.db.patch(args.taskId, {
      status: "queued",
      workerId: undefined,
      leaseExpiresAt: undefined,
      errorMessage: undefined,
      completedAt: undefined,
      updatedAt: now,
      replanCount: 0,
      // Manual retry resets the stale-recovery budget (Phase 4
      // hardening): a human deliberately re-queuing the task starts
      // its recovery count over. Automatic stale recovery
      // (orchestration.recoverStale) does the opposite — it INCREMENTS
      // the count and never resets it, so a poisoned plan still hits
      // the recovery bound.
      recoveryCount: 0,
    });
    // Reset only the subtasks that never finished, so the worker
    // replans the remaining work cleanly. Completed subtasks keep their
    // status and output (Phase 4): a manual retry resumes from them —
    // the worker's state builder skips completed keys — instead of
    // silently re-executing (and re-paying for) work already done.
    const subs = await ctx.db.query("subtasks").withIndex("by_task", (q) => q.eq("taskId", args.taskId)).collect();
    for (const s of subs) {
      if (s.status === "completed") continue;
      await ctx.db.patch(s._id, { status: "pending", error: undefined, attempts: 0, completedAt: undefined });
    }
    await ctx.db.insert("taskEvents", {
      taskId: task._id,
      projectId: task.projectId,
      type: "task.retried",
      payload: {
        prevStatus: task.status,
        previousRecoveryCount: task.recoveryCount ?? 0,
      },
      level: "info",
    });
    return true;
  },
});

export const answerQuestion = mutation({
  args: { taskId: v.id("tasks"), answer: v.string() },
  handler: async (ctx, args) => {
    const task = await assertTaskAccess(ctx, args.taskId);
    // Terminal guard (same value contract as orchestration.completeTask —
    // a settled task can never come back to answer a question).
    if (task.status === "done" || task.status === "rejected" || task.status === "failed") {
      return { applied: false as const, reason: "task_already_terminal" as const };
    }
    if (task.status !== "waiting_input") {
      return { applied: false as const, reason: "not_waiting_for_input" as const };
    }
    const answer = args.answer.trim();
    if (answer.length === 0) {
      return { applied: false as const, reason: "empty_answer" as const };
    }
    const now = Date.now();
    // The answer travels in the persisted task-context decisions: the
    // resumed run threads it into the shared context (a `user_answer`
    // entry), so the answer influences the continued work. pendingQuestion
    // is cleared — it only ever holds the PENDING question.
    await appendUserAnswer(ctx, args.taskId, answer, now);
    await ctx.db.insert("taskEvents", {
      taskId: task._id,
      projectId: task.projectId,
      type: "task.input_answered",
      payload: { answer: answer.slice(0, 500) },
      level: "info",
    });
    await emitCanonical(ctx, task.projectId, task._id, undefined, undefined, "message.created", { answer: answer.slice(0, 500) });
    await ctx.db.patch(args.taskId, {
      status: "queued",
      pendingQuestion: undefined,
      pendingOptions: undefined,
      workerId: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now,
    });
    return { applied: true as const };
  },
});

/** Steering: append a user instruction to the running task's context.
 *  The worker folds `user_answer` decisions into sharedContext on its next
 *  read, so the in-flight agent adjusts instead of a new task being made. */
export const steerTask = mutation({
  args: { taskId: v.id("tasks"), instruction: v.string() },
  handler: async (ctx, args) => {
    const task = await assertTaskAccess(ctx, args.taskId);
    if (task.status === "done" || task.status === "rejected" || task.status === "failed") {
      return { applied: false as const, reason: "task_already_terminal" as const };
    }
    const instruction = args.instruction.trim();
    if (instruction.length === 0) {
      return { applied: false as const, reason: "empty_instruction" as const };
    }
    const now = Date.now();
    await appendUserAnswer(ctx, args.taskId, instruction, now);
    await ctx.db.insert("taskEvents", {
      taskId: task._id,
      projectId: task.projectId,
      type: "task.steered",
      payload: { instruction: instruction.slice(0, 500) },
      level: "info",
    });
    await emitCanonical(ctx, task.projectId, task._id, undefined, undefined, "message.created", { instruction: instruction.slice(0, 500) });
    return { applied: true as const };
  },
});

/** Append one canonical event with a monotonic sequence. */
async function emitCanonical(
  ctx: any,
  projectId: Id<"projects">,
  taskId: Id<"tasks">,
  executionId: Id<"executions"> | undefined,
  agentId: Id<"agents"> | undefined,
  type: string,
  payload: any
): Promise<Id<"agentEvents">> {
  let sequence = 1;
  const existing = await ctx.db
    .query("agentEvents")
    .withIndex("by_task", (q: any) => q.eq("taskId", taskId))
    .order("desc")
    .take(1);
  if (existing[0]?.sequence) sequence = existing[0].sequence + 1;
  return ctx.db.insert("agentEvents", {
    projectId,
    taskId,
    executionId,
    agentId,
    type,
    payload,
    sequence,
    createdAt: Date.now(),
  });
}

/** Shared persistence for ask_user answers and steering instructions. */
async function appendUserAnswer(
  ctx: any,
  taskId: Id<"tasks">,
  reason: string,
  now: number
): Promise<void> {
  const contexts = await ctx.db
    .query("taskContexts")
    .withIndex("by_task", (q: any) => q.eq("taskId", taskId))
    .order("desc")
    .take(1);
  const existing = contexts[0];
  const decision = {
    decision: "user_answer",
    reason: reason.slice(0, 2000),
    fromAgent: "user",
    createdAt: now,
  };
  if (existing) {
    await ctx.db.patch(existing._id, {
      decisions: [...(existing.decisions ?? []), decision],
      updatedAt: now,
    });
  }
}
