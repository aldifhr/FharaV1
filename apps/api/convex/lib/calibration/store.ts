/**
 * Decision Outcome Calibration — Convex-side glue: record a decision from
 * a just-written task event (the one central hook), and (re)evaluate the
 * outcomes of a task's decisions. Deterministic; never calls an LLM and
 * never changes a prompt or a setting.
 */
import type { MutationCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/api";
import { DECISION_EVENT_TYPES, decisionFromEvent, type DecisionDraft } from "./capture";
import { buildTaskEvidence, labelDecision, type RoutingHistory } from "./outcome";

const EVENTS_CAP = 3000;
const ROWS_CAP = 2000;
const HISTORY_CAP = 500;
const TEXT_CAP = 300;

function norm(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, "-");
}

/** Enabled agents of the project (its member list when set, else every enabled agent). */
async function projectAgents(ctx: MutationCtx, projectId: Id<"projects">): Promise<Doc<"agents">[]> {
  const project = await ctx.db.get(projectId);
  const all = await ctx.db.query("agents").take(200);
  const members = project?.agentIds && project.agentIds.length > 0 ? new Set(project.agentIds.map(String)) : null;
  return all.filter((a) => a.isEnabled !== false && !a.retiredAt && (!members || members.has(a._id as string)));
}

async function expectedFor(
  ctx: MutationCtx,
  task: Doc<"tasks">,
  draft: DecisionDraft
): Promise<Doc<"decisions">["expected"]> {
  const requirementText = new Map((task.requirements ?? []).map((r) => [r.id, r.text.slice(0, TEXT_CAP)]));
  const key = draft.subtaskKey ?? (draft.type === "engine" && typeof draft.meta?.target === "string" ? draft.meta.target : undefined);
  if (key && (draft.type === "routing" || draft.type === "engine" || draft.type === "escalation")) {
    const subtask = await ctx.db
      .query("subtasks")
      .withIndex("by_task_and_key", (q) => q.eq("taskId", task._id).eq("key", key))
      .unique();
    if (subtask) {
      const requirementIds = subtask.requirementIds ?? [];
      return {
        objective: (subtask.objective ?? subtask.title).slice(0, TEXT_CAP),
        acceptance: (subtask.acceptance ?? []).map((g) => g.criterion.slice(0, 200)).slice(0, 10),
        requirementIds,
        requirements: requirementIds.map((id) => requirementText.get(id)).filter((t): t is string => Boolean(t)),
        ...(draft.type === "engine" && typeof draft.meta?.expectedOutcome === "string"
          ? { note: String(draft.meta.expectedOutcome).slice(0, TEXT_CAP) }
          : {}),
      };
    }
  }
  if (draft.type === "plan" || draft.type === "replan") {
    const plan =
      draft.planVersion !== undefined
        ? await ctx.db
            .query("plans")
            .withIndex("by_task_and_version", (q) => q.eq("taskId", task._id).eq("version", draft.planVersion!))
            .first()
        : null;
    const ids = [...requirementText.keys()];
    return {
      objective: (plan?.goal ?? task.title).slice(0, TEXT_CAP),
      requirementIds: ids,
      requirements: ids.map((id) => requirementText.get(id)!).slice(0, 20),
      ...(draft.type === "replan" && Array.isArray(draft.meta?.failed) && (draft.meta!.failed as string[]).length > 0
        ? { note: `Recover ${(draft.meta!.failed as string[]).join(", ")}`.slice(0, TEXT_CAP) }
        : {}),
    };
  }
  if (draft.type === "engine" && typeof draft.meta?.expectedOutcome === "string") {
    return { note: String(draft.meta.expectedOutcome).slice(0, TEXT_CAP) };
  }
  return undefined;
}

/** The Context Snapshot of the LLM call that produced the decision, when one exists. */
async function snapshotFor(
  ctx: MutationCtx,
  taskId: Id<"tasks">,
  draft: DecisionDraft
): Promise<Id<"contextSnapshots"> | undefined> {
  const callRole = draft.type === "plan" || draft.type === "replan" ? "planner" : draft.type === "engine" ? "decision" : null;
  if (!callRole) return undefined;
  const rows = await ctx.db
    .query("contextSnapshots")
    .withIndex("by_task", (q) => q.eq("taskId", taskId).lte("createdAt", draft.decidedAt))
    .order("desc")
    .take(50);
  const match = rows.find(
    (row) => row.callRole === callRole && (callRole !== "decision" || !draft.subtaskKey || row.subtaskKey === draft.subtaskKey)
  );
  return match?._id;
}

/**
 * Record the decision a task event carries (no-op for any other event and
 * for a decision already recorded). Never throws into the caller: the
 * ledger must not break the run it observes.
 */
export async function recordDecisionForEvent(
  ctx: MutationCtx,
  event: {
    _id: Id<"taskEvents">;
    taskId: Id<"tasks">;
    projectId: Id<"projects">;
    type: string;
    payload?: unknown;
    subtaskKey?: string;
    agentId?: Id<"agents">;
    createdAt?: number;
    _creationTime?: number;
  },
  options: { backfilled?: boolean; agents?: Doc<"agents">[] } = {}
): Promise<Id<"decisions"> | null> {
  if (!DECISION_EVENT_TYPES.has(event.type)) return null;
  try {
    let agents = options.agents;
    const draft = decisionFromEvent(
      {
        id: event._id as string,
        taskId: event.taskId as string,
        type: event.type,
        payload: event.payload,
        subtaskKey: event.subtaskKey,
        agentId: event.agentId as string | undefined,
        createdAt: event.createdAt ?? event._creationTime ?? Date.now(),
      },
      {}
    );
    if (!draft) return null;
    const existing = await ctx.db
      .query("decisions")
      .withIndex("by_dedupe", (q) => q.eq("dedupeKey", draft.dedupeKey))
      .first();
    if (existing) return existing._id;
    const task = await ctx.db.get(event.taskId);
    if (!task) return null;
    let agentId: Id<"agents"> | undefined;
    if (draft.type === "routing") {
      agents ??= await projectAgents(ctx, event.projectId);
      const capability = norm(draft.capability);
      const chosen = agents.find((a) => a.name === draft.chosen);
      agentId = chosen?._id ?? event.agentId;
      const alternatives = new Set(draft.alternatives);
      for (const a of agents) {
        if (a.name !== draft.chosen && (a.capabilities ?? []).map(norm).includes(capability)) alternatives.add(a.name);
      }
      draft.alternatives = [...alternatives].slice(0, 10);
    }
    const [expected, snapshotId] = await Promise.all([expectedFor(ctx, task, draft), snapshotFor(ctx, task._id, draft)]);
    return await ctx.db.insert("decisions", {
      projectId: event.projectId,
      taskId: event.taskId,
      ...(draft.subtaskKey ? { subtaskKey: draft.subtaskKey } : {}),
      type: draft.type,
      chosen: draft.chosen.slice(0, 200),
      alternatives: draft.alternatives,
      ...(draft.reason ? { reason: draft.reason } : {}),
      ...(expected ? { expected } : {}),
      ...(snapshotId ? { snapshotId } : {}),
      sourceEventId: event._id,
      dedupeKey: draft.dedupeKey,
      ...(agentId ? { agentId } : {}),
      ...(draft.agentName ? { agentName: draft.agentName } : {}),
      ...(draft.capability ? { capability: draft.capability } : {}),
      ...(draft.role ? { role: draft.role } : {}),
      ...(draft.planVersion !== undefined ? { planVersion: draft.planVersion } : {}),
      ...(draft.meta ? { meta: draft.meta } : {}),
      decidedAt: draft.decidedAt,
      ...(options.backfilled ? { backfilled: true } : {}),
    });
  } catch (error) {
    console.warn("[calibration.record] skipped", event.type, error instanceof Error ? error.message : String(error));
    return null;
  }
}

/** Record a decision for an event just inserted by id (plan.created, delegation). */
export async function recordDecisionForEventId(ctx: MutationCtx, eventId: Id<"taskEvents">): Promise<void> {
  const event = await ctx.db.get(eventId);
  if (!event) return;
  await recordDecisionForEvent(ctx, event);
}

/** Schedule a (re)evaluation of a task's decisions; never awaited by the run. */
export async function scheduleDecisionEvaluation(ctx: MutationCtx, taskId: Id<"tasks">): Promise<void> {
  try {
    // Nothing to label: a run with no recorded decision schedules nothing.
    const any = await ctx.db
      .query("decisions")
      .withIndex("by_task", (q) => q.eq("taskId", taskId))
      .first();
    if (!any) return;
    await ctx.scheduler.runAfter(0, internal.calibration.evaluateTask, { taskId });
  } catch (error) {
    console.warn("[calibration.schedule] skipped", error instanceof Error ? error.message : String(error));
  }
}

/** Prior labelled routing picks per agent × capability (before `before`). */
async function routingHistory(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  before: number,
  excludeTask: Id<"tasks">
): Promise<Map<string, RoutingHistory>> {
  const rows = await ctx.db
    .query("decisions")
    .withIndex("by_project", (q) => q.eq("projectId", projectId).lt("decidedAt", before))
    .order("desc")
    .take(HISTORY_CAP);
  const out = new Map<string, RoutingHistory>();
  for (const row of rows) {
    if (row.type !== "routing" || row.taskId === excludeTask || !row.label || row.label === "unknown") continue;
    const key = `${row.agentName}::${norm(row.capability)}`;
    const h = out.get(key) ?? { bad: 0, total: 0 };
    h.total += 1;
    if (row.label === "bad") h.bad += 1;
    out.set(key, h);
  }
  return out;
}

/** Evaluate every decision of a task from its current evidence. Idempotent. */
export async function evaluateTaskDecisions(ctx: MutationCtx, taskId: Id<"tasks">): Promise<{ evaluated: number }> {
  const task = await ctx.db.get(taskId);
  if (!task) return { evaluated: 0 };
  const decisions = await ctx.db
    .query("decisions")
    .withIndex("by_task", (q) => q.eq("taskId", taskId))
    .take(ROWS_CAP);
  if (decisions.length === 0) return { evaluated: 0 };
  const [events, subtasks, plans, approvals, fileChanges, usage] = await Promise.all([
    ctx.db.query("taskEvents").withIndex("by_task", (q) => q.eq("taskId", taskId)).take(EVENTS_CAP),
    ctx.db.query("subtasks").withIndex("by_task", (q) => q.eq("taskId", taskId)).take(ROWS_CAP),
    ctx.db.query("plans").withIndex("by_task", (q) => q.eq("taskId", taskId)).take(100),
    ctx.db.query("approvals").withIndex("by_task", (q) => q.eq("taskId", taskId)).take(ROWS_CAP),
    ctx.db.query("fileChanges").withIndex("by_task", (q) => q.eq("taskId", taskId)).take(ROWS_CAP),
    ctx.db.query("tokenUsage").withIndex("by_task", (q) => q.eq("taskId", taskId)).take(ROWS_CAP * 2),
  ]);
  const evidence = buildTaskEvidence({
    task: { status: task.status, requirementCoverage: task.requirementCoverage ?? null },
    subtasks: subtasks.map((s) => ({
      key: s.key,
      status: s.status,
      acceptanceStatus: s.acceptanceStatus ?? null,
      gateResults: s.gateResults ?? null,
      attempts: s.attempts,
      origin: s.origin ?? null,
      startedAt: s.startedAt ?? null,
      completedAt: s.completedAt ?? null,
    })),
    plans: plans.map((p) => ({ version: p.version, createdAt: p.createdAt, createdBy: p.createdBy, estimate: p.estimate, payload: undefined })),
    events: events.map((e) => ({ type: e.type, payload: e.payload, subtaskKey: e.subtaskKey ?? null, createdAt: e.createdAt ?? e._creationTime })),
    approvals: approvals.map((a) => ({ kind: a.kind, status: a.status, subtaskKey: a.subtaskKey ?? null, planVersion: a.planVersion ?? null })),
    fileChanges: fileChanges.map((f) => ({ filePath: f.filePath, subtaskKey: f.subtaskKey ?? null })),
    usage: usage.filter((u) => u.kind !== "playground").map((u) => ({ subtaskKey: u.subtaskKey ?? null, inputTokens: u.inputTokens, outputTokens: u.outputTokens })),
  });
  const first = Math.min(...decisions.map((d) => d.decidedAt));
  const history = decisions.some((d) => d.type === "routing")
    ? await routingHistory(ctx, task.projectId, first, taskId)
    : new Map<string, RoutingHistory>();
  const now = Date.now();
  for (const d of decisions) {
    const outcome = labelDecision(
      {
        type: d.type,
        subtaskKey: d.subtaskKey ?? null,
        chosen: d.chosen,
        decidedAt: d.decidedAt,
        planVersion: d.planVersion ?? null,
        agentName: d.agentName ?? null,
        capability: d.capability ?? null,
        meta: (d.meta as Record<string, unknown> | undefined) ?? null,
      },
      evidence,
      d.type === "routing" ? history.get(`${d.agentName}::${norm(d.capability)}`) : undefined
    );
    const signals = { ...outcome.signals, ...(d.role ? { role: d.role } : {}) };
    const same =
      d.outcome &&
      d.outcome.label === outcome.label &&
      d.outcome.final === outcome.final &&
      JSON.stringify(d.outcome.factors) === JSON.stringify(outcome.factors) &&
      JSON.stringify(d.outcome.signals) === JSON.stringify(signals);
    if (same) continue;
    await ctx.db.patch(d._id, {
      label: outcome.label,
      outcome: { label: outcome.label, factors: outcome.factors, final: outcome.final, signals, evaluatedAt: now },
    });
  }
  return { evaluated: decisions.length };
}
