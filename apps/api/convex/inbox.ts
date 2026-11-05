import { query } from "./_generated/server";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const approvals = await ctx.db
      .query("approvals")
      .filter((q) => q.eq(q.field("status"), "pending"))
      .order("desc")
      .collect();
    const tasks = await ctx.db
      .query("tasks")
      .filter((q) =>
        q.or(q.eq(q.field("status"), "needs_approval"), q.eq(q.field("status"), "failed"))
      )
      .order("desc")
      .collect();
    const agents = await ctx.db
      .query("agents")
      .filter((q) => q.eq(q.field("status"), "needs_you"))
      .collect();

    const projectIds = new Set<string>([
      ...approvals.map((a) => a.projectId),
      ...tasks.map((t) => t.projectId),
    ]);
    const projects = await Promise.all([...projectIds].map((id) => ctx.db.get(id as never)));
    const projectNameById = new Map(
      projects.filter(Boolean).map((p) => [p!._id as string, p!.name as string])
    );

    const taskIds = new Set<string>([...approvals.map((a) => a.taskId), ...tasks.map((t) => t._id)]);
    const allTasks = await Promise.all([...taskIds].map((id) => ctx.db.get(id as never)));
    const taskById = new Map(allTasks.filter(Boolean).map((t) => [t!._id as string, t!]));

    const agentIds = new Set<string>(
      approvals.map((a) => a.requestedByAgentId).filter(Boolean) as string[]
    );
    const allAgents = await Promise.all([...agentIds].map((id) => ctx.db.get(id as never)));
    const agentNameById = new Map(
      allAgents.filter(Boolean).map((a) => [a!._id as string, a!.name as string])
    );

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
      agents,
    };
  },
});
