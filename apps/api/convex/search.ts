import { query } from "./_generated/server";
import { v } from "convex/values";
import { projectAgentDoc } from "./agents";
import { visibleProjects } from "./lib/authz";

/** Bounded scan window (core M7): the newest tasks only. */
const SEARCH_TASK_WINDOW = 500;

export const global = query({
  args: { q: v.string() },
  handler: async (ctx, args) => {
    const q = args.q.trim().toLowerCase();

    const [projects, recentTasks, agents] = await Promise.all([
      visibleProjects(ctx),
      ctx.db.query("tasks").order("desc").take(SEARCH_TASK_WINDOW),
      ctx.db.query("agents").take(200),
    ]);
    // Scoped to the projects the caller may see (core H5).
    const visible = new Set(projects.map((p) => p._id as string));
    const tasks = recentTasks.filter((t) => visible.has(t.projectId as string));
    const nameById = new Map(projects.map((p) => [p._id as string, p.name]));

    const matches = (s: string) => !q || s.toLowerCase().includes(q);

    return {
      projects: projects.filter((p) => matches(p.name)).slice(0, 8),
      tasks: tasks
        .filter((t) => matches(t.title) || matches(t.command))
        .slice(0, 12)
        .map((t) => ({ ...t, projectName: nameById.get(t.projectId as string) ?? "—" })),
      agents: agents
        .filter((a) => matches(a.name) || matches(a.role))
        .slice(0, 8)
        .map((a) => ({
          ...projectAgentDoc(a),
          projectId: projects.find((p) => (p.agentIds ?? []).includes(a._id))?._id ?? null,
        })),
    };
  },
});
