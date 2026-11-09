import { query, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { assertProjectAccess, getVisibleTask, visibleProjects } from "./lib/authz";
import { extractRouting } from "./lib/routing";
import { roleKeyForCapability } from "./lib/planEdit";
import type { PlanEstimate } from "./lib/estimate";
import { contractOf } from "./lib/subtaskContract";
import { normalizeModelTiers, tierForRole } from "./lib/modelTiers";
import { replansFromPlans } from "./lib/replanView";

/**
 * Runs / execution traces: a read-only projection of how the orchestrator
 * carried one task from the user's instruction to its final status.
 *
 * Nothing here writes. Every number is derived from rows the worker already
 * records (tasks, plans, subtasks, executions, tokenUsage, delegations,
 * evaluations, approvals, taskPushes, taskEvents). Token usage is linked to
 * an execution attempt by `tokenUsage.executionId` when the worker recorded
 * it; older rows are attributed by agent + time window and flagged
 * `approximate` so the UI can say so.
 */

const LIST_DEFAULT = 30;
const LIST_MAX = 100;
const SUBTASK_CAP = 500;
const EXECUTION_CAP = 1000;
const USAGE_CAP = 5000;
const EVENT_CAP = 300;
/** Early events read for the Routing section (classification, plan, first routes). */
const ROUTING_EARLY_CAP = 400;
const ROUTING_TYPES = new Set([
  "task.classified",
  "orchestrator.plan",
  "plan.created",
  "plan.planner_fallback",
  "plan.degraded",
  "subtask.routed",
  "orchestrator.decision",
  "orchestrator.decision_fallback",
]);
const INPUT_CAP = 4_000;
const OUTPUT_CAP = 8_000;
const MISC_CAP = 2_000;

const TERMINAL = new Set(["done", "failed", "rejected", "cancelled"]);

function cap(text: string | undefined | null, max: number): string | undefined {
  if (text === undefined || text === null) return undefined;
  const s = String(text);
  return s.length > max ? `${s.slice(0, max)}\n… [truncated ${s.length - max} chars]` : s;
}

function estimateOf(value: unknown): PlanEstimate | null {
  return value && typeof value === "object" && (value as PlanEstimate).version === 1 ? (value as PlanEstimate) : null;
}

function taskStart(task: Doc<"tasks">): number {
  return task.startedAt ?? task._creationTime;
}

/** When the run ended, or null while it is still going. */
function taskEnd(task: Doc<"tasks">): number | null {
  if (task.completedAt) return task.completedAt;
  if (TERMINAL.has(task.status)) return task.updatedAt ?? null;
  return null;
}

type Tokens = {
  inputTokens: number;
  outputTokens: number;
  calls: number;
  /** Sum of estimatedCost over calls that had pricing; null when none did. */
  estimatedCost: number | null;
  models: string[];
  /** True when at least one call was matched by agent + time window instead of executionId. */
  approximate: boolean;
  /** True when at least one call's counts are a worker estimate (provider sent no usage). */
  estimated: boolean;
};

function emptyTokens(): Tokens {
  return { inputTokens: 0, outputTokens: 0, calls: 0, estimatedCost: null, models: [], approximate: false, estimated: false };
}

function addUsage(t: Tokens, row: Doc<"tokenUsage">, approximate: boolean) {
  t.inputTokens += row.inputTokens;
  t.outputTokens += row.outputTokens;
  t.calls += 1;
  if (typeof row.estimatedCost === "number") t.estimatedCost = (t.estimatedCost ?? 0) + row.estimatedCost;
  if (!t.models.includes(row.model)) t.models.push(row.model);
  if (approximate) t.approximate = true;
  if (row.estimated) t.estimated = true;
}

function makeRoleResolver(ctx: QueryCtx) {
  const cache = new Map<string, Doc<"agents"> | null>();
  return async (agentId: Id<"agents"> | undefined | null, fallbackName?: string): Promise<string> => {
    if (agentId) {
      const key = agentId as string;
      if (!cache.has(key)) cache.set(key, await ctx.db.get(agentId));
      const agent = cache.get(key);
      if (agent?.role) return agent.role;
    }
    return (fallbackName ?? "agent").trim().toLowerCase() || "agent";
  };
}

/** Attribute usage rows to executions: exact by executionId, else agent + time window. */
function attributeUsage(
  usage: Doc<"tokenUsage">[],
  executions: Doc<"executions">[]
): { byExecution: Map<string, Tokens>; unmatched: Doc<"tokenUsage">[] } {
  const byExecution = new Map<string, Tokens>();
  const execIds = new Set(executions.map((e) => e._id as string));
  const unmatched: Doc<"tokenUsage">[] = [];
  const bucket = (id: string) => {
    let t = byExecution.get(id);
    if (!t) byExecution.set(id, (t = emptyTokens()));
    return t;
  };
  for (const row of usage) {
    if (row.executionId && execIds.has(row.executionId as string)) {
      addUsage(bucket(row.executionId as string), row, false);
      continue;
    }
    // Legacy row (or one whose execution vanished): the latest-started
    // attempt by the same agent whose window contains the call.
    let best: Doc<"executions"> | null = null;
    for (const exec of executions) {
      const sameAgent = row.agentId && exec.agentId ? row.agentId === exec.agentId : row.agentName === exec.agentName;
      if (!sameAgent) continue;
      const start = exec.startedAt ?? exec.createdAt;
      const end = exec.completedAt ?? Number.POSITIVE_INFINITY;
      // Usage is recorded just after the call returns; allow a small grace.
      if (row.createdAt < start || row.createdAt > end + 5_000) continue;
      if (!best || start > (best.startedAt ?? best.createdAt)) best = exec;
    }
    if (best) addUsage(bucket(best._id as string), row, true);
    else unmatched.push(row);
  }
  return { byExecution, unmatched };
}

async function loadRunRows(ctx: QueryCtx, taskId: Id<"tasks">) {
  const [subtasks, executions, usage] = await Promise.all([
    ctx.db.query("subtasks").withIndex("by_task", (q) => q.eq("taskId", taskId)).take(SUBTASK_CAP),
    ctx.db.query("executions").withIndex("by_task", (q) => q.eq("taskId", taskId)).take(EXECUTION_CAP),
    ctx.db.query("tokenUsage").withIndex("by_task", (q) => q.eq("taskId", taskId)).take(USAGE_CAP),
  ]);
  executions.sort((a, b) => (a.startedAt ?? a.createdAt) - (b.startedAt ?? b.createdAt));
  return { subtasks, executions, usage };
}

export const list = query({
  args: { projectId: v.optional(v.id("projects")), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(LIST_MAX, Math.floor(args.limit ?? LIST_DEFAULT)));
    const projectNames = new Map<string, string>();
    let tasks: Doc<"tasks">[];
    if (args.projectId) {
      const project = await assertProjectAccess(ctx, args.projectId);
      projectNames.set(project._id as string, project.name);
      tasks = await ctx.db
        .query("tasks")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId!))
        .order("desc")
        .take(limit);
    } else {
      for (const p of await visibleProjects(ctx)) projectNames.set(p._id as string, p.name);
      const recent = await ctx.db.query("tasks").order("desc").take(limit * 4);
      tasks = recent.filter((t) => projectNames.has(t.projectId as string)).slice(0, limit);
    }

    const roleOf = makeRoleResolver(ctx);
    const runs = [];
    for (const task of tasks) {
      const { subtasks, executions, usage } = await loadRunRows(ctx, task._id);
      let inputTokens = 0;
      let outputTokens = 0;
      let estimatedCost: number | null = null;
      for (const row of usage) {
        inputTokens += row.inputTokens;
        outputTokens += row.outputTokens;
        if (typeof row.estimatedCost === "number") estimatedCost = (estimatedCost ?? 0) + row.estimatedCost;
      }
      const roles: string[] = [];
      for (const exec of executions) {
        const role = await roleOf(exec.agentId, exec.agentName);
        if (!roles.includes(role)) roles.push(role);
      }
      const failedExecs = executions.filter((e) => e.status === "failed").length;
      const errorCount = failedExecs + (task.status === "failed" && failedExecs === 0 ? 1 : 0);
      const startedAt = taskStart(task);
      const endedAt = taskEnd(task);
      const latestPlan = await ctx.db
        .query("plans")
        .withIndex("by_task", (q) => q.eq("taskId", task._id))
        .order("desc")
        .take(1);
      const estimate = estimateOf(latestPlan[0]?.estimate);
      runs.push({
        taskId: task._id,
        projectId: task.projectId,
        projectName: projectNames.get(task.projectId as string) ?? "Project",
        title: task.title,
        status: task.status,
        phase: task.phase ?? null,
        createdAt: task._creationTime,
        startedAt,
        endedAt,
        durationMs: endedAt !== null ? Math.max(0, endedAt - startedAt) : null,
        inputTokens,
        outputTokens,
        estimatedCost,
        tokensEstimated: usage.some((row) => row.estimated === true),
        roles,
        errorCount,
        subtasksDone: subtasks.filter((s) => s.status === "completed" || s.status === "skipped").length,
        subtasksTotal: subtasks.length,
        estimate: estimate
          ? { tokens: estimate.tokens.total, cost: estimate.cost, costPartial: estimate.costPartial, durationMs: estimate.durationMs }
          : null,
      });
    }
    return {
      runs,
      projectName: args.projectId ? projectNames.get(args.projectId as string) ?? null : null,
    };
  },
});

type Step = {
  id: string;
  type: "received" | "plan" | "execution" | "verdict" | "evaluation" | "approval" | "push" | "final";
  title: string;
  status: string;
  role?: string;
  agentName?: string;
  capability?: string;
  subtaskKind?: string;
  subtaskKey?: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  attempt?: number;
  input?: string;
  output?: string;
  error?: string;
  tokens?: Tokens;
  dependencies?: string[];
  /** Subtask keys whose agents handed work to this step (its dependencies' assignees). */
  handedOffFrom?: { key: string; role: string }[];
  origin?: string;
  reviewRound?: number;
  detail?: string;
  /** Approval steps: the duration is time spent waiting on the user, not agent work. */
  waiting?: boolean;
  plans?: { version: number; strategy: string; createdBy: string; goal: string; createdAt: number; subtaskCount: number | null }[];
};

export const get = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return null;
    const project = await ctx.db.get(task.projectId);
    const { subtasks, executions, usage } = await loadRunRows(ctx, task._id);
    const [plans, delegations, evaluations, approvals, pushes, eventsDesc] = await Promise.all([
      ctx.db.query("plans").withIndex("by_task", (q) => q.eq("taskId", task._id)).take(50),
      ctx.db.query("delegations").withIndex("by_task", (q) => q.eq("taskId", task._id)).take(500),
      ctx.db.query("evaluations").withIndex("by_task", (q) => q.eq("taskId", task._id)).take(50),
      ctx.db.query("approvals").withIndex("by_task", (q) => q.eq("taskId", task._id)).take(200),
      ctx.db.query("taskPushes").withIndex("by_task", (q) => q.eq("taskId", task._id)).take(20),
      ctx.db
        .query("taskEvents")
        .withIndex("by_task_and_sequence", (q) => q.eq("taskId", task._id))
        .order("desc")
        .take(EVENT_CAP + 1),
    ]);
    const earlyEvents = await ctx.db
      .query("taskEvents")
      .withIndex("by_task_and_sequence", (q) => q.eq("taskId", task._id))
      .order("asc")
      .take(ROUTING_EARLY_CAP);
    const eventsTruncated = eventsDesc.length > EVENT_CAP;
    const events = eventsDesc.slice(0, EVENT_CAP).reverse();
    plans.sort((a, b) => a.version - b.version);

    const roleOf = makeRoleResolver(ctx);
    const subtaskByKey = new Map(subtasks.map((s) => [s.key, s]));
    const roleByKey = new Map<string, string>();
    for (const s of subtasks) roleByKey.set(s.key, await roleOf(s.assignedAgentId, s.assignedAgentName ?? s.capability));

    const startedAt = taskStart(task);
    const endedAt = taskEnd(task);
    const { byExecution, unmatched } = attributeUsage(usage, executions);

    // Planner window: from the run's start to the first plan, before any
    // execution started. Unlinked calls in that window are the planner's.
    const firstPlanAt = plans[0]?.createdAt;
    const firstExecStart = executions[0] ? executions[0].startedAt ?? executions[0].createdAt : undefined;
    const planWindowEnd = firstExecStart ?? firstPlanAt ?? Number.POSITIVE_INFINITY;
    const planTokens = emptyTokens();
    const unattributed = emptyTokens();
    let plannerName: string | undefined;
    let plannerId: Id<"agents"> | undefined;
    for (const row of unmatched) {
      if (row.createdAt <= planWindowEnd + 5_000) {
        addUsage(planTokens, row, !row.executionId);
        plannerName ??= row.agentName;
        plannerId ??= row.agentId;
      } else {
        addUsage(unattributed, row, true);
      }
    }
    // Planner usage carries no execution link, so it is always a window match.
    planTokens.approximate = planTokens.calls > 0;
    const plannerRole = plannerName || plannerId ? await roleOf(plannerId, plannerName) : "cto";

    const steps: Step[] = [];
    steps.push({
      id: "received",
      type: "received",
      title: "Instruction received",
      status: "completed",
      startedAt: task._creationTime,
      completedAt: task._creationTime,
      durationMs: 0,
      input: cap(task.command, INPUT_CAP),
      detail: task.classification ? `Classified as ${task.classification}` : undefined,
    });

    if (plans.length > 0) {
      const planDuration = firstPlanAt !== undefined ? Math.max(0, firstPlanAt - startedAt) : undefined;
      const latest = plans[plans.length - 1];
      steps.push({
        id: "plan",
        type: "plan",
        title: plans.length > 1 ? `Plan (v${latest.version}, ${plans.length} versions)` : "Plan",
        status: "completed",
        role: plannerRole,
        agentName: plannerName,
        startedAt,
        completedAt: firstPlanAt,
        durationMs: planDuration,
        input: cap(task.command, INPUT_CAP),
        output: cap(latest.goal, OUTPUT_CAP),
        detail: `Strategy: ${latest.strategy}${latest.createdBy === "fallback" ? " (fallback plan)" : ""}`,
        tokens: planTokens.calls ? planTokens : undefined,
        plans: plans.map((p) => ({
          version: p.version,
          strategy: p.strategy,
          createdBy: p.createdBy,
          goal: cap(p.goal, MISC_CAP) ?? "",
          createdAt: p.createdAt,
          subtaskCount: Array.isArray((p.payload as any)?.subtasks) ? (p.payload as any).subtasks.length : null,
        })),
      });
    }

    const handedOffFrom = (keys: string[]) =>
      keys.map((key) => ({ key, role: roleByKey.get(key) ?? "agent" }));

    const executedKeys = new Set<string>();
    for (const exec of executions) {
      const sub = exec.subtaskKey ? subtaskByKey.get(exec.subtaskKey) : exec.subtaskId ? subtasks.find((s) => s._id === exec.subtaskId) : undefined;
      if (sub) executedKeys.add(sub.key);
      const start = exec.startedAt ?? exec.createdAt;
      const end = exec.completedAt;
      const isLatestAttempt = sub ? sub.attempts <= exec.attempt : true;
      steps.push({
        id: exec._id,
        type: "execution",
        title: sub?.title ?? exec.subtaskKey ?? exec.capability,
        status: exec.status,
        role: await roleOf(exec.agentId, exec.agentName),
        agentName: exec.agentName,
        capability: exec.capability,
        subtaskKind: sub?.kind,
        subtaskKey: sub?.key ?? exec.subtaskKey,
        startedAt: start,
        completedAt: end,
        durationMs: end !== undefined ? Math.max(0, end - start) : undefined,
        attempt: exec.attempt,
        input: cap(sub?.description, INPUT_CAP),
        output: cap(exec.output ?? (isLatestAttempt ? sub?.output : undefined), OUTPUT_CAP),
        error: cap(exec.error ?? (isLatestAttempt && exec.status === "failed" ? sub?.error : undefined), MISC_CAP),
        tokens: byExecution.get(exec._id as string),
        dependencies: sub?.dependencies ?? [],
        handedOffFrom: handedOffFrom(sub?.dependencies ?? []),
        origin: sub?.origin,
        reviewRound: sub?.reviewRound,
      });
    }
    // Planned subtasks that never got an execution (pending / blocked / skipped).
    for (const sub of subtasks) {
      if (executedKeys.has(sub.key)) continue;
      steps.push({
        id: `subtask:${sub.key}`,
        type: "execution",
        title: sub.title,
        status: sub.status,
        role: roleByKey.get(sub.key),
        agentName: sub.assignedAgentName,
        capability: sub.capability,
        subtaskKind: sub.kind,
        subtaskKey: sub.key,
        startedAt: sub.startedAt,
        completedAt: sub.completedAt,
        durationMs: sub.startedAt && sub.completedAt ? sub.completedAt - sub.startedAt : undefined,
        attempt: sub.attempts || undefined,
        input: cap(sub.description, INPUT_CAP),
        output: cap(sub.output, OUTPUT_CAP),
        error: cap(sub.error, MISC_CAP),
        dependencies: sub.dependencies,
        handedOffFrom: handedOffFrom(sub.dependencies),
        origin: sub.origin,
        reviewRound: sub.reviewRound,
      });
    }

    // Review / QA verdicts the worker logs as events.
    const VERDICTS: Record<string, { title: string; status: string; role: string }> = {
      "review.approved": { title: "Review approved", status: "completed", role: "reviewer" },
      "review.requested_changes": { title: "Review requested changes", status: "failed", role: "reviewer" },
      "qa.passed": { title: "QA passed", status: "completed", role: "qa" },
      "qa.failed": { title: "QA failed", status: "failed", role: "qa" },
      "qa.blocked": { title: "QA blocked", status: "blocked", role: "qa" },
    };
    for (const e of events) {
      const verdict = VERDICTS[e.type];
      if (!verdict) continue;
      const at = e.createdAt ?? e._creationTime;
      const p = (e.payload ?? {}) as Record<string, unknown>;
      steps.push({
        id: `event:${e._id}`,
        type: "verdict",
        title: verdict.title,
        status: verdict.status,
        role: verdict.role,
        subtaskKey: e.subtaskKey,
        startedAt: at,
        completedAt: at,
        durationMs: 0,
        detail: cap(e.message ?? (typeof p.summary === "string" ? p.summary : typeof p.reason === "string" ? p.reason : undefined), MISC_CAP),
        reviewRound: typeof p.round === "number" ? p.round : undefined,
      });
    }

    for (const ev of evaluations) {
      steps.push({
        id: ev._id,
        type: "evaluation",
        title: `Evaluation ${ev.verdict}`,
        status: ev.verdict === "passed" ? "completed" : ev.verdict === "failed" ? "failed" : "inconclusive",
        startedAt: ev.createdAt,
        completedAt: ev.createdAt,
        durationMs: 0,
        detail: cap(ev.notes, MISC_CAP),
        output: cap(ev.checks === undefined ? undefined : JSON.stringify(ev.checks, null, 2), OUTPUT_CAP),
      });
    }

    for (const a of approvals) {
      // The user decides an approval: attributing its wait to the agent
      // that requested it (e.g. "Frontend 3m 17s") read as agent work.
      const requestedBy = a.requestedByAgentId || a.principalAgentId
        ? await roleOf(a.requestedByAgentId ?? a.principalAgentId)
        : undefined;
      steps.push({
        id: a._id,
        type: "approval",
        title: `Approval · ${a.kind.replace(/_/g, " ")}`,
        status: a.status,
        role: "you",
        agentName: requestedBy ? `requested by ${requestedBy}` : undefined,
        waiting: true,
        subtaskKey: a.subtaskKey,
        startedAt: a._creationTime,
        completedAt: a.resolvedAt,
        durationMs: a.resolvedAt ? Math.max(0, a.resolvedAt - a._creationTime) : undefined,
        detail: cap(a.summary, MISC_CAP),
      });
    }

    for (const p of pushes) {
      const start = p.requestedAt ?? p.createdAt;
      const end = p.pushedAt ?? (p.status === "failed" ? p.updatedAt : undefined);
      steps.push({
        id: p._id,
        type: "push",
        title: p.prNumber ? `Push · PR #${p.prNumber}` : `Push · ${p.branchName}`,
        status: p.status,
        startedAt: start,
        completedAt: end,
        durationMs: end ? Math.max(0, end - start) : undefined,
        detail: cap(
          [`${p.filesChanged} files`, p.commitSha.slice(0, 7), p.commitMessage, p.prUrl].filter(Boolean).join(" · "),
          MISC_CAP
        ),
        error: cap(p.error, MISC_CAP),
      });
    }

    const body = steps.slice(1).sort((a, b) => (a.startedAt ?? Number.POSITIVE_INFINITY) - (b.startedAt ?? Number.POSITIVE_INFINITY));
    const ordered: Step[] = [steps[0], ...body];
    if (TERMINAL.has(task.status)) {
      ordered.push({
        id: "final",
        type: "final",
        title:
          task.status === "done"
            ? "Done"
            : task.status === "failed"
              ? "Failed"
              : task.status === "cancelled"
                ? "Cancelled"
                : "Rejected",
        status: task.status === "done" ? "completed" : task.status,
        startedAt: endedAt ?? undefined,
        completedAt: endedAt ?? undefined,
        durationMs: 0,
        error: cap(task.errorMessage, MISC_CAP),
      });
    }

    // Edges: DAG dependencies + delegation decisions.
    const edges: {
      type: "dependency" | "delegation";
      from: string;
      to: string;
      fromRole?: string;
      toRole?: string;
      decision?: string;
      reason?: string;
      capability?: string;
      createdAt?: number;
    }[] = [];
    for (const s of subtasks) {
      for (const dep of s.dependencies) {
        edges.push({ type: "dependency", from: dep, to: s.key, fromRole: roleByKey.get(dep), toRole: roleByKey.get(s.key) });
      }
    }
    for (const d of delegations) {
      const fromRole = d.fromAgentId ? await roleOf(d.fromAgentId) : plannerRole;
      const toRole = d.toAgentId ? await roleOf(d.toAgentId) : d.capability ?? "agent";
      edges.push({
        type: "delegation",
        from: (d.fromAgentId as string | undefined) ?? "orchestrator",
        to: (d.toAgentId as string | undefined) ?? d.capability ?? "agent",
        fromRole,
        toRole,
        decision: d.decision,
        reason: cap(d.reason, MISC_CAP),
        capability: d.capability,
        createdAt: d.createdAt,
      });
    }

    // Role-level hand-offs for the compact Agents section: planner → each
    // root subtask's role, dependency → dependent, and delegations.
    const handoffCounts = new Map<string, { from: string; to: string; count: number }>();
    const bump = (from: string | undefined, to: string | undefined) => {
      if (!from || !to || from === to) return;
      const key = `${from}→${to}`;
      const cur = handoffCounts.get(key);
      if (cur) cur.count += 1;
      else handoffCounts.set(key, { from, to, count: 1 });
    };
    if (plans.length > 0) {
      for (const s of subtasks) if (s.dependencies.length === 0) bump(plannerRole, roleByKey.get(s.key));
    }
    for (const e of edges) bump(e.fromRole, e.toRole);

    // Totals.
    const byModel: Record<string, { inputTokens: number; outputTokens: number; calls: number; estimatedCost: number | null }> = {};
    const byAgent: Record<string, { role: string; inputTokens: number; outputTokens: number; calls: number; estimatedCost: number | null }> = {};
    let inputTokens = 0;
    let outputTokens = 0;
    let estimatedCost: number | null = null;
    for (const row of usage) {
      inputTokens += row.inputTokens;
      outputTokens += row.outputTokens;
      const cost = typeof row.estimatedCost === "number" ? row.estimatedCost : null;
      if (cost !== null) estimatedCost = (estimatedCost ?? 0) + cost;
      const m = (byModel[row.model] ??= { inputTokens: 0, outputTokens: 0, calls: 0, estimatedCost: null });
      m.inputTokens += row.inputTokens;
      m.outputTokens += row.outputTokens;
      m.calls += 1;
      if (cost !== null) m.estimatedCost = (m.estimatedCost ?? 0) + cost;
      const role = await roleOf(row.agentId, row.agentName);
      const a = (byAgent[role] ??= { role, inputTokens: 0, outputTokens: 0, calls: 0, estimatedCost: null });
      a.inputTokens += row.inputTokens;
      a.outputTokens += row.outputTokens;
      a.calls += 1;
      if (cost !== null) a.estimatedCost = (a.estimatedCost ?? 0) + cost;
    }

    // Plan 022: tokens / cost per model tier (planner vs workers vs reviewer).
    const byTier: Record<"planner" | "worker" | "reviewer" | "other", { inputTokens: number; outputTokens: number; calls: number; estimatedCost: number | null }> = {
      planner: { inputTokens: 0, outputTokens: 0, calls: 0, estimatedCost: null },
      worker: { inputTokens: 0, outputTokens: 0, calls: 0, estimatedCost: null },
      reviewer: { inputTokens: 0, outputTokens: 0, calls: 0, estimatedCost: null },
      other: { inputTokens: 0, outputTokens: 0, calls: 0, estimatedCost: null },
    };
    for (const entry of Object.values(byAgent)) {
      const bucket = byTier[tierForRole(entry.role) ?? "other"];
      bucket.inputTokens += entry.inputTokens;
      bucket.outputTokens += entry.outputTokens;
      bucket.calls += entry.calls;
      if (entry.estimatedCost !== null) bucket.estimatedCost = (bucket.estimatedCost ?? 0) + entry.estimatedCost;
    }

    // Routing (Intent & Routing Inspector): read only from existing events.
    const routingEvents = new Map<string, Doc<"taskEvents">>();
    for (const e of [...earlyEvents, ...events]) if (ROUTING_TYPES.has(e.type)) routingEvents.set(e._id as string, e);
    const roleByAgentName: Record<string, string> = {};
    for (const exec of executions) {
      if (exec.agentName && !roleByAgentName[exec.agentName]) roleByAgentName[exec.agentName] = await roleOf(exec.agentId, exec.agentName);
    }
    for (const s of subtasks) {
      if (s.assignedAgentName && !roleByAgentName[s.assignedAgentName]) roleByAgentName[s.assignedAgentName] = roleByKey.get(s.key) ?? "agent";
    }
    const delegationRoles = [];
    for (const d of delegations) {
      delegationRoles.push({
        fromRole: d.fromAgentId ? await roleOf(d.fromAgentId) : plannerRole,
        toRole: d.toAgentId ? await roleOf(d.toAgentId) : d.capability ?? "agent",
        decision: d.decision,
        reason: cap(d.reason, MISC_CAP) ?? null,
        capability: d.capability ?? null,
        createdAt: d.createdAt,
      });
    }
    const latestPlanRow = plans[plans.length - 1];
    const latestEstimate = estimateOf(latestPlanRow?.estimate);
    // Assigned subtasks show their agent's role; not-yet-run ones the role
    // the estimate routed them to, else the role seeding the capability.
    const subtaskRole = (s: Doc<"subtasks">): string | null =>
      s.assignedAgentId || s.assignedAgentName
        ? roleByKey.get(s.key) ?? null
        : latestEstimate?.perSubtask.find((p) => p.key === s.key)?.role ?? roleKeyForCapability(s.capability);
    const routing = extractRouting({
      events: [...routingEvents.values()].map((e) => ({
        type: e.type,
        payload: e.payload,
        subtaskKey: e.subtaskKey ?? null,
        createdAt: e.createdAt ?? e._creationTime,
      })),
      subtasks: subtasks
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((s) => ({
          key: s.key,
          title: s.title,
          capability: s.capability,
          kind: s.kind,
          dependencies: s.dependencies,
          role: subtaskRole(s),
          origin: s.origin ?? null,
        })),
      delegations: delegationRoles,
      roleByAgentName,
      plannerRole,
    });

    return {
      task: {
        _id: task._id,
        title: task.title,
        command: cap(task.command, INPUT_CAP),
        status: task.status,
        phase: task.phase ?? null,
        projectId: task.projectId,
        projectName: project?.name ?? "Project",
        conversationId: task.conversationId ?? null,
        branchName: task.branchName ?? null,
        permissionMode: task.permissionMode ?? "supervised",
        errorMessage: task.errorMessage ?? null,
        createdAt: task._creationTime,
        startedAt,
        endedAt,
      },
      steps: ordered,
      edges,
      handoffs: [...handoffCounts.values()].sort((a, b) => b.count - a.count),
      totals: {
        durationMs: endedAt !== null ? Math.max(0, endedAt - startedAt) : null,
        inputTokens,
        outputTokens,
        calls: usage.length,
        estimatedCost,
        estimated: usage.some((row) => row.estimated === true),
        byModel,
        byAgent: Object.values(byAgent).sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)),
        byTier,
        modelTiers: normalizeModelTiers(project?.modelTiers),
        unattributed: unattributed.calls ? unattributed : null,
        usageTruncated: usage.length >= USAGE_CAP,
      },
      events: events.map((e) => ({
        _id: e._id,
        sequence: e.sequence ?? null,
        type: e.type,
        level: e.level ?? "info",
        message: cap(e.message, MISC_CAP) ?? null,
        subtaskKey: e.subtaskKey ?? null,
        payload: e.payload === undefined ? null : cap(JSON.stringify(e.payload), MISC_CAP),
        createdAt: e.createdAt ?? e._creationTime,
      })),
      eventsTruncated,
      plan: latestPlanRow
        ? {
            version: latestPlanRow.version,
            createdBy: latestPlanRow.createdBy,
            degradedReason: latestPlanRow.degradedReason ?? null,
            estimate: latestEstimate,
          }
        : null,
      routing,
      /** Replan Intelligence: diff, reasons and preserved nodes per replanned version. */
      replans: replansFromPlans(plans),
      /**
       * Plan 022: each subtask's contract and acceptance (gate results with
       * evidence), separate from its execution status.
       */
      contracts: subtasks
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((s) => {
          const contract = contractOf(s);
          return {
            key: s.key,
            title: s.title,
            kind: s.kind,
            status: s.status,
            origin: s.origin ?? null,
            objective: contract.objective ?? null,
            scope: s.allowedPaths ?? [],
            constraints: contract.constraints ?? [],
            deliverable: contract.deliverable ?? null,
            acceptance: contract.acceptance,
            acceptanceStatus: s.acceptanceStatus ?? null,
            acceptanceReason: cap(s.acceptanceReason, MISC_CAP) ?? null,
            gateResults: s.gateResults ?? [],
            escalation: s.escalation ?? null,
          };
        }),
      /** DAG nodes for the Decomposer graph (plan subtasks + runner-added nodes). */
      graph: subtasks
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((s) => ({
          key: s.key,
          title: s.title,
          kind: s.kind,
          status: s.status,
          role: subtaskRole(s),
          dependencies: s.dependencies,
          origin: s.origin ?? null,
        })),
    };
  },
});
