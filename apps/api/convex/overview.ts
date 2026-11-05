import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

export const get = query({
  args: {},
  handler: async (ctx) => {
    const projects = await ctx.db.query("projects").collect();
    const agents = await ctx.db.query("agents").collect();
    const approvals = await ctx.db.query("approvals").filter((q) => q.eq(q.field("status"), "pending")).order("desc").collect();
    const tasks = await ctx.db.query("tasks").order("desc").collect();

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
      agents: agents.map(({ llmApiKey, ...a }) => ({ ...a, llmApiKeyConfigured: Boolean(llmApiKey) })),
      agentByStatus,
      approvals: approvals.map((a) => ({ ...enrich(a), taskTitle: taskTitleById.get(a.taskId as string) ?? null })),
      recentTasks,
      taskCounts: { total: tasks.length, byStatus },
    };
  },
});
