import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { assertProjectAccess, getViewerId } from "./authz";

function validateWorkspacePath(raw: string): string {
  const workspacePath = raw.trim();
  if (!workspacePath) throw new Error("Project path is required");
  if (workspacePath.length > 1024) throw new Error("Project path is too long");
  if (/[\u0000-\u001f]/.test(workspacePath)) {
    throw new Error("Project path contains control characters");
  }
  if (/^[a-z]+:\/\//i.test(workspacePath) && !/^file:\/\//i.test(workspacePath)) {
    throw new Error("Project path must be a local filesystem path");
  }
  if (workspacePath.split(/[\\/]+/).includes("..")) {
    throw new Error("Project path must not contain '..' segments");
  }
  return workspacePath;
}

export const create = mutation({
  args: {
    name: v.string(),
    workspacePath: v.string(),
    agentIds: v.optional(v.array(v.id("agents"))),
    approvalMode: v.optional(v.union(v.literal("ask"), v.literal("auto"))),
  },
  handler: async (ctx, args) => {
    const name = args.name.trim();
    if (!name) throw new Error("Project name is required");
    const workspacePath = validateWorkspacePath(args.workspacePath);

    for (const agentId of args.agentIds ?? []) {
      const agent = await ctx.db.get(agentId);
      if (!agent) throw new Error(`Agent not found: ${agentId}`);
    }

    const viewerId = await getViewerId(ctx);
    return await ctx.db.insert("projects", {
      name,
      workspacePath,
      ...(args.agentIds ? { agentIds: args.agentIds } : {}),
      ...(viewerId ? { ownerId: viewerId } : {}),
      ...(args.approvalMode ? { approvalMode: args.approvalMode } : {}),
      createdAt: Date.now(),
    });
  },
});

export const updateTeam = mutation({
  args: {
    projectId: v.id("projects"),
    agentIds: v.array(v.id("agents")),
  },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    const uniqueAgentIds = Array.from(new Set(args.agentIds));
    for (const agentId of uniqueAgentIds) {
      const agent = await ctx.db.get(agentId);
      if (!agent) throw new Error(`Agent not found: ${agentId}`);
    }
    await ctx.db.patch(args.projectId, { agentIds: uniqueAgentIds });
  },
});

export const updateApprovalMode = mutation({
  args: {
    projectId: v.id("projects"),
    approvalMode: v.union(v.literal("ask"), v.literal("auto")),
  },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    await ctx.db.patch(args.projectId, { approvalMode: args.approvalMode });
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const viewerId = await getViewerId(ctx);
    if (!viewerId) {
      return await ctx.db.query("projects").order("desc").collect();
    }
    const all = await ctx.db.query("projects").order("desc").collect();
    return all.filter((project) => !project.ownerId || project.ownerId === viewerId);
  },
});

export const get = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    return await assertProjectAccess(ctx, args.projectId);
  },
});

export const remove = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);

    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    for (const task of tasks) {
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
        const records = await ctx.db
          .query(table)
          .withIndex("by_task", (q) => q.eq("taskId", task._id))
          .collect();
        for (const record of records) await ctx.db.delete(record._id);
      }
      await ctx.db.delete(task._id);
    }

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    for (const message of messages) await ctx.db.delete(message._id);

    const projectApprovals = await ctx.db
      .query("approvals")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    for (const approval of projectApprovals) await ctx.db.delete(approval._id);

    const projectEvents = await ctx.db
      .query("taskEvents")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    for (const event of projectEvents) await ctx.db.delete(event._id);

    await ctx.db.delete(args.projectId);
    return { deletedTasks: tasks.length };
  },
});
