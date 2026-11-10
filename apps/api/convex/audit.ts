import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { getVisibleTask, assertProjectAccess } from "./lib/authz";
import { insertAudit } from "./lib/auditChain";

const auditDecision = v.union(
  v.literal("allowed"),
  v.literal("denied"),
  v.literal("pending"),
  v.literal("recorded")
);

export const record = internalMutation({
  args: {
    taskId: v.optional(v.id("tasks")),
    projectId: v.optional(v.id("projects")),
    executionId: v.optional(v.id("executions")),
    workerId: v.optional(v.string()),
    actor: v.string(),
    tool: v.string(),
    action: v.string(),
    decision: auditDecision,
    target: v.optional(v.string()),
    details: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<void> => {
    await insertAudit(ctx, {
      ...args,
      createdAt: Date.now(),
    });
  },
});

export const listByTask = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return [];
    return await ctx.db
      .query("audit")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .order("desc")
      .take(200);
  },
});

export const listByProject = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    return await ctx.db
      .query("audit")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(500);
  },
});
