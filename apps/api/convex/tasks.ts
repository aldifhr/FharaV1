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

    // Automatic conversation context: recent chat messages become part of the task command.
    // Only conversation (task-less) messages are used, so agent reports from other
    // tasks don't leak into this task's context.
    const history = await ctx.db
      .query("messages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(30);
    const historyLines = history
      .filter((m) => !m.taskId)
      .slice(0, 12)
      .reverse()
      .map((m) => `${m.authorType === "user" ? "User" : "Agent"}: ${m.content}`)
      .join("\n\n");
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
