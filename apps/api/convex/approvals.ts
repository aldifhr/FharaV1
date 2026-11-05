import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const listPendingAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("approvals")
      .filter((q) => q.eq(q.field("status"), "pending"))
      .order("desc")
      .collect();
  },
});

export const approve = mutation({
  args: { approvalId: v.id("approvals") },
  handler: async (ctx, args) => {
    return await ctx.db.patch(args.approvalId, { status: "approved" });
  },
});

export const reject = mutation({
  args: { approvalId: v.id("approvals") },
  handler: async (ctx, args) => {
    return await ctx.db.patch(args.approvalId, { status: "rejected" });
  },
});

export const request = mutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    kind: v.union(
      v.literal("apply_changes"),
      v.literal("git_push"),
      v.literal("run_command")
    ),
    summary: v.string(),
    payload: v.optional(v.any()),
    requestedByAgentId: v.optional(v.id("agents")),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("approvals", { ...args, status: "pending" });
  },
});

export const getById = query({
  args: { approvalId: v.id("approvals") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.approvalId);
  },
});
