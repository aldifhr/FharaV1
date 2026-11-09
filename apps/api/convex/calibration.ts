/**
 * Decision Outcome Calibration (plan 026). The ledger of orchestrator
 * decisions, their deterministic outcomes, the calibration signals, and
 * recommendations a person may Apply (through an audited setting change,
 * after seeing the diff) or Dismiss. Nothing here calls an LLM, and
 * nothing changes a prompt or a setting by itself.
 */
import { internalAction, internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { assertAgentAccess, assertProjectAccess, getViewerId, getVisibleTask, visibleProjects } from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";
import { evaluateTaskDecisions, recordDecisionForEvent } from "./lib/calibration/store";
import {
  currentMultiplier,
  estimatorSignals,
  labelCounts,
  plannerMissSignal,
  recommendations,
  replanSignal,
  routingSignals,
  type ActionRecord,
  type AgentSetting,
  type LabelledDecision,
  type MultiplierSetting,
  type Recommendation,
} from "./lib/calibration/aggregate";

const DAY_MS = 24 * 60 * 60 * 1000;
const ALLOWED_WINDOWS = [7, 30, 90];
const DECISIONS_LIMIT = 5000;
const ACTIONS_LIMIT = 500;
/** Backfill bounds: days of history and tasks per batch / per run. */
export const BACKFILL_MAX_DAYS = 90;
export const BACKFILL_BATCH_MAX = 50;
export const BACKFILL_RUN_MAX_TASKS = 1000;

// ─── Reads ────────────────────────────────────────────────────────────────

/** The Decisions section of /runs/[taskId]: decision → outcome → label → factors. */
export const forTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return [];
    const rows = await ctx.db
      .query("decisions")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .take(500);
    return rows.map((row) => ({
      _id: row._id,
      type: row.type,
      subtaskKey: row.subtaskKey ?? null,
      chosen: row.chosen,
      alternatives: row.alternatives,
      reason: row.reason ?? null,
      expected: row.expected ?? null,
      snapshotId: row.snapshotId ?? null,
      agentName: row.agentName ?? null,
      capability: row.capability ?? null,
      decidedAt: row.decidedAt,
      label: row.label ?? "unknown",
      factors: row.outcome?.factors ?? [],
      final: row.outcome?.final ?? false,
    }));
  },
});

async function scopeProjects(ctx: QueryCtx | MutationCtx, projectId: Id<"projects"> | undefined) {
  return projectId ? [await assertProjectAccess(ctx, projectId)] : await visibleProjects(ctx);
}

function toLabelled(row: Doc<"decisions">): LabelledDecision | null {
  if (!row.label) return null;
  const signals = (row.outcome?.signals ?? {}) as Record<string, unknown>;
  return {
    id: row._id as string,
    projectId: row.projectId as string,
    taskId: row.taskId as string,
    type: row.type,
    decidedAt: row.decidedAt,
    label: row.label,
    agentName: row.agentName ?? null,
    agentId: (row.agentId as string | undefined) ?? null,
    capability: row.capability ?? null,
    role: row.role ?? (typeof signals.role === "string" ? signals.role : null),
    complexity: typeof signals.complexity === "string" ? signals.complexity : null,
    tokensRatio: typeof signals.tokensRatio === "number" ? signals.tokensRatio : null,
    durationRatio: typeof signals.durationRatio === "number" ? signals.durationRatio : null,
    plannerMiss: signals.plannerMiss === true,
    hadRequirements: signals.hadRequirements === true,
  };
}

async function loadScope(ctx: QueryCtx | MutationCtx, projectId: Id<"projects"> | undefined, sinceDays: number) {
  const projects = await scopeProjects(ctx, projectId);
  const since = Date.now() - sinceDays * DAY_MS;
  const rows: Doc<"decisions">[] = [];
  let truncated = false;
  for (const project of projects) {
    if (rows.length >= DECISIONS_LIMIT) {
      truncated = true;
      break;
    }
    const batch = await ctx.db
      .query("decisions")
      .withIndex("by_project", (q) => q.eq("projectId", project._id).gte("decidedAt", since))
      .order("desc")
      .take(DECISIONS_LIMIT - rows.length + 1);
    if (batch.length > DECISIONS_LIMIT - rows.length) truncated = true;
    rows.push(...batch.slice(0, DECISIONS_LIMIT - rows.length));
  }
  const agents = (await ctx.db.query("agents").take(200)).filter((a) => !a.retiredAt);
  const agentSettings: AgentSetting[] = agents.map((a) => ({
    id: a._id as string,
    name: a.name,
    role: a.role,
    priority: a.priority ?? 0,
    capabilities: a.capabilities ?? [],
    enabled: a.isEnabled !== false,
  }));
  const multipliersByProject = new Map<string, MultiplierSetting[] | undefined>(
    projects.map((p) => [p._id as string, p.estimatorMultipliers])
  );
  const projectIds = new Set(projects.map((p) => p._id as string));
  const actionRows = await ctx.db.query("calibrationActions").withIndex("by_created").order("desc").take(ACTIONS_LIMIT);
  const actions: ActionRecord[] = actionRows
    .filter((a) => !a.projectId || projectIds.has(a.projectId as string))
    .map((a) => ({ recId: a.recId, action: a.action, at: a.createdAt }));
  const labelled = rows.map(toLabelled).filter((d): d is LabelledDecision => d !== null);
  const recs = recommendations({ decisions: labelled, agents: agentSettings, multipliersByProject, actions });
  return { projects, rows, labelled, truncated, agentSettings, multipliersByProject, recs, actionRows };
}

/** /calibration: signals + recommendations for one project or every visible one. */
export const summary = query({
  args: { projectId: v.optional(v.id("projects")), sinceDays: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const sinceDays = ALLOWED_WINDOWS.includes(args.sinceDays ?? 30) ? args.sinceDays ?? 30 : 30;
    const scope = await loadScope(ctx, args.projectId, sinceDays);
    const projectName = new Map(scope.projects.map((p) => [p._id as string, p.name]));
    const recent = scope.rows
      .filter((row) => row.label === "bad" || row.label === "suboptimal")
      .slice(0, 25)
      .map((row) => ({
        _id: row._id,
        taskId: row.taskId,
        type: row.type,
        chosen: row.chosen,
        subtaskKey: row.subtaskKey ?? null,
        label: row.label!,
        factors: row.outcome?.factors ?? [],
        decidedAt: row.decidedAt,
      }));
    return {
      sinceDays,
      truncated: scope.truncated,
      total: scope.rows.length,
      labelled: scope.labelled.length,
      counts: labelCounts(scope.labelled),
      routing: routingSignals(scope.labelled),
      estimator: estimatorSignals(scope.labelled).map((s) => ({
        ...s,
        projectName: projectName.get(s.projectId) ?? null,
        multipliers: {
          tokens: currentMultiplier(scope.multipliersByProject.get(s.projectId), s.role, s.complexity, "tokens"),
          duration: currentMultiplier(scope.multipliersByProject.get(s.projectId), s.role, s.complexity, "duration"),
        },
      })),
      replan: replanSignal(scope.labelled),
      planner: plannerMissSignal(scope.labelled),
      recommendations: scope.recs,
      recent,
      history: scope.actionRows.slice(0, 20).map((a) => ({
        _id: a._id,
        action: a.action,
        title: a.title,
        change: a.change ?? null,
        createdAt: a.createdAt,
      })),
    };
  },
});

// ─── Apply / Dismiss (explicit, audited; never automatic) ─────────────────

async function currentRecommendation(
  ctx: MutationCtx,
  recId: string,
  projectId: Id<"projects"> | undefined,
  sinceDays: number | undefined
): Promise<Recommendation> {
  const days = ALLOWED_WINDOWS.includes(sinceDays ?? 30) ? sinceDays ?? 30 : 30;
  const scope = await loadScope(ctx, projectId, days);
  const rec = scope.recs.find((r) => r.id === recId);
  if (!rec) throw new Error("This recommendation is no longer current; reload the page");
  return rec;
}

export const apply = mutation({
  args: {
    recId: v.string(),
    projectId: v.optional(v.id("projects")),
    sinceDays: v.optional(v.number()),
    // The value the user saw in the diff; refused when the setting moved since.
    expectedFrom: v.number(),
    expectedTo: v.number(),
  },
  handler: async (ctx, args) => {
    const rec = await currentRecommendation(ctx, args.recId, args.projectId, args.sinceDays);
    const change = rec.apply;
    if (!change) throw new Error("This recommendation has no setting to apply");
    if (change.from !== args.expectedFrom || change.to !== args.expectedTo) {
      throw new Error("The setting changed since you saw the diff; review it again");
    }
    const now = Date.now();
    let projectId: Id<"projects"> | undefined = args.projectId;
    if (change.kind === "agent_priority") {
      const agent = await assertAgentAccess(ctx, change.agentId as Id<"agents">);
      if ((agent.priority ?? 0) !== change.from) throw new Error("The agent's priority changed; review it again");
      await ctx.db.patch(agent._id, { priority: change.to });
      // Same audit row agents.update writes for a priority edit.
      await recordAudit(ctx, {
        action: "agent.update",
        target: `${agent.name} (${agent.role})`,
        ...(projectId ? { projectId } : {}),
        details: { changed: ["priority"], source: "calibration", recId: rec.id },
      });
    } else {
      const project = await assertProjectAccess(ctx, change.projectId as Id<"projects">);
      projectId = project._id;
      const now0 = currentMultiplier(project.estimatorMultipliers, change.role, change.complexity, change.metric);
      if (now0 !== change.from) throw new Error("The multiplier changed; review it again");
      const list = [...(project.estimatorMultipliers ?? [])];
      const complexity = change.complexity === "any" ? undefined : change.complexity;
      const index = list.findIndex(
        (m) => m.role.trim().toLowerCase() === change.role && (m.complexity ?? undefined) === complexity
      );
      const entry = index >= 0 ? { ...list[index] } : { role: change.role, ...(complexity ? { complexity } : {}) };
      entry[change.metric] = change.to;
      if (index >= 0) list[index] = entry;
      else list.push(entry);
      await ctx.db.patch(project._id, { estimatorMultipliers: list });
      await recordAudit(ctx, {
        action: "project.update",
        target: project.name,
        projectId: project._id,
        details: { changed: ["estimatorMultipliers"], source: "calibration", recId: rec.id },
      });
    }
    const actor = (await getViewerId(ctx)) ?? "user";
    await ctx.db.insert("calibrationActions", {
      ...(projectId ? { projectId } : {}),
      recId: rec.id,
      action: "applied",
      title: rec.title,
      change,
      actor,
      createdAt: now,
    });
    await recordAudit(ctx, {
      tool: "calibration",
      action: "calibration.apply",
      target: rec.title,
      ...(projectId ? { projectId } : {}),
      details: { recId: rec.id, kind: change.kind, from: change.from, to: change.to },
    });
    return { applied: true, change };
  },
});

export const dismiss = mutation({
  args: { recId: v.string(), projectId: v.optional(v.id("projects")), sinceDays: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rec = await currentRecommendation(ctx, args.recId, args.projectId, args.sinceDays);
    const actor = (await getViewerId(ctx)) ?? "user";
    await ctx.db.insert("calibrationActions", {
      ...(args.projectId ? { projectId: args.projectId } : {}),
      recId: rec.id,
      action: "dismissed",
      title: rec.title,
      actor,
      createdAt: Date.now(),
    });
    await recordAudit(ctx, {
      tool: "calibration",
      action: "calibration.dismiss",
      target: rec.title,
      ...(args.projectId ? { projectId: args.projectId } : {}),
      details: { recId: rec.id },
    });
    return true;
  },
});

// ─── Internal: evaluation + backfill ──────────────────────────────────────

/** Scheduled when a task (or subtask) reaches a terminal state. Idempotent. */
export const evaluateTask = internalMutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => await evaluateTaskDecisions(ctx, args.taskId),
});

/**
 * Backfill one batch: tasks created in the last `days` (≤ 90), newest
 * first, older than `before` (the cursor), at most `limit` (≤ 50) tasks.
 * Records the decisions their existing events carry (deduped, so a rerun
 * inserts nothing new) and evaluates them. Returns the next cursor.
 */
export const backfill = internalMutation({
  args: { days: v.number(), limit: v.optional(v.number()), before: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const days = Math.min(Math.max(1, Math.floor(args.days)), BACKFILL_MAX_DAYS);
    const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 25)), BACKFILL_BATCH_MAX);
    const since = Date.now() - days * DAY_MS;
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_creation_time", (q) =>
        args.before !== undefined ? q.gte("_creationTime", since).lt("_creationTime", args.before) : q.gte("_creationTime", since)
      )
      .order("desc")
      .take(limit);
    let inserted = 0;
    const agentsByProject = new Map<string, Doc<"agents">[]>();
    const allAgents = await ctx.db.query("agents").take(200);
    for (const task of tasks) {
      let agents = agentsByProject.get(task.projectId as string);
      if (!agents) {
        const project = await ctx.db.get(task.projectId);
        const members = project?.agentIds && project.agentIds.length > 0 ? new Set(project.agentIds.map(String)) : null;
        agents = allAgents.filter((a) => a.isEnabled !== false && !a.retiredAt && (!members || members.has(a._id as string)));
        agentsByProject.set(task.projectId as string, agents);
      }
      const before = await ctx.db.query("decisions").withIndex("by_task", (q) => q.eq("taskId", task._id)).take(2000);
      const events = await ctx.db
        .query("taskEvents")
        .withIndex("by_task", (q) => q.eq("taskId", task._id))
        .take(3000);
      for (const event of events) {
        await recordDecisionForEvent(ctx, event, { backfilled: true, agents });
      }
      const after = await ctx.db.query("decisions").withIndex("by_task", (q) => q.eq("taskId", task._id)).take(2000);
      inserted += after.length - before.length;
      await evaluateTaskDecisions(ctx, task._id);
    }
    const next = tasks.length === limit ? tasks[tasks.length - 1]._creationTime : null;
    return { tasks: tasks.length, inserted, next };
  },
});

/** Run the backfill in batches, capped at BACKFILL_RUN_MAX_TASKS tasks. `npx convex run calibration:backfillAll '{"days":30}'` */
export const backfillAll = internalAction({
  args: { days: v.number(), maxTasks: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ tasks: number; inserted: number; complete: boolean }> => {
    const cap = Math.min(Math.max(1, Math.floor(args.maxTasks ?? 200)), BACKFILL_RUN_MAX_TASKS);
    let before: number | undefined;
    let tasks = 0;
    let inserted = 0;
    while (tasks < cap) {
      const result: { tasks: number; inserted: number; next: number | null } = await ctx.runMutation(
        internal.calibration.backfill,
        { days: args.days, limit: Math.min(25, cap - tasks), ...(before !== undefined ? { before } : {}) }
      );
      tasks += result.tasks;
      inserted += result.inserted;
      if (result.next === null) return { tasks, inserted, complete: true };
      before = result.next;
    }
    return { tasks, inserted, complete: false };
  },
});
