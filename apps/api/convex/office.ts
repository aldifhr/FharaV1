import { query } from "./_generated/server";
import { v } from "convex/values";
import { canViewProject, getViewerId } from "./lib/authz";

/**
 * /office (pixel office) read model: the project's recent subtasks (with
 * their live activity line), recent pushes and today's token usage — the
 * bits no existing per-project query returns. Read-only, bounded, no schema
 * change. Agents, tasks and pending approvals come from their own queries
 * (agents.listByProject, tasks.listByProject, approvals.listPendingForProject).
 */
const RECENT_TASKS = 15;
const PUSH_LIMIT = 10;
const USAGE_LIMIT = 2000;

export const feed = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const viewerId = await getViewerId(ctx);
    const project = await ctx.db.get(args.projectId);
    if (!project || !canViewProject(viewerId, project)) return null;

    // Subtasks of the newest tasks: what each agent is on now or just finished.
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(RECENT_TASKS);
    const subtasks = [];
    for (const task of tasks) {
      const rows = await ctx.db
        .query("subtasks")
        .withIndex("by_task", (q) => q.eq("taskId", task._id))
        .collect();
      for (const s of rows) {
        subtasks.push({
          _id: s._id,
          taskId: s.taskId,
          key: s.key,
          title: s.title,
          status: s.status,
          assignedAgentId: s.assignedAgentId,
          activity: s.activity,
          activityAt: s.activityAt,
          startedAt: s.startedAt,
          completedAt: s.completedAt,
          error: s.error ? s.error.slice(0, 200) : undefined,
        });
      }
    }

    const pushes = (
      await ctx.db
        .query("taskPushes")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .order("desc")
        .take(PUSH_LIMIT)
    ).map((p) => ({
      _id: p._id,
      taskId: p.taskId,
      status: p.status,
      branchName: p.branchName,
      error: p.error ? p.error.slice(0, 200) : undefined,
      pushedAt: p.pushedAt,
      updatedAt: p.updatedAt,
      prUrl: p.prUrl,
    }));

    // Today's usage (last 24 h), newest rows first, bounded.
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const usageRows = await ctx.db
      .query("tokenUsage")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(USAGE_LIMIT);
    let tokens = 0;
    let cost = 0;
    let costKnown = false;
    let calls = 0;
    for (const row of usageRows) {
      if (row.createdAt < since) break;
      if (row.kind === "playground") continue;
      calls += 1;
      tokens += row.inputTokens + row.outputTokens;
      if (typeof row.estimatedCost === "number") {
        cost += row.estimatedCost;
        costKnown = true;
      }
    }

    return {
      subtasks,
      pushes,
      usage: { tokens, cost: costKnown ? cost : null, calls, since },
    };
  },
});
