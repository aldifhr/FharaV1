import { query } from "./_generated/server";
import { v } from "convex/values";

export const global = query({
  args: { q: v.string() },
  handler: async (ctx, args) => {
    const q = args.q.trim().toLowerCase();
    if (!q) return { projects: [], tasks: [], agents: [] };

    const [projects, tasks, agents] = await Promise.all([
      ctx.db.query("projects").collect(),
      ctx.db.query("tasks").order("desc").collect(),
      ctx.db.query("agents").collect(),
    ]);
    const nameById = new Map(projects.map((p) => [p._id as string, p.name]));

    return {
      projects: projects.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 8),
      tasks: tasks
        .filter((t) => t.title.toLowerCase().includes(q) || t.command.toLowerCase().includes(q))
        .slice(0, 12)
        .map((t) => ({ ...t, projectName: nameById.get(t.projectId as string) ?? "—" })),
      agents: agents
        .filter((a) => a.name.toLowerCase().includes(q) || a.role.toLowerCase().includes(q))
        .slice(0, 8)
        .map(({ llmApiKey, ...a }) => ({ ...a, llmApiKeyConfigured: Boolean(llmApiKey) })),
    };
  },
});
