import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { projectAgentDoc } from "./agents";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const approvals = await ctx.db
      .query("approvals")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .order("desc")
      .collect();
    const needsApproval = await ctx.db
      .query("tasks")
      .withIndex("by_status", (q) => q.eq("status", "needs_approval"))
      .order("desc")
      .collect();
    const failed = await ctx.db
      .query("tasks")
      .withIndex("by_status", (q) => q.eq("status", "failed"))
      .order("desc")
      .collect();
    const tasks = [...needsApproval, ...failed].sort(
      (a, b) => (b.updatedAt ?? b._creationTime) - (a.updatedAt ?? a._creationTime)
    );
    const agents = await ctx.db
      .query("agents")
      .filter((q) => q.eq(q.field("status"), "needs_you"))
      .collect();

    const projectIds = [...new Set<string>([...approvals.map((a) => a.projectId as string), ...tasks.map((t) => t.projectId as string)])] as Id<"projects">[];
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
    const agentNameById = new Map<string, string>();
    for (const id of agentIds) {
      const a = await ctx.db.get(id);
      if (a) agentNameById.set(a._id as string, a.name);
    }

    const approvalTaskIds = new Set(approvals.map((a) => a.taskId as string));

    return {
      approvals: approvals.map((a) => ({
        ...a,
        projectName: projectNameById.get(a.projectId as string) ?? "—",
        taskTitle: taskById.get(a.taskId as string)?.title ?? null,
        requestedByAgentName: a.requestedByAgentId
          ? (agentNameById.get(a.requestedByAgentId as string) ?? null)
          : null,
      })),
      tasks: tasks
        .filter((t) => !approvalTaskIds.has(t._id as string))
        .map((t) => ({ ...t, projectName: projectNameById.get(t.projectId as string) ?? "—" })),
      agents: agents.map(projectAgentDoc),
    };
  },
});
