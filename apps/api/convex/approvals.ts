import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { assertProjectAccess, canViewProject, getViewerId, getVisibleTask } from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";
import { onPlanApproved, onPlanRejected } from "./planReview";
import { scheduleDecisionEvaluation } from "./lib/calibration/store";
import { resolveCommandApproval } from "./commandApprovals";
import { signalApprovalDecision } from "./taskSignals";
import { appendTaskEvent } from "./lib/taskEvents";

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
      if (canViewProject(viewerId, project)) {
        visible.push(approval);
      }
    }
    return visible;
  },
});

/** Pending approvals of one project (index-backed; the chat reads this, not listPendingAll). */
export const listPendingForProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const viewerId = await getViewerId(ctx);
    if (!canViewProject(viewerId, await ctx.db.get(args.projectId))) return [];
    return await ctx.db
      .query("approvals")
      .withIndex("by_project_and_status", (q) => q.eq("projectId", args.projectId).eq("status", "pending"))
      .order("desc")
      .take(100);
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
    // In-process command waits record a decision the worker reads (one-time allow).
    if (approval.kind === "run_command") {
      await resolveCommandApproval(ctx, approval, "allow");
      return true;
    }
    const now = Date.now();
    await ctx.db.patch(args.approvalId, { status: "approved", resolvedAt: now });
    // Durable signal + wake, in this same mutation (taskSignals.ts).
    await signalApprovalDecision(ctx, { ...approval, status: "approved", resolvedAt: now }, "approved");
    // Plan Inspector: an approved plan re-queues its task (planReview.ts).
    if (approval.kind === "plan") await onPlanApproved(ctx, approval);
    await appendTaskEvent(ctx, {
      taskId: approval.taskId,
      projectId: approval.projectId,
      type: "approval.approved",
      payload: { kind: approval.kind, summary: approval.summary },
      subtaskKey: approval.subtaskKey,
      level: "info",
    });
    await recordAudit(ctx, {
      tool: "approval",
      action: "approval.approve",
      decision: "allowed",
      target: approval.summary,
      projectId: approval.projectId,
      taskId: approval.taskId,
      details: { kind: approval.kind, ...(approval.toolName ? { toolName: approval.toolName } : {}) },
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
    if (approval.kind === "run_command") {
      await resolveCommandApproval(ctx, approval, "deny");
      return true;
    }
    const now = Date.now();
    await ctx.db.patch(args.approvalId, { status: "rejected", resolvedAt: now });
    await signalApprovalDecision(ctx, { ...approval, status: "rejected", resolvedAt: now }, "rejected");
    // Plan Inspector: a rejected plan ends its task as rejected.
    if (approval.kind === "plan") await onPlanRejected(ctx, approval);
    // Decision Outcome Calibration: a human rejection is an outcome signal.
    await scheduleDecisionEvaluation(ctx, approval.taskId);
    await appendTaskEvent(ctx, {
      taskId: approval.taskId,
      projectId: approval.projectId,
      type: "approval.rejected",
      payload: { kind: approval.kind, summary: approval.summary },
      subtaskKey: approval.subtaskKey,
      level: "warn",
    });
    await recordAudit(ctx, {
      tool: "approval",
      action: "approval.reject",
      decision: "denied",
      target: approval.summary,
      projectId: approval.projectId,
      taskId: approval.taskId,
      details: { kind: approval.kind, ...(approval.toolName ? { toolName: approval.toolName } : {}) },
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
    await appendTaskEvent(ctx, {
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
