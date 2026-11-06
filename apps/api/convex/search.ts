import { query } from "./_generated/server";
import { v } from "convex/values";

export const global = query({
  args: { q: v.string() },
  handler: async (ctx, args) => {
    const q = args.q.trim().toLowerCase();

    const [projects, tasks, agents] = await Promise.all([
      ctx.db.query("projects").collect(),
      ctx.db.query("tasks").order("desc").collect(),
      ctx.db.query("agents").collect(),
    ]);
    const nameById = new Map(projects.map((p) => [p._id as string, p.name]));

    const matches = (s: string) => !q || s.toLowerCase().includes(q);

    return {
      projects: projects.filter((p) => matches(p.name)).slice(0, 8),
      tasks: tasks
        .filter((t) => matches(t.title) || matches(t.command))
        .slice(0, 12)
        .map((t) => ({ ...t, projectName: nameById.get(t.projectId as string) ?? "—" })),
      agents: agents.filter((a) => matches(a.name) || matches(a.role)).slice(0, 8),
    };
  },
});
