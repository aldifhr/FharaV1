import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { assertProjectAccess, canViewProject, getViewerId } from "./lib/authz";
import { changedFields, recordAudit } from "./lib/recordAudit";
import { permissionModeValidator, type PermissionMode } from "./lib/permissionModes";

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
    qaUrl: v.optional(v.string()),
    devUrl: v.optional(v.string()),
    approvalMode: v.optional(v.union(v.literal("ask"), v.literal("auto"))),
    defaultPermissionMode: v.optional(permissionModeValidator),
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
    const projectId = await ctx.db.insert("projects", {
      name,
      workspacePath,
      ...(args.agentIds ? { agentIds: args.agentIds } : {}),
      ...(args.qaUrl ? { qaUrl: args.qaUrl.trim() } : {}),
      ...(args.devUrl ? { devUrl: args.devUrl.trim() } : {}),
      ...(viewerId ? { ownerId: viewerId } : {}),
      ...(args.approvalMode ? { approvalMode: args.approvalMode } : {}),
      ...(args.defaultPermissionMode ? { defaultPermissionMode: args.defaultPermissionMode } : {}),
      createdAt: Date.now(),
    });
    await recordAudit(ctx, { action: "project.create", target: name, projectId });
    return projectId;
  },
});

export const updateTeam = mutation({
  args: {
    projectId: v.id("projects"),
    agentIds: v.array(v.id("agents")),
  },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);
    const uniqueAgentIds = Array.from(new Set(args.agentIds));
    for (const agentId of uniqueAgentIds) {
      const agent = await ctx.db.get(agentId);
      if (!agent) throw new Error(`Agent not found: ${agentId}`);
    }
    await ctx.db.patch(args.projectId, { agentIds: uniqueAgentIds });
    const before = new Set(project.agentIds ?? []);
    const added = uniqueAgentIds.filter((id) => !before.has(id)).length;
    const removed = [...before].filter((id) => !uniqueAgentIds.includes(id)).length;
    if (added || removed) {
      await recordAudit(ctx, {
        action: "project.team",
        target: project.name,
        projectId: args.projectId,
        details: { changed: ["agentIds"], added, removed },
      });
    }
  },
});

export const update = mutation({
  args: {
    projectId: v.id("projects"),
    name: v.optional(v.string()),
    workspacePath: v.optional(v.string()),
    qaUrl: v.optional(v.string()),
    devUrl: v.optional(v.string()),
    approvalMode: v.optional(v.union(v.literal("ask"), v.literal("auto"))),
    instructions: v.optional(v.string()),
    defaultPermissionMode: v.optional(permissionModeValidator),
  },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);
    const patch: {
      defaultPermissionMode?: PermissionMode;
      name?: string;
      workspacePath?: string;
      qaUrl?: string;
      devUrl?: string;
      approvalMode?: "ask" | "auto";
      instructions?: string;
    } = {};
    if (args.name !== undefined) {
      const name = args.name.trim();
      if (!name) throw new Error("Project name is required");
      patch.name = name;
    }
    if (args.workspacePath !== undefined) {
      patch.workspacePath = validateWorkspacePath(args.workspacePath);
    }
    if (args.qaUrl !== undefined) {
      patch.qaUrl = args.qaUrl.trim();
    }
    if (args.devUrl !== undefined) {
      patch.devUrl = args.devUrl.trim();
    }
    if (args.approvalMode !== undefined) {
      patch.approvalMode = args.approvalMode;
    }
    if (args.instructions !== undefined) {
      patch.instructions = args.instructions;
    }
    if (args.defaultPermissionMode !== undefined) {
      patch.defaultPermissionMode = args.defaultPermissionMode;
    }
    await ctx.db.patch(args.projectId, patch);
    const changed = changedFields(project as Record<string, unknown>, patch);
    if (changed.length) {
      await recordAudit(ctx, {
        action: "project.update",
        target: patch.name ?? project.name,
        projectId: args.projectId,
        details: { changed },
      });
    }
  },
});

export const updateApprovalMode = mutation({
  args: {
    projectId: v.id("projects"),
    approvalMode: v.union(v.literal("ask"), v.literal("auto")),
  },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);
    await ctx.db.patch(args.projectId, { approvalMode: args.approvalMode });
    if (project.approvalMode !== args.approvalMode) {
      await recordAudit(ctx, {
        action: "project.update",
        target: project.name,
        projectId: args.projectId,
        details: { changed: ["approvalMode"] },
      });
    }
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
    return all.filter((project) => canViewProject(viewerId, project));
  },
});

/**
 * One project, or `null` when the id is malformed or the project no longer
 * exists (stale/deleted URL) so the UI can redirect instead of crashing.
 * Access to an existing project owned by someone else still throws.
 */
export const get = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const projectId = ctx.db.normalizeId("projects", args.projectId);
    if (!projectId) return null;
    const project = await ctx.db.get(projectId);
    if (!project) return null;
    return await assertProjectAccess(ctx, projectId);
  },
});

export const remove = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);

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
        "subtaskLive",
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
    // Global row (no projectId): the project is gone, the trail stays.
    await recordAudit(ctx, {
      action: "project.remove",
      target: project.name,
      details: { deletedTasks: tasks.length },
    });
    return { deletedTasks: tasks.length };
  },
});
