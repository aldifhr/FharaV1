import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { visibleProjects } from "./lib/authz";

/** Bounded reads (core M7): the dashboard must not scan whole tables. */
const OVERVIEW_TASK_LIMIT = 1000;
const OVERVIEW_APPROVAL_LIMIT = 200;
const OVERVIEW_AGENT_LIMIT = 200;

export const get = query({
  args: {},
  handler: async (ctx) => {
    // Scoped to the projects the caller may see (core H5).
    const projects = (await visibleProjects(ctx)).sort(
      (a, b) => b._creationTime - a._creationTime
    );
    const visible = new Set(projects.map((p) => p._id as string));
    const agents = await ctx.db.query("agents").take(OVERVIEW_AGENT_LIMIT);
    const approvals = (
      await ctx.db
        .query("approvals")
        .withIndex("by_status", (q) => q.eq("status", "pending"))
        .order("desc")
        .take(OVERVIEW_APPROVAL_LIMIT)
    ).filter((a) => visible.has(a.projectId as string));
    // Counts cover the most recent OVERVIEW_TASK_LIMIT tasks.
    const recent = await ctx.db.query("tasks").order("desc").take(OVERVIEW_TASK_LIMIT);
    const tasksTruncated = recent.length >= OVERVIEW_TASK_LIMIT;
    const tasks = recent.filter((t) => visible.has(t.projectId as string));

    const byStatus: Record<string, number> = {};
    for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;

    const projectNameById = new Map<string, string>();
    for (const p of projects) projectNameById.set(p._id as string, p.name);

    const recentTasks = tasks.slice(0, 8).map((t) => ({
      ...t,
      projectName: projectNameById.get(t.projectId as string) ?? "—",
    }));

    const perProject = projects.map((p) => {
      const ptasks = tasks.filter((t) => t.projectId === p._id);
      return {
        ...p,
        totalTasks: ptasks.length,
        running: ptasks.filter((t) => t.status === "running").length,
        needsApproval: ptasks.filter((t) => t.status === "needs_approval").length,
        failed: ptasks.filter((t) => t.status === "failed").length,
        pendingApprovals: approvals.filter((a) => a.projectId === p._id).length,
      };
    });

    const agentByStatus: Record<string, number> = {};
    for (const a of agents) agentByStatus[a.status] = (agentByStatus[a.status] ?? 0) + 1;

    const enrich = (a: typeof approvals[number]) => ({
      ...a,
      projectName: projectNameById.get(a.projectId as string) ?? "—",
    });

    const taskTitleById = new Map<string, string>();
    // ponytail: fetch task titles only for pending approvals
    const taskIds = [...new Set(approvals.map((a) => a.taskId as string))] as Id<"tasks">[];
    for (const id of taskIds) {
      const t = await ctx.db.get(id);
      if (t) taskTitleById.set(t._id as string, t.title);
    }

    return {
      projects,
      perProject,
      agents,
      agentByStatus,
      approvals: approvals.map((a) => ({ ...enrich(a), taskTitle: taskTitleById.get(a.taskId as string) ?? null })),
      recentTasks,
      taskCounts: { total: tasks.length, byStatus, truncated: tasksTruncated },
    };
  },
});
