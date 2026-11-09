import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { projectAgentDoc } from "./agents";
import { visibleProjectIds } from "./lib/authz";

/** Bounded reads (core M7): failed tasks in particular only ever grow. */
const INBOX_APPROVAL_LIMIT = 100;
const INBOX_TASK_LIMIT = 100;
const INBOX_FAILED_LIMIT = 50;
const INBOX_NOTIFICATION_LIMIT = 100;

export const list = query({
  args: {},
  handler: async (ctx) => {
    // Scoped to the projects the caller may see (core H5).
    const visible = await visibleProjectIds(ctx);
    const approvals = (
      await ctx.db
        .query("approvals")
        .withIndex("by_status", (q) => q.eq("status", "pending"))
        .order("desc")
        .take(INBOX_APPROVAL_LIMIT)
    ).filter((a) => visible.has(a.projectId as string));
    const needsApproval = (
      await ctx.db
        .query("tasks")
        .withIndex("by_status", (q) => q.eq("status", "needs_approval"))
        .order("desc")
        .take(INBOX_TASK_LIMIT)
    ).filter((t) => visible.has(t.projectId as string));
    const failed = (
      await ctx.db
        .query("tasks")
        .withIndex("by_status", (q) => q.eq("status", "failed"))
        .order("desc")
        .take(INBOX_FAILED_LIMIT)
    ).filter((t) => visible.has(t.projectId as string));
    const tasks = [...needsApproval, ...failed].sort(
      (a, b) => (b.updatedAt ?? b._creationTime) - (a.updatedAt ?? a._creationTime)
    );
    // Stored PR notifications (post-push feedback loop); they resolve
    // themselves, so only open rows are read.
    const notifications = (
      await ctx.db
        .query("notifications")
        .withIndex("by_status_and_updated", (q) => q.eq("status", "open"))
        .order("desc")
        .take(INBOX_NOTIFICATION_LIMIT)
    ).filter((n) => visible.has(n.projectId as string));
    const agents = await ctx.db
      .query("agents")
      .filter((q) => q.eq(q.field("status"), "needs_you"))
      .take(200);

    const projectIds = [
      ...new Set<string>([
        ...approvals.map((a) => a.projectId as string),
        ...tasks.map((t) => t.projectId as string),
        ...notifications.map((n) => n.projectId as string),
      ]),
    ] as Id<"projects">[];
    const projectNameById = new Map<string, string>();
    for (const id of projectIds) {
      const p = await ctx.db.get(id);
      if (p) projectNameById.set(p._id as string, p.name);
    }

    const taskIds = [...new Set<string>([...approvals.map((a) => a.taskId as string), ...tasks.map((t) => t._id as string)])] as Id<"tasks">[];
    const taskById = new Map<string, { title: string }>();
    for (const id of taskIds) {
      const t = await ctx.db.get(id);
      if (t) taskById.set(t._id as string, { title: t.title });
    }

    const agentIds = [...new Set<string>(approvals.map((a) => a.requestedByAgentId).filter(Boolean) as string[])] as Id<"agents">[];
    const agentRoleById = new Map<string, string>();
    for (const id of agentIds) {
      const a = await ctx.db.get(id);
      if (a) agentRoleById.set(a._id as string, a.role);
    }

    const approvalTaskIds = new Set(approvals.map((a) => a.taskId as string));

    return {
      approvals: approvals.map((a) => ({
        ...a,
        projectName: projectNameById.get(a.projectId as string) ?? "—",
        taskTitle: taskById.get(a.taskId as string)?.title ?? null,
        requestedByAgentName: a.requestedByAgentId
          ? (agentRoleById.get(a.requestedByAgentId as string) ?? null)
          : null,
      })),
      tasks: tasks
        .filter((t) => !approvalTaskIds.has(t._id as string))
        .map((t) => ({ ...t, projectName: projectNameById.get(t.projectId as string) ?? "—" })),
      agents: agents.map(projectAgentDoc),
      notifications: notifications.map((n) => ({
        _id: n._id,
        kind: n.kind,
        title: n.title,
        detail: n.detail ?? null,
        url: n.url ?? null,
        projectId: n.projectId,
        taskId: n.taskId,
        projectName: projectNameById.get(n.projectId as string) ?? "—",
        updatedAt: n.updatedAt,
      })),
    };
  },
});
