import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertProjectAccess, visibleProjects } from "./lib/authz";
import {
  DAY_MS,
  aggregateWorkload,
  roleBucket,
  routeMatch,
  type WorkloadExecutionInput,
  type WorkloadMessageInput,
  type WorkloadRouteInput,
  type WorkloadSubtaskInput,
  type WorkloadUsageInput,
} from "./lib/workload";

/**
 * Bounded reads. Window-scoped rows are read through `by_project` /
 * `by_project_and_type` with a `_creationTime >= since` range, so a read
 * never scans history outside the window. Each source is also capped; the
 * result says which caps were hit.
 */
const SUBTASK_LIMIT = 2000;
const TASK_LIMIT = 200;
const EXECUTIONS_PER_TASK = 200;
const USAGE_LIMIT = 8000;
const ROUTE_LIMIT = 4000;
const MESSAGE_LIMIT = 4000;
const AGENT_LIMIT = 200;
const ALLOWED_WINDOWS = [7, 30, 90];

export const byRole = query({
  args: {
    projectId: v.optional(v.id("projects")),
    sinceDays: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const sinceDays = ALLOWED_WINDOWS.includes(args.sinceDays ?? 30) ? args.sinceDays ?? 30 : 30;
    const now = Date.now();
    const since = now - sinceDays * DAY_MS;

    const projects: Doc<"projects">[] = args.projectId
      ? [await assertProjectAccess(ctx, args.projectId)]
      : await visibleProjects(ctx);

    const agents = await ctx.db.query("agents").take(AGENT_LIMIT);
    const roleById = new Map<string, string>(agents.map((a) => [a._id as string, a.role]));
    const roleOfAgent = (id: Id<"agents"> | undefined | null, fallbackName?: string | null): string | null =>
      (id ? roleById.get(id as string) : undefined) ?? (fallbackName?.trim() ? fallbackName : null);
    const roleByAgentName = new Map<string, string>(agents.map((a) => [a.name, a.role]));

    const truncated: string[] = [];
    const subtaskRows: Doc<"subtasks">[] = [];
    const usageRows: Doc<"tokenUsage">[] = [];
    const routeRows: Doc<"taskEvents">[] = [];
    const messageRows: Doc<"messages">[] = [];

    for (const project of projects) {
      const pid = project._id;
      const remaining = (limit: number, have: number) => Math.max(0, limit - have);
      if (subtaskRows.length < SUBTASK_LIMIT) {
        const rows = await ctx.db
          .query("subtasks")
          .withIndex("by_project", (q) => q.eq("projectId", pid).gte("_creationTime", since))
          .order("desc")
          .take(remaining(SUBTASK_LIMIT, subtaskRows.length) + 1);
        if (rows.length > remaining(SUBTASK_LIMIT, subtaskRows.length)) truncated.push("subtasks");
        subtaskRows.push(...rows.slice(0, remaining(SUBTASK_LIMIT, subtaskRows.length)));
      }
      if (usageRows.length < USAGE_LIMIT) {
        const rows = await ctx.db
          .query("tokenUsage")
          .withIndex("by_project", (q) => q.eq("projectId", pid).gte("_creationTime", since))
          .order("desc")
          .take(remaining(USAGE_LIMIT, usageRows.length) + 1);
        if (rows.length > remaining(USAGE_LIMIT, usageRows.length)) truncated.push("tokenUsage");
        usageRows.push(...rows.slice(0, remaining(USAGE_LIMIT, usageRows.length)));
      }
      if (routeRows.length < ROUTE_LIMIT) {
        const rows = await ctx.db
          .query("taskEvents")
          .withIndex("by_project_and_type", (q) =>
            q.eq("projectId", pid).eq("type", "subtask.routed").gte("_creationTime", since)
          )
          .order("desc")
          .take(remaining(ROUTE_LIMIT, routeRows.length) + 1);
        if (rows.length > remaining(ROUTE_LIMIT, routeRows.length)) truncated.push("routes");
        routeRows.push(...rows.slice(0, remaining(ROUTE_LIMIT, routeRows.length)));
      }
      if (messageRows.length < MESSAGE_LIMIT) {
        const rows = await ctx.db
          .query("messages")
          .withIndex("by_project", (q) => q.eq("projectId", pid).gte("_creationTime", since))
          .order("desc")
          .take(remaining(MESSAGE_LIMIT, messageRows.length) + 1);
        if (rows.length > remaining(MESSAGE_LIMIT, messageRows.length)) truncated.push("messages");
        messageRows.push(...rows.slice(0, remaining(MESSAGE_LIMIT, messageRows.length)));
      }
    }

    // Executions have no project index: read them per task, for the tasks
    // whose subtasks fall in the window (newest first, capped).
    const taskIds: Id<"tasks">[] = [];
    const seenTasks = new Set<string>();
    for (const s of subtaskRows) {
      if (seenTasks.has(s.taskId as string)) continue;
      seenTasks.add(s.taskId as string);
      taskIds.push(s.taskId);
    }
    if (taskIds.length > TASK_LIMIT) truncated.push("executions");
    const kindByKey = new Map<string, string>(subtaskRows.map((s) => [`${s.taskId}::${s.key}`, s.kind]));
    const executions: WorkloadExecutionInput[] = [];
    for (const taskId of taskIds.slice(0, TASK_LIMIT)) {
      const rows = await ctx.db
        .query("executions")
        .withIndex("by_task", (q) => q.eq("taskId", taskId))
        .take(EXECUTIONS_PER_TASK);
      for (const e of rows) {
        executions.push({
          taskId: e.taskId as string,
          subtaskKey: e.subtaskKey ?? null,
          kind: e.subtaskKey ? kindByKey.get(`${e.taskId}::${e.subtaskKey}`) ?? null : null,
          role: roleOfAgent(e.agentId, e.agentName),
          status: e.status,
          startedAt: e.startedAt ?? null,
          completedAt: e.completedAt ?? null,
          at: e.startedAt ?? e.createdAt,
        });
      }
    }

    const subtasks: WorkloadSubtaskInput[] = subtaskRows.map((s) => ({
      taskId: s.taskId as string,
      key: s.key,
      kind: s.kind,
      status: s.status,
      origin: s.origin ?? null,
      role: s.assignedAgentId || s.assignedAgentName ? roleOfAgent(s.assignedAgentId, s.assignedAgentName) : null,
      at: s.startedAt ?? s._creationTime,
      startedAt: s.startedAt ?? null,
      completedAt: s.completedAt ?? null,
    }));
    const usage: WorkloadUsageInput[] = usageRows.map((u) => ({
      role: roleOfAgent(u.agentId, u.agentName),
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      estimatedCost: u.estimatedCost ?? null,
      estimated: u.estimated ?? false,
      at: u.createdAt,
    }));
    const routes: WorkloadRouteInput[] = routeRows.map((e) => {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      const agentName = typeof p.agent === "string" ? p.agent : null;
      const role =
        (typeof p.role === "string" && p.role.trim() ? p.role : null) ??
        (agentName ? roleByAgentName.get(agentName) ?? agentName : null) ??
        roleOfAgent(e.agentId);
      return {
        taskId: e.taskId as string,
        subtaskKey: (typeof p.subtaskKey === "string" ? p.subtaskKey : null) ?? e.subtaskKey ?? null,
        role,
        match: routeMatch(p),
        at: e.createdAt ?? e._creationTime,
      };
    });
    const messages: WorkloadMessageInput[] = messageRows
      .filter((m) => m.authorType === "agent")
      .map((m) => ({ role: roleOfAgent(m.agentId), at: m._creationTime }));

    const rosterRoles = agents.filter((a) => a.isEnabled !== false && !a.retiredAt).map((a) => a.role);
    const result = aggregateWorkload({ now, sinceDays, rosterRoles, subtasks, executions, usage, routes, messages });

    return {
      ...result,
      projectId: args.projectId ?? null,
      projectCount: projects.length,
      truncated: [...new Set(truncated)],
      /** What the numbers can and cannot tell (rendered under the table). */
      detection: {
        fallbackRoutes: "Counted from subtask.routed events (exact = the agent declares the capability).",
        normalizeRoleFallback:
          "Not detectable as a route: the worker routes by declared capabilities, and subtask.routed stores the agent's raw role. Agents whose stored role is not one of the nine fixed roles are listed under their own label (marked unrecognized) instead.",
        unrecognizedRoles: result.rows.filter((r) => !r.recognized && r.key !== "unattributed").map((r) => roleBucket(r.key).label),
      },
    };
  },
});
