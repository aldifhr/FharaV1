import { query } from "./_generated/server";
import { v } from "convex/values";
import { projectAgentDoc } from "./agents";
import { visibleProjects } from "./lib/authz";
import type { Doc, Id } from "./_generated/dataModel";

/** Bounded scan window (core M7): the newest tasks only. */
const SEARCH_TASK_WINDOW = 500;
/** Cap on member agents resolved for search. */
const SEARCH_AGENT_WINDOW = 200;

export const global = query({
  args: { q: v.string() },
  handler: async (ctx, args) => {
    const q = args.q.trim().toLowerCase();

    const [projects, recentTasks] = await Promise.all([
      visibleProjects(ctx),
      ctx.db.query("tasks").order("desc").take(SEARCH_TASK_WINDOW),
    ]);
    // Agents are scoped to the members of the visible projects, never a
    // table-wide scan (an agent of a hidden project must not show up).
    const memberIds = [
      ...new Set(projects.flatMap((p) => (p.agentIds ?? []) as Id<"agents">[])),
    ].slice(0, SEARCH_AGENT_WINDOW);
    const agents = (await Promise.all(memberIds.map((id) => ctx.db.get(id)))).filter(
      (a): a is Doc<"agents"> => a !== null
    );
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
