import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { assertProjectAccess, getViewerId, getVisibleTask } from "./authz";

export const listPendingAll = query({
  args: {},
  handler: async (ctx) => {
    const viewerId = await getViewerId(ctx);
    const approvals = await ctx.db
      .query("approvals")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .order("desc")
      .collect();
    if (!viewerId) return approvals;
    const visible = [];
    for (const approval of approvals) {
      const project = await ctx.db.get(approval.projectId);
      if (project && (!project.ownerId || project.ownerId === viewerId)) {
        visible.push(approval);
      }
    }
    return visible;
  },
});

export const approve = mutation({
  args: { approvalId: v.id("approvals") },
  handler: async (ctx, args) => {
    const approval = await ctx.db.get(args.approvalId);
    if (!approval) throw new Error("Approval not found");
    await assertProjectAccess(ctx, approval.projectId);
    if (approval.status !== "pending") {
      throw new Error(`Approval already ${approval.status}`);
    }
    const now = Date.now();
    await ctx.db.patch(args.approvalId, { status: "approved", resolvedAt: now });
    await ctx.db.insert("taskEvents", {
      taskId: approval.taskId,
      projectId: approval.projectId,
      type: "approval.approved",
      payload: { kind: approval.kind, summary: approval.summary },
      subtaskKey: approval.subtaskKey,
      level: "info",
    });
    return true;
  },
});

export const reject = mutation({
  args: { approvalId: v.id("approvals") },
  handler: async (ctx, args) => {
    const approval = await ctx.db.get(args.approvalId);
    if (!approval) throw new Error("Approval not found");
    await assertProjectAccess(ctx, approval.projectId);
    if (approval.status !== "pending") {
      throw new Error(`Approval already ${approval.status}`);
    }
    const now = Date.now();
    await ctx.db.patch(args.approvalId, { status: "rejected", resolvedAt: now });
    await ctx.db.insert("taskEvents", {
      taskId: approval.taskId,
      projectId: approval.projectId,
      type: "approval.rejected",
      payload: { kind: approval.kind, summary: approval.summary },
      subtaskKey: approval.subtaskKey,
      level: "warn",
    });
    return true;
  },
});

/**
 * Hold: keep the approval pending but record the user's decision to
 * postpone it. The approval stays actionable (approve/reject later);
 * the hold is visible in the task timeline as `approval.held`.
 */
export const hold = mutation({
  args: { approvalId: v.id("approvals") },
  handler: async (ctx, args) => {
    const approval = await ctx.db.get(args.approvalId);
    if (!approval) throw new Error("Approval not found");
    await assertProjectAccess(ctx, approval.projectId);
    if (approval.status !== "pending") {
      throw new Error(`Approval already ${approval.status}`);
    }
    await ctx.db.insert("taskEvents", {
      taskId: approval.taskId,
      projectId: approval.projectId,
      type: "approval.held",
      payload: { kind: approval.kind, summary: approval.summary },
      subtaskKey: approval.subtaskKey,
      level: "warn",
    });
    return true;
  },
});

export const getById = query({
  args: { approvalId: v.id("approvals") },
  handler: async (ctx, args) => {
    const approval = await ctx.db.get(args.approvalId);
    if (!approval) return null;
    await assertProjectAccess(ctx, approval.projectId);
    return approval;
  },
});

export const listByTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return [];
    return await ctx.db
      .query("approvals")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();
  },
});
