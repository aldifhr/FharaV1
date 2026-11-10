import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { projectAgentDoc } from "./agents";
import { visibleProjects } from "./lib/authz";
import { collectNeedsYou, taskAwaitsUserApproval } from "./shell";
import { approvalFingerprint } from "./lib/approvalFingerprint";

/** Bounded reads (core M7): failed tasks in particular only ever grow. */
const INBOX_APPROVAL_LIMIT = 100;
const INBOX_TASK_LIMIT = 100;
const INBOX_FAILED_LIMIT = 50;
const INBOX_NOTIFICATION_LIMIT = 100;
/** Failed tasks are information, not a to-do: only recent ones are listed. */
export const INBOX_FAILED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const TERMINAL = new Set(["done", "failed", "rejected", "cancelled"]);

/**
 * Inbox = all notifications: what waits on the user (approvals, pushes,
 * PR notifications, agent questions — the shared definition in shell.ts,
 * whose total is `waitingCount`, the number the sidebar "Needs you" shows)
 * plus recent failed tasks as information (`failed`, never counted).
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    // Scoped to the projects the caller may see (core H5).
    const visibleDocs = await visibleProjects(ctx);
    const visible = new Set(visibleDocs.map((p) => p._id as string));
    const waiting = await collectNeedsYou(ctx, new Map(visibleDocs.map((p) => [p._id as string, p])));
    const pendingRows = (
      await ctx.db
        .query("approvals")
        .withIndex("by_status", (q) => q.eq("status", "pending"))
        .order("desc")
        .take(INBOX_APPROVAL_LIMIT)
    ).filter((a) => visible.has(a.projectId as string));
    // Same rule as Needs you: a finished task's leftover approval is not actionable.
    const approvals = [];
    for (const a of pendingRows) {
      const task = await ctx.db.get(a.taskId);
      if (task && TERMINAL.has(task.status)) continue;
      approvals.push({ ...a, fingerprint: await approvalFingerprint(a) });
    }
    // needs_approval tasks only while the user still has to decide (a
    // decided approval leaves at once, before the worker resumes the task).
    const needsApproval = [];
    for (const t of (
      await ctx.db
        .query("tasks")
        .withIndex("by_status", (q) => q.eq("status", "needs_approval"))
        .order("desc")
        .take(INBOX_TASK_LIMIT)
    ).filter((t) => visible.has(t.projectId as string))) {
      if (await taskAwaitsUserApproval(ctx, t._id)) needsApproval.push(t);
    }
    const since = Date.now() - INBOX_FAILED_WINDOW_MS;
    const failed = (
      await ctx.db
        .query("tasks")
        .withIndex("by_status", (q) => q.eq("status", "failed"))
        .order("desc")
        .take(INBOX_FAILED_LIMIT)
    ).filter((t) => visible.has(t.projectId as string) && (t.updatedAt ?? t._creationTime) >= since);
    const tasks = needsApproval.sort(
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
        ...failed.map((t) => t.projectId as string),
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
      /** The shared "waits on you" total (= sidebar Needs you). */
      waitingCount: waiting.total,
      /** Open agent questions (tasks waiting_input), as in Needs you. */
      questions: waiting.items
        .filter((i) => i.kind === "question")
        .map((i) => ({ key: i.key, title: i.title, taskId: i.taskId, projectId: i.projectId, projectName: i.projectName, agentRole: i.agentRole })),
      /** Pushes waiting for the Push click, as in Needs you. */
      pushes: waiting.items
        .filter((i) => i.kind === "push")
        .map((i) => ({ key: i.key, title: i.title, note: i.note, taskId: i.taskId, projectId: i.projectId, projectName: i.projectName })),
      /** Recent failed tasks: information only, not counted as waiting. */
      failed: failed.map((t) => ({ ...t, projectName: projectNameById.get(t.projectId as string) ?? "—" })),
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
