import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { assertProjectAccess, assertTaskAccess } from "./authz";
import { taskStatus } from "./schema";

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
    return await ctx.db.query("tasks").order("desc").take(500);
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

export const createFromCommand = mutation({
  args: {
    projectId: v.id("projects"),
    command: v.string(),
    title: v.optional(v.string()),
    assignedAgentIds: v.optional(v.array(v.id("agents"))),
  },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    const rawCommand = args.command.trim();
    if (!rawCommand) throw new Error("Command is required");
    if (rawCommand.length > 4000) throw new Error("Command is too long (max 4000 characters)");
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
    const conversationMsgs = history.filter((m) => !m.taskId && !isErrorChatter(m.content) && m.authorType === "user");
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

    const deleteByTask = async (
      table: "messages" | "approvals" | "taskEvents" | "fileChanges" | "subtasks" | "executions" | "evaluations" | "plans"
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
    await ctx.db.insert("taskEvents", {
      taskId: task._id,
      projectId: task.projectId,
      type: "task.cancelled",
      payload: {},
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
    const now = Date.now();
    await ctx.db.patch(args.taskId, {
      status: "queued",
      workerId: undefined,
      leaseExpiresAt: undefined,
      errorMessage: undefined,
      completedAt: undefined,
      updatedAt: now,
      replanCount: 0,
    });
    // clear failed subtasks so worker replans cleanly
    const subs = await ctx.db.query("subtasks").withIndex("by_task", (q) => q.eq("taskId", args.taskId)).collect();
    for (const s of subs) await ctx.db.patch(s._id, { status: "pending", error: undefined, attempts: 0, completedAt: undefined });
    await ctx.db.insert("taskEvents", {
      taskId: task._id,
      projectId: task.projectId,
      type: "task.retried",
      payload: { prevStatus: task.status },
      level: "info",
    });
    return true;
  },
});
