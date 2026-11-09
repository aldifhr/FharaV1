import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertProjectAccess, canViewProject, getViewerId, visibleProjects } from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";
import { ROLES, isRoleKey } from "./lib/roles";
import { DAY_MS, roleBucket } from "./lib/workload";
import { buildOrgChart, type OrgAgentInput } from "./lib/orgChart";
import {
  ACTIVE_EXECUTION_STATUSES,
  buildCapacity,
  countActiveByAgent,
  type CapacityExecutionInput,
} from "./lib/capacity";
import { aggregateAgentProfile, type ProfileVerdictInput } from "./lib/agentProfile";
import { buildCollaborationGraph, type CollabMessageInput, type CollabSubtaskInput } from "./lib/collaboration";

/**
 * Organizational Intelligence for the Team page: org chart, per-agent
 * performance profile, live capacity (+ the load-aware routing setting),
 * and the collaboration graph. Read-only projections over rows the backend
 * already records; every read is bounded and window reads use
 * `by_project*` indexes with a `_creationTime` range. Results say which
 * caps were hit (`truncated`).
 */

const ALLOWED_WINDOWS = [7, 30, 90];
const AGENT_LIMIT = 200;
const SUBTASK_LIMIT = 2000;
const TASK_LIMIT = 200;
const USAGE_LIMIT = 8000;
const MESSAGE_LIMIT = 4000;
const EVENT_LIMIT = 2000;
const EXECUTION_LIMIT = 2000;
const ACTIVE_LIMIT = 400;
const VERDICT_TYPES = ["review.approved", "review.requested_changes", "qa.passed", "qa.failed", "qa.blocked"] as const;

const windowDays = (value: number | undefined) => (ALLOWED_WINDOWS.includes(value ?? 30) ? value ?? 30 : 30);

async function scopeProjects(ctx: QueryCtx, projectId: Id<"projects"> | undefined): Promise<Doc<"projects">[]> {
  return projectId ? [await assertProjectAccess(ctx, projectId)] : await visibleProjects(ctx);
}

/** Read up to `limit` rows across projects, newest first, noting a cap hit. */
async function readWindow<T>(
  projects: Doc<"projects">[],
  limit: number,
  read: (projectId: Id<"projects">, take: number) => Promise<T[]>,
  onTruncated: () => void
): Promise<T[]> {
  const out: T[] = [];
  for (const p of projects) {
    const left = limit - out.length;
    if (left <= 0) {
      onTruncated();
      break;
    }
    const rows = await read(p._id, left + 1);
    if (rows.length > left) onTruncated();
    out.push(...rows.slice(0, left));
  }
  return out;
}

function modelLabelOf(agent: Doc<"agents">, models: Map<string, Doc<"llmModels">>): string {
  if (agent.executionRuntime === "opencode" && agent.opencodeModel) return agent.opencodeModel;
  if (agent.llmModelId) {
    const m = models.get(agent.llmModelId as string);
    if (m) return m.displayName || m.modelId;
  }
  return agent.llmModel || "Default model";
}

// ─── 1. Org chart ───────────────────────────────────────────────────────

export const orgChart = query({
  args: {},
  handler: async (ctx) => {
    const agents = await ctx.db.query("agents").take(AGENT_LIMIT);
    const registry = await ctx.db.query("roleDefinitions").take(100);
    const models = new Map<string, Doc<"llmModels">>();
    for (const a of agents) {
      if (a.llmModelId && !models.has(a.llmModelId as string)) {
        const m = await ctx.db.get(a.llmModelId);
        if (m) models.set(a.llmModelId as string, m);
      }
    }
    const input: OrgAgentInput[] = agents.map((a) => {
      const bucket = roleBucket(a.role);
      const fixed = isRoleKey(bucket.key) ? ROLES[bucket.key] : null;
      return {
        id: a._id as string,
        name: a.name,
        role: a.role,
        enabled: a.isEnabled !== false,
        retired: typeof a.retiredAt === "number",
        model: modelLabelOf(a, models),
        runtime: a.executionRuntime === "opencode" ? "opencode" : "api",
        skills: a.skillIds?.length ?? 0,
        tools: a.supportedTools ?? (fixed ? [...fixed.defaultTools] : []),
        capabilities: a.capabilities ?? (fixed ? [...fixed.capabilities] : []),
        priority: a.priority ?? null,
        maxConcurrency: a.maxConcurrency ?? null,
      };
    });
    return buildOrgChart(
      input,
      registry.map((r) => ({ key: r.key, name: r.name, enabled: r.enabled }))
    );
  },
});

// ─── 2. Agent performance profile ───────────────────────────────────────

export const agentProfile = query({
  args: {
    agentId: v.id("agents"),
    projectId: v.optional(v.id("projects")),
    sinceDays: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const agent = await ctx.db.get(args.agentId);
    if (!agent) return null;
    const sinceDays = windowDays(args.sinceDays);
    const now = Date.now();
    const since = now - sinceDays * DAY_MS;
    const projects = await scopeProjects(ctx, args.projectId);
    const projectIds = new Set(projects.map((p) => p._id as string));
    const truncated = new Set<string>();
    const mine = (id: Id<"agents"> | undefined, name: string | undefined) =>
      id ? id === agent._id : Boolean(name) && name === agent.name;

    const subtaskRows = (
      await readWindow(
        projects,
        SUBTASK_LIMIT,
        (pid, take) =>
          ctx.db
            .query("subtasks")
            .withIndex("by_project", (q) => q.eq("projectId", pid).gte("_creationTime", since))
            .order("desc")
            .take(take),
        () => truncated.add("subtasks")
      )
    ).filter((s) => (s.assignedAgentId || s.assignedAgentName ? mine(s.assignedAgentId, s.assignedAgentName) : false));

    const executionRows = (
      await ctx.db
        .query("executions")
        .withIndex("by_agent", (q) => q.eq("agentId", agent._id).gte("_creationTime", since))
        .order("desc")
        .take(EXECUTION_LIMIT + 1)
    ).filter((e, i) => {
      if (i === EXECUTION_LIMIT) truncated.add("executions");
      return i < EXECUTION_LIMIT && projectIds.has(e.projectId as string);
    });

    const usageRows = (
      await readWindow(
        projects,
        USAGE_LIMIT,
        (pid, take) =>
          ctx.db
            .query("tokenUsage")
            .withIndex("by_project", (q) => q.eq("projectId", pid).gte("_creationTime", since))
            .order("desc")
            .take(take),
        () => truncated.add("tokenUsage")
      )
    ).filter((u) => mine(u.agentId, u.agentName));

    const messageRows = await readWindow(
      projects,
      MESSAGE_LIMIT,
      (pid, take) =>
        ctx.db
          .query("messages")
          .withIndex("by_project", (q) => q.eq("projectId", pid).gte("_creationTime", since))
          .order("desc")
          .take(take),
      () => truncated.add("messages")
    );
    const chatReplies = messageRows.filter((m) => m.authorType === "agent" && m.agentId === agent._id).length;

    const taskIds = [...new Set(subtaskRows.map((s) => s.taskId as string))];
    const taskSet = new Set(taskIds);
    const verdicts: ProfileVerdictInput[] = [];
    for (const type of VERDICT_TYPES) {
      const rows = await readWindow(
        projects,
        EVENT_LIMIT,
        (pid, take) =>
          ctx.db
            .query("taskEvents")
            .withIndex("by_project_and_type", (q) => q.eq("projectId", pid).eq("type", type).gte("_creationTime", since))
            .order("desc")
            .take(take),
        () => truncated.add("verdict events")
      );
      for (const e of rows) {
        if (taskSet.has(e.taskId as string)) verdicts.push({ taskId: e.taskId as string, type, at: e.createdAt ?? e._creationTime });
      }
    }

    if (taskIds.length > TASK_LIMIT) truncated.add("evaluations");
    const evaluations = [];
    const titles = new Map<string, string>();
    for (const taskId of taskIds.slice(0, TASK_LIMIT)) {
      const rows = await ctx.db
        .query("evaluations")
        .withIndex("by_task", (q) => q.eq("taskId", taskId as Id<"tasks">))
        .take(20);
      for (const e of rows) evaluations.push({ taskId, verdict: e.verdict, at: e.createdAt });
    }

    const profile = aggregateAgentProfile({
      now,
      sinceDays,
      subtasks: subtaskRows.map((s) => ({
        taskId: s.taskId as string,
        key: s.key,
        title: s.title,
        kind: s.kind,
        status: s.status,
        origin: s.origin ?? null,
        at: s.startedAt ?? s._creationTime,
        startedAt: s.startedAt ?? null,
        completedAt: s.completedAt ?? null,
      })),
      executions: executionRows.map((e) => ({
        taskId: e.taskId as string,
        subtaskKey: e.subtaskKey ?? null,
        status: e.status,
        attempt: e.attempt,
        startedAt: e.startedAt ?? null,
        completedAt: e.completedAt ?? null,
        at: e.startedAt ?? e.createdAt,
      })),
      usage: usageRows.map((u) => ({
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        estimatedCost: u.estimatedCost ?? null,
        estimated: u.estimated ?? false,
        at: u.createdAt,
      })),
      verdicts,
      evaluations,
      chatReplies,
    });
    for (const r of profile.recent) {
      if (!titles.has(r.taskId)) {
        const task = await ctx.db.get(r.taskId as Id<"tasks">);
        titles.set(r.taskId, task?.title ?? "");
      }
      r.taskTitle = titles.get(r.taskId) || null;
    }

    const bucket = roleBucket(agent.role);
    return {
      agent: {
        _id: agent._id,
        role: agent.role,
        label: bucket.label,
        recognized: bucket.recognized,
        enabled: agent.isEnabled !== false,
        runtime: agent.executionRuntime === "opencode" ? "opencode" : "api",
        maxConcurrency: agent.maxConcurrency ?? null,
        priority: agent.priority ?? null,
      },
      ...profile,
      projectId: args.projectId ?? null,
      truncated: [...truncated],
    };
  },
});

// ─── 3. Workload Manager: capacity + load-aware routing setting ─────────

async function readActiveExecutions(ctx: QueryCtx): Promise<{ rows: CapacityExecutionInput[]; truncated: boolean }> {
  const rows: CapacityExecutionInput[] = [];
  let truncated = false;
  const tasks = new Map<string, Doc<"tasks"> | null>();
  for (const status of ACTIVE_EXECUTION_STATUSES) {
    const list = await ctx.db
      .query("executions")
      .withIndex("by_status", (q) => q.eq("status", status))
      .order("desc")
      .take(ACTIVE_LIMIT + 1);
    if (list.length > ACTIVE_LIMIT) truncated = true;
    for (const e of list.slice(0, ACTIVE_LIMIT)) {
      if (!tasks.has(e.taskId as string)) tasks.set(e.taskId as string, await ctx.db.get(e.taskId));
      const task = tasks.get(e.taskId as string) ?? null;
      rows.push({
        agentId: (e.agentId as string | undefined) ?? null,
        status: e.status,
        taskStatus: task?.status ?? null,
        leaseExpiresAt: e.leaseExpiresAt ?? null,
        taskId: e.taskId as string,
        taskTitle: task?.title ?? null,
        projectId: e.projectId as string,
        subtaskKey: e.subtaskKey ?? null,
        startedAt: e.startedAt ?? null,
      });
    }
  }
  return { rows, truncated };
}

export const capacity = query({
  args: { projectId: v.optional(v.id("projects")) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const project = args.projectId ? await assertProjectAccess(ctx, args.projectId) : null;
    const viewerId = await getViewerId(ctx);
    const visible = new Map<string, boolean>();
    const { rows, truncated } = await readActiveExecutions(ctx);
    const scoped: CapacityExecutionInput[] = [];
    for (const e of rows) {
      if (project && e.projectId !== (project._id as string)) continue;
      if (!visible.has(e.projectId)) {
        visible.set(e.projectId, canViewProject(viewerId, await ctx.db.get(e.projectId as Id<"projects">)));
      }
      if (visible.get(e.projectId)) scoped.push(e);
    }
    let agents = await ctx.db.query("agents").take(AGENT_LIMIT);
    if (project?.agentIds && project.agentIds.length > 0) {
      const members = new Set(project.agentIds.map(String));
      agents = agents.filter((a) => members.has(a._id as string));
    }
    agents = agents.filter((a) => !(a.retiredAt && a.isEnabled === false));
    const view = buildCapacity(
      agents.map((a) => ({
        id: a._id as string,
        name: a.name,
        role: a.role,
        enabled: a.isEnabled !== false,
        maxConcurrency: a.maxConcurrency ?? null,
        priority: a.priority ?? null,
      })),
      scoped,
      now
    );
    return {
      ...view,
      projectId: args.projectId ?? null,
      /** The selected project's setting; null = unset (worker env default, off unless enabled there). */
      loadAwareRouting: project ? project.loadAwareRouting ?? null : null,
      /** Plan 027: null = unset (worker env ORCHESTRATOR_PERFORMANCE_ROUTING, off by default). */
      performanceRouting: project ? project.performanceRouting ?? null : null,
      truncated,
    };
  },
});

/** Running executions per agent across every task (worker: load-aware routing). */
export const agentLoad = internalQuery({
  args: {},
  handler: async (ctx): Promise<Record<string, number>> => {
    const { rows } = await readActiveExecutions(ctx);
    return countActiveByAgent(rows, Date.now());
  },
});

export const setLoadAwareRouting = mutation({
  args: { projectId: v.id("projects"), enabled: v.union(v.boolean(), v.null()) },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);
    const next = args.enabled ?? undefined;
    if (project.loadAwareRouting === next) return args.enabled;
    await ctx.db.patch(args.projectId, { loadAwareRouting: next });
    await recordAudit(ctx, {
      action: "project.update",
      target: project.name,
      projectId: args.projectId,
      details: { changed: ["loadAwareRouting"], loadAwareRouting: args.enabled },
    });
    return args.enabled;
  },
});

// ─── 4. Collaboration graph ─────────────────────────────────────────────

export const collaboration = query({
  args: {
    projectId: v.optional(v.id("projects")),
    sinceDays: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const sinceDays = windowDays(args.sinceDays);
    const now = Date.now();
    const since = now - sinceDays * DAY_MS;
    const projects = await scopeProjects(ctx, args.projectId);
    const truncated = new Set<string>();
    const agents = await ctx.db.query("agents").take(AGENT_LIMIT);
    const roleById = new Map(agents.map((a) => [a._id as string, a.role]));
    const roleByName = new Map(agents.map((a) => [a.name, a.role]));
    const roleOf = (id: Id<"agents"> | undefined, name?: string) =>
      (id ? roleById.get(id as string) : undefined) ?? (name ? roleByName.get(name) ?? null : null);

    const subtaskRows = await readWindow(
      projects,
      SUBTASK_LIMIT,
      (pid, take) =>
        ctx.db
          .query("subtasks")
          .withIndex("by_project", (q) => q.eq("projectId", pid).gte("_creationTime", since))
          .order("desc")
          .take(take),
      () => truncated.add("subtasks")
    );
    const subtasks: CollabSubtaskInput[] = subtaskRows.map((s) => ({
      taskId: s.taskId as string,
      key: s.key,
      kind: s.kind,
      origin: s.origin ?? null,
      role: s.assignedAgentId || s.assignedAgentName ? roleOf(s.assignedAgentId, s.assignedAgentName) : null,
      dependencies: s.dependencies,
      at: s.startedAt ?? s._creationTime,
    }));

    // Delegations have only a by_task index: read them for the window's tasks.
    const taskIds = [...new Set(subtaskRows.map((s) => s.taskId as string))];
    if (taskIds.length > TASK_LIMIT) truncated.add("delegations");
    const delegations = [];
    for (const taskId of taskIds.slice(0, TASK_LIMIT)) {
      const rows = await ctx.db
        .query("delegations")
        .withIndex("by_task", (q) => q.eq("taskId", taskId as Id<"tasks">))
        .take(100);
      for (const d of rows) {
        delegations.push({ fromRole: roleOf(d.fromAgentId), toRole: roleOf(d.toAgentId), at: d.createdAt });
      }
    }

    const messageRows = await readWindow(
      projects,
      MESSAGE_LIMIT,
      (pid, take) =>
        ctx.db
          .query("messages")
          .withIndex("by_project", (q) => q.eq("projectId", pid).gte("_creationTime", since))
          .order("desc")
          .take(take),
      () => truncated.add("messages")
    );
    const messages: CollabMessageInput[] = messageRows.map((m) => ({
      id: m._id as string,
      conversationId: (m.conversationId as string | undefined) ?? null,
      authorType: m.authorType,
      agentId: (m.agentId as string | undefined) ?? null,
      content: m.content,
      handoffFromAgentId: (m.handoffFromAgentId as string | undefined) ?? null,
      at: m._creationTime,
    }));

    const graph = buildCollaborationGraph({
      now,
      sinceDays,
      agents: agents.map((a) => ({ id: a._id as string, name: a.name, role: a.role })),
      rosterRoles: agents.filter((a) => a.isEnabled !== false && !a.retiredAt).map((a) => a.role),
      subtasks,
      delegations,
      messages,
    });
    return { ...graph, projectId: args.projectId ?? null, truncated: [...truncated] };
  },
});

/** Chat: mark a teammate reply as a CTO @mention handoff (collaboration graph). */
export const markChatHandoff = internalMutation({
  args: { messageId: v.id("messages"), fromAgentId: v.id("agents") },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message || message.authorType !== "agent") return null;
    await ctx.db.patch(args.messageId, { handoffFromAgentId: args.fromAgentId });
    return null;
  },
});
