/**
 * Read models for the workspace shell (sidebar "Needs you", team live
 * status, project badges, usage meter). Every read is index-backed and
 * bounded with `.take()`; global feeds are scoped to the projects the
 * caller may see (core H5), project feeds assert project access.
 */
import { query, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { assertProjectAccess, canViewProject, getViewerId, visibleProjects } from "./lib/authz";

const APPROVAL_LIMIT = 100;
const TASK_STATUS_LIMIT = 100;
const EXECUTION_LIMIT = 200;
const NEEDS_YOU_LIMIT = 50;
const USAGE_ROW_LIMIT = 5000;
const WORKER_LIMIT = 50;
/** A worker whose last heartbeat is older than this is not counted as live. */
const WORKER_FRESH_MS = 90_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const TERMINAL = new Set(["done", "failed", "rejected"]);

// ─── Needs you ─────────────────────────────────────────────────────────────

export type NeedsYouKind =
  | "push"
  | "changes"
  | "command"
  | "merge"
  | "question"
  | "review";

export type NeedsYouItem = {
  /** Stable key: one row per (source, record). */
  key: string;
  kind: NeedsYouKind;
  title: string;
  /** Raw role of the agent that is waiting (client maps it to a label). */
  agentRole: string | null;
  /** Short status shown instead of a time ("draft ready", "question"). */
  note: string | null;
  projectId: Id<"projects">;
  projectName: string;
  taskId: Id<"tasks"> | null;
  approvalId: Id<"approvals"> | null;
  at: number;
};

type SourceCtx = {
  ctx: QueryCtx;
  visible: Map<string, Doc<"projects">>;
  agentRole: (id: Id<"agents"> | undefined | null) => Promise<string | null>;
};

type NeedsYouSource = (s: SourceCtx) => Promise<NeedsYouItem[]>;

const APPROVAL_KIND: Record<string, NeedsYouKind> = {
  git_push: "push",
  apply_changes: "changes",
  run_command: "command",
  merge_pr: "merge",
};

/** Pending approvals: push, apply-changes, run-command, merge. */
const pendingApprovals: NeedsYouSource = async ({ ctx, visible, agentRole }) => {
  const rows = await ctx.db
    .query("approvals")
    .withIndex("by_status", (q) => q.eq("status", "pending"))
    .order("desc")
    .take(APPROVAL_LIMIT);
  const items: NeedsYouItem[] = [];
  for (const a of rows) {
    const project = visible.get(a.projectId as string);
    if (!project) continue;
    items.push({
      key: `approval:${a._id}`,
      kind: APPROVAL_KIND[a.kind] ?? "review",
      title: a.summary,
      agentRole: await agentRole(a.requestedByAgentId ?? a.principalAgentId),
      note: null,
      projectId: a.projectId,
      projectName: project.name,
      taskId: a.taskId,
      approvalId: a._id,
      at: a._creationTime,
    });
  }
  return items;
};

/** Agent questions the user has not answered yet (task `waiting_input`). */
const openQuestions: NeedsYouSource = async ({ ctx, visible, agentRole }) => {
  const rows = await ctx.db
    .query("tasks")
    .withIndex("by_status", (q) => q.eq("status", "waiting_input"))
    .order("desc")
    .take(TASK_STATUS_LIMIT);
  const items: NeedsYouItem[] = [];
  for (const t of rows) {
    const project = visible.get(t.projectId as string);
    if (!project) continue;
    const question = t.pendingQuestion?.trim();
    items.push({
      key: `question:${t._id}`,
      kind: "question",
      title: question ? truncate(question, 90) : `Answer: ${t.title}`,
      agentRole: await agentRole(t.assignedAgentIds?.[0]),
      note: "question",
      projectId: t.projectId,
      projectName: project.name,
      taskId: t._id,
      approvalId: null,
      at: t.updatedAt ?? t._creationTime,
    });
  }
  return items;
};

/** Tasks parked in `needs_approval` (their approval row may be on another
 *  page or pre-date approval rows); deduped against approvals below. */
const tasksAwaitingApproval: NeedsYouSource = async ({ ctx, visible, agentRole }) => {
  const rows = await ctx.db
    .query("tasks")
    .withIndex("by_status", (q) => q.eq("status", "needs_approval"))
    .order("desc")
    .take(TASK_STATUS_LIMIT);
  const items: NeedsYouItem[] = [];
  for (const t of rows) {
    const project = visible.get(t.projectId as string);
    if (!project) continue;
    items.push({
      key: `task:${t._id}`,
      kind: "review",
      title: `Review ${t.title}`,
      agentRole: await agentRole(t.assignedAgentIds?.[0]),
      note: "draft ready",
      projectId: t.projectId,
      projectName: project.name,
      taskId: t._id,
      approvalId: null,
      at: t.updatedAt ?? t._creationTime,
    });
  }
  return items;
};

const PUSH_LIMIT = 100;

/**
 * Committed task branches waiting on the user's Push click (plan 019
 * `taskPushes`): `ready` rows (held or not) and pushes that failed. A
 * `requested`/`pushing` row is already in the worker's hands.
 */
const pendingPushes: NeedsYouSource = async ({ ctx, visible }) => {
  const items: NeedsYouItem[] = [];
  for (const status of ["ready", "failed"] as const) {
    const rows = await ctx.db
      .query("taskPushes")
      .withIndex("by_status_and_requested", (q) => q.eq("status", status))
      .order("desc")
      .take(PUSH_LIMIT);
    for (const p of rows) {
      const project = visible.get(p.projectId as string);
      if (!project) continue;
      const task = await ctx.db.get(p.taskId);
      // A finished-then-rejected/abandoned task no longer asks for a push.
      if (task?.status === "rejected") continue;
      items.push({
        key: `push:${p._id}`,
        kind: "push",
        title: `Push ${task?.title ?? p.branchName}`,
        agentRole: null,
        note: status === "failed" ? "push failed" : p.heldAt ? "on hold" : `${p.filesChanged} file${p.filesChanged === 1 ? "" : "s"} ready`,
        projectId: p.projectId,
        projectName: project.name,
        taskId: p.taskId,
        approvalId: null,
        at: p.updatedAt ?? p.createdAt,
      });
    }
  }
  return items;
};

/**
 * Ordered sources. Add a new kind of "needs you" by appending one function
 * here; a "review" item whose task is already covered by an earlier source
 * is dropped.
 */
export const NEEDS_YOU_SOURCES: NeedsYouSource[] = [
  pendingApprovals,
  pendingPushes,
  openQuestions,
  tasksAwaitingApproval,
];

export const needsYou = query({
  args: {},
  handler: async (ctx) => {
    const projects = await visibleProjects(ctx);
    const visible = new Map(projects.map((p) => [p._id as string, p]));
    const roleCache = new Map<string, string | null>();
    const agentRole = async (id: Id<"agents"> | undefined | null) => {
      if (!id) return null;
      const key = id as string;
      if (!roleCache.has(key)) roleCache.set(key, (await ctx.db.get(id))?.role ?? null);
      return roleCache.get(key) ?? null;
    };
    const items: NeedsYouItem[] = [];
    const coveredTasks = new Set<string>();
    for (const source of NEEDS_YOU_SOURCES) {
      const batch = await source({ ctx, visible, agentRole });
      const fresh = batch.filter((item) => !(item.kind === "review" && item.taskId && coveredTasks.has(item.taskId as string)));
      for (const item of fresh) if (item.taskId) coveredTasks.add(item.taskId as string);
      items.push(...fresh);
    }
    items.sort((a, b) => b.at - a.at);
    return { items: items.slice(0, NEEDS_YOU_LIMIT), total: items.length };
  },
});

// ─── Project badges ────────────────────────────────────────────────────────

/** Per visible project: tasks in flight and items needing the user. */
export const projectCounts = query({
  args: {},
  handler: async (ctx) => {
    const visible = new Set((await visibleProjects(ctx)).map((p) => p._id as string));
    const counts: Record<string, { open: number; needsYou: number }> = {};
    const bump = (projectId: string, field: "open" | "needsYou") => {
      if (!visible.has(projectId)) return;
      counts[projectId] ??= { open: 0, needsYou: 0 };
      counts[projectId][field] += 1;
    };
    for (const status of ["queued", "running", "needs_approval", "waiting_input"] as const) {
      const rows = await ctx.db
        .query("tasks")
        .withIndex("by_status", (q) => q.eq("status", status))
        .order("desc")
        .take(500);
      for (const t of rows) {
        bump(t.projectId as string, "open");
        if (status === "waiting_input") bump(t.projectId as string, "needsYou");
      }
    }
    const approvals = await ctx.db
      .query("approvals")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .order("desc")
      .take(APPROVAL_LIMIT);
    for (const a of approvals) bump(a.projectId as string, "needsYou");
    for (const status of ["ready", "failed"] as const) {
      const pushes = await ctx.db
        .query("taskPushes")
        .withIndex("by_status_and_requested", (q) => q.eq("status", status))
        .take(PUSH_LIMIT);
      for (const p of pushes) bump(p.projectId as string, "needsYou");
    }
    return counts;
  },
});

// ─── Team live status ──────────────────────────────────────────────────────

export type TeamStatusWord =
  | "needs_you"
  | "waiting_on_you"
  | "reviewing"
  | "testing"
  | "working"
  | "queued"
  | "elsewhere"
  | "idle";

export type TeamStatusEntry = {
  status: TeamStatusWord;
  taskId: Id<"tasks"> | null;
  taskTitle: string | null;
  /** Project the agent is busy in when `status` is "elsewhere". */
  projectName: string | null;
  subtaskKey: string | null;
};

const RANK: Record<TeamStatusWord, number> = {
  needs_you: 7,
  waiting_on_you: 6,
  reviewing: 5,
  testing: 5,
  working: 4,
  queued: 3,
  elsewhere: 2,
  idle: 0,
};

/** Status word for a running execution, from its subtask kind/capability. */
export function runningWord(kind: string | undefined, capability: string, subtaskKey?: string): TeamStatusWord {
  const hint = `${kind ?? ""} ${capability} ${subtaskKey ?? ""}`.toLowerCase();
  if (kind === "review" || kind === "audit" || /\breview/.test(hint)) return "reviewing";
  if (kind === "qa" || /\b(qa|test)/.test(hint)) return "testing";
  return "working";
}

/**
 * Live status of every agent for one project, derived from executions,
 * subtasks, approvals and open questions — never the persisted (stale)
 * `agents.status`. Agents with nothing in flight are absent (= idle).
 */
export const teamStatus = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    const projectKey = args.projectId as string;
    const out = new Map<string, TeamStatusEntry>();
    const set = (agentId: string, entry: TeamStatusEntry) => {
      const prev = out.get(agentId);
      if (!prev || RANK[entry.status] > RANK[prev.status]) out.set(agentId, entry);
    };
    const taskCache = new Map<string, Doc<"tasks"> | null>();
    const getTask = async (id: Id<"tasks">) => {
      if (!taskCache.has(id as string)) taskCache.set(id as string, await ctx.db.get(id));
      return taskCache.get(id as string) ?? null;
    };
    const viewerId = await getViewerId(ctx);
    const projectNames = new Map<string, string | null>();
    const projectName = async (id: Id<"projects">) => {
      if (!projectNames.has(id as string)) {
        const p = await ctx.db.get(id);
        // Another owner's project is never named (core H5).
        projectNames.set(id as string, p && canViewProject(viewerId, p) ? p.name : null);
      }
      return projectNames.get(id as string) ?? null;
    };

    for (const status of ["running", "waiting_approval", "queued"] as const) {
      const rows = await ctx.db
        .query("executions")
        .withIndex("by_status", (q) => q.eq("status", status))
        .order("desc")
        .take(EXECUTION_LIMIT);
      for (const exec of rows) {
        if (!exec.agentId) continue;
        const task = await getTask(exec.taskId);
        if (!task || TERMINAL.has(task.status)) continue;
        const base = {
          taskId: task._id,
          taskTitle: task.title,
          projectName: null,
          subtaskKey: exec.subtaskKey ?? null,
        };
        if ((task.projectId as string) !== projectKey) {
          set(exec.agentId as string, { ...base, status: "elsewhere", projectName: await projectName(task.projectId) });
          continue;
        }
        if (status === "waiting_approval") {
          set(exec.agentId as string, { ...base, status: "waiting_on_you" });
        } else if (status === "queued") {
          set(exec.agentId as string, { ...base, status: "queued" });
        } else {
          const subtask = exec.subtaskId ? await ctx.db.get(exec.subtaskId) : null;
          set(exec.agentId as string, { ...base, status: runningWord(subtask?.kind, exec.capability, exec.subtaskKey) });
        }
      }
    }

    const approvals = await ctx.db
      .query("approvals")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(APPROVAL_LIMIT);
    for (const a of approvals) {
      if (a.status !== "pending") continue;
      const agentId = a.requestedByAgentId ?? a.principalAgentId;
      if (!agentId) continue;
      const task = await getTask(a.taskId);
      set(agentId as string, {
        status: "waiting_on_you",
        taskId: a.taskId,
        taskTitle: task?.title ?? null,
        projectName: null,
        subtaskKey: a.subtaskKey ?? null,
      });
    }

    const waiting = await ctx.db
      .query("tasks")
      .withIndex("by_status", (q) => q.eq("status", "waiting_input"))
      .order("desc")
      .take(TASK_STATUS_LIMIT);
    for (const t of waiting) {
      if ((t.projectId as string) !== projectKey) continue;
      for (const agentId of t.assignedAgentIds ?? []) {
        set(agentId as string, { status: "needs_you", taskId: t._id, taskTitle: t.title, projectName: null, subtaskKey: null });
      }
    }

    return Object.fromEntries(out);
  },
});

// ─── Usage meter ───────────────────────────────────────────────────────────

/** Weekly budget in tokens from the deployment env; null = not configured. */
function weeklyBudget(): number | null {
  const raw = Number(process.env.MOAGENT_WEEKLY_TOKEN_BUDGET);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
}

/**
 * Token usage since `since` (the client's last weekly reset, computed in the
 * user's own timezone) plus live worker slots. Clamped to the last 8 days so
 * a bogus cursor can never scan the whole table.
 */
export const usage = query({
  args: { since: v.number() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const since = Math.min(now, Math.max(args.since, now - 8 * DAY_MS));
    const visible = new Set((await visibleProjects(ctx)).map((p) => p._id as string));
    const rows = await ctx.db
      .query("tokenUsage")
      .withIndex("by_created_at", (q) => q.gte("createdAt", since))
      .take(USAGE_ROW_LIMIT);
    let inputTokens = 0;
    let outputTokens = 0;
    const byModel = new Map<string, { tokens: number; providerId?: Id<"llmProviders"> }>();
    for (const row of rows) {
      if (!visible.has(row.projectId as string)) continue;
      inputTokens += row.inputTokens;
      outputTokens += row.outputTokens;
      const entry = byModel.get(row.model) ?? { tokens: 0, providerId: row.providerId };
      entry.tokens += row.inputTokens + row.outputTokens;
      byModel.set(row.model, entry);
    }
    let topModel: string | null = null;
    let topProviderId: Id<"llmProviders"> | undefined;
    let best = -1;
    for (const [model, entry] of byModel) {
      if (entry.tokens > best) {
        best = entry.tokens;
        topModel = model;
        topProviderId = entry.providerId;
      }
    }
    let providerName: string | null = null;
    let providerKind: string | null = null;
    const provider = topProviderId
      ? await ctx.db.get(topProviderId)
      : (await ctx.db.query("llmProviders").take(50))
          .filter((p) => p.isEnabled !== false)
          .sort((a, b) => a.priority - b.priority)[0];
    if (provider) {
      providerName = provider.name;
      providerKind = provider.provider;
      topModel ??= provider.model || null;
    }

    const workers = await ctx.db
      .query("workers")
      .withIndex("by_status_and_heartbeat", (q) =>
        q.eq("status", "online").gte("lastHeartbeatAt", now - WORKER_FRESH_MS)
      )
      .take(WORKER_LIMIT);
    const slots = workers.reduce(
      (acc, w) => ({ total: acc.total + Math.max(0, w.capacity), busy: acc.busy + Math.max(0, w.activeTasks) }),
      { total: 0, busy: 0 }
    );

    return {
      since,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      truncated: rows.length >= USAGE_ROW_LIMIT,
      budget: weeklyBudget(),
      topModel,
      providerName,
      providerKind,
      slots: { busy: Math.min(slots.busy, slots.total || slots.busy), total: slots.total, workers: workers.length },
    };
  },
});

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
