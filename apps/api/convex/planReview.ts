import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { assertProjectAccess, getVisibleTask } from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";
import { holdsTaskLease } from "./orchestration";
import { planReviewSetting } from "./schema";
import { writePlanVersion } from "./lib/planStore";
import { applyPlanEdits, roleKeyForCapability, type PlanEditOp } from "./lib/planEdit";
import {
  estimatePlan,
  formatEstimateLine,
  HISTORY_ROWS,
  samplesFromUsage,
  type EstimateModel,
  type EstimateSample,
  type PlanEstimate,
} from "./lib/estimate";
import { normalizePlanReview } from "./lib/planReviewPolicy";
import { ROLE_KEYS } from "./lib/roles";

/**
 * Plan Inspector (review the plan before it runs) and the Task Estimator's
 * backend half.
 *
 * Flow: the worker saves a plan, computes its estimate, and — when the
 * project's `planReview` setting applies — calls `requestReview`, which
 * opens a `plan` approval, moves the task to needs_approval (stage
 * `waiting_plan_approval`) and posts one Plan card. The card reads live
 * state from `forTask`. Approve re-queues the task (the next claim adopts
 * the approved stored plan and executes it); Reject ends it as rejected;
 * an edit writes a new plan version (createdBy "user", checked by the
 * shared plan validator) under a fresh pending approval; "Replan with note"
 * re-queues the task with the note as planner feedback.
 */

const TERMINAL = new Set(["done", "failed", "rejected"]);
/** Upper bound on edit operations per request (the card sends a handful). */
const MAX_OPS = 50;
const NOTE_MAX = 2000;

// ─── Estimator history ────────────────────────────────────────────────────

/**
 * Recent per-subtask usage samples for a project: the last HISTORY_ROWS
 * tokenUsage rows that carry a subtask key, joined to the subtask's kind,
 * the agent's role and the execution's duration.
 */
export async function loadEstimateSamples(ctx: QueryCtx, projectId: Id<"projects">): Promise<EstimateSample[]> {
  const usage = await ctx.db
    .query("tokenUsage")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .order("desc")
    .take(HISTORY_ROWS);
  const kindsByTask = new Map<string, Map<string, string>>();
  const roleByAgent = new Map<string, string | null>();
  const durationByExecution = new Map<string, number | null>();
  const rows = [];
  for (const row of usage) {
    if (!row.taskId || !row.subtaskKey) continue;
    const taskKey = row.taskId as string;
    let kinds = kindsByTask.get(taskKey);
    if (!kinds) {
      const subtasks = await ctx.db
        .query("subtasks")
        .withIndex("by_task", (q) => q.eq("taskId", row.taskId!))
        .take(200);
      kinds = new Map(subtasks.map((s) => [s.key, s.kind as string]));
      kindsByTask.set(taskKey, kinds);
    }
    let role: string | null = null;
    if (row.agentId) {
      const key = row.agentId as string;
      if (!roleByAgent.has(key)) roleByAgent.set(key, (await ctx.db.get(row.agentId))?.role?.toLowerCase() ?? null);
      role = roleByAgent.get(key) ?? null;
    }
    role ??= row.agentName ? row.agentName.trim().toLowerCase() : null;
    let durationMs: number | null = null;
    if (row.executionId) {
      const key = row.executionId as string;
      if (!durationByExecution.has(key)) {
        const exec = await ctx.db.get(row.executionId);
        const start = exec ? exec.startedAt ?? exec.createdAt : undefined;
        durationByExecution.set(
          key,
          exec && start !== undefined && exec.completedAt && exec.status === "completed" ? exec.completedAt - start : null
        );
      }
      durationMs = durationByExecution.get(key) ?? null;
    }
    rows.push({
      taskId: taskKey,
      subtaskKey: row.subtaskKey,
      kind: kinds.get(row.subtaskKey) ?? null,
      role,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      durationMs,
    });
  }
  return samplesFromUsage(rows);
}

export const estimateSamples = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => await loadEstimateSamples(ctx, args.projectId),
});

// ─── Shared helpers ───────────────────────────────────────────────────────

/** Enabled agents of a task's run (same pool rule as getRunContext). */
async function runAgents(ctx: QueryCtx, task: Doc<"tasks">): Promise<Doc<"agents">[]> {
  const project = await ctx.db.get(task.projectId);
  const assigned = task.assignedAgentIds?.length ? task.assignedAgentIds : project?.agentIds;
  if (!assigned?.length) return [];
  const agents: Doc<"agents">[] = [];
  for (const id of assigned) {
    const agent = await ctx.db.get(id);
    if (agent && agent.isEnabled !== false) agents.push(agent);
  }
  return agents;
}

function enabledRoleKeys(agents: Doc<"agents">[]): string[] {
  const roles = new Set<string>();
  for (const agent of agents) {
    const role = (agent.role ?? "").trim().toLowerCase();
    if ((ROLE_KEYS as readonly string[]).includes(role)) roles.add(role);
  }
  return ROLE_KEYS.filter((key) => roles.has(key));
}

async function latestPlan(ctx: QueryCtx, taskId: Id<"tasks">): Promise<Doc<"plans"> | null> {
  const rows = await ctx.db
    .query("plans")
    .withIndex("by_task", (q) => q.eq("taskId", taskId))
    .order("desc")
    .take(1);
  return rows[0] ?? null;
}

async function planApprovals(ctx: QueryCtx, taskId: Id<"tasks">): Promise<Doc<"approvals">[]> {
  const rows = await ctx.db
    .query("approvals")
    .withIndex("by_task", (q) => q.eq("taskId", taskId))
    .collect();
  return rows.filter((row) => row.kind === "plan").sort((a, b) => a._creationTime - b._creationTime);
}

type PlanSubtaskRow = {
  key: string;
  title: string;
  description: string;
  kind: Doc<"subtasks">["kind"];
  capability: string;
  dependencies: string[];
  order: number;
  allowedPaths?: string[];
  origin?: string;
  reviewRound?: number;
};

function subtaskRows(payload: unknown): PlanSubtaskRow[] {
  const subtasks = (payload as { subtasks?: unknown[] } | null)?.subtasks;
  if (!Array.isArray(subtasks)) return [];
  return subtasks.map((raw, index) => {
    const s = raw as Record<string, unknown>;
    return {
      key: String(s.key ?? ""),
      title: String(s.title ?? s.key ?? ""),
      description: typeof s.description === "string" ? s.description : "",
      kind: String(s.kind ?? "analysis") as Doc<"subtasks">["kind"],
      capability: String(s.capability ?? "general"),
      dependencies: Array.isArray(s.dependencies) ? (s.dependencies as unknown[]).map(String) : [],
      order: typeof s.order === "number" ? s.order : index,
      ...(Array.isArray(s.allowedPaths) ? { allowedPaths: (s.allowedPaths as unknown[]).map(String) } : {}),
      ...(typeof s.origin === "string" ? { origin: s.origin } : {}),
      ...(typeof s.reviewRound === "number" ? { reviewRound: s.reviewRound } : {}),
    };
  });
}

/**
 * Role per subtask: the worker's routed role from the estimate when it has
 * one (it routed the capability against the real team), else the role
 * whose seeded capability matches, else null.
 */
function rolesFor(subtasks: PlanSubtaskRow[], estimate: PlanEstimate | null, overrides: Record<string, string> = {}) {
  const fromEstimate = new Map((estimate?.perSubtask ?? []).map((s) => [s.key, s.role]));
  return new Map(
    subtasks.map((s) => [s.key, overrides[s.key] ?? fromEstimate.get(s.key) ?? roleKeyForCapability(s.capability)])
  );
}

function asEstimate(value: unknown): PlanEstimate | null {
  return value && typeof value === "object" && (value as PlanEstimate).version === 1 ? (value as PlanEstimate) : null;
}

async function closePlanApproval(
  ctx: MutationCtx,
  approval: Doc<"approvals">,
  reason: string,
  now: number,
  extra: Record<string, unknown> = {}
) {
  await ctx.db.patch(approval._id, {
    status: "cancelled",
    resolvedAt: now,
    history: [...(approval.history ?? []), { at: now, from: approval.status, to: "cancelled", reason, ...extra }],
  });
}

// ─── Worker: open the review ──────────────────────────────────────────────

export const requestReview = internalMutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    planVersion: v.number(),
    reason: v.optional(v.string()),
    workerId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task || task.projectId !== args.projectId) return { applied: false as const, reason: "task_not_found" as const };
    if (TERMINAL.has(task.status)) return { applied: false as const, reason: "task_already_terminal" as const };
    if (!(await holdsTaskLease(ctx, args.taskId, args.workerId))) {
      return { applied: false as const, reason: "lease_lost" as const };
    }
    const plan = await latestPlan(ctx, args.taskId);
    if (!plan || plan.version !== args.planVersion) {
      return { applied: false as const, reason: "plan_version_mismatch" as const };
    }
    const now = Date.now();
    const approvals = await planApprovals(ctx, args.taskId);
    let approvalId = approvals.find((a) => a.status === "pending" && a.planVersion === args.planVersion)?._id;
    for (const stale of approvals) {
      if (stale.status === "pending" && stale.planVersion !== args.planVersion) {
        await closePlanApproval(ctx, stale, "superseded_by_new_plan", now);
      }
    }
    const count = subtaskRows(plan.payload).length;
    if (!approvalId) {
      approvalId = await ctx.db.insert("approvals", {
        taskId: args.taskId,
        projectId: args.projectId,
        kind: "plan",
        summary: `Review plan v${args.planVersion} · ${count} ${count === 1 ? "subtask" : "subtasks"}`,
        payload: { reason: args.reason ?? null },
        planVersion: args.planVersion,
        status: "pending",
      });
      await ctx.db.insert("taskEvents", {
        taskId: args.taskId,
        projectId: args.projectId,
        type: "approval.requested",
        payload: { kind: "plan", planVersion: args.planVersion, reason: args.reason ?? null },
        level: "warn",
      });
    }
    // Same transition as requestApproval: the run pauses and gives up its
    // lease; the approval decides what happens next.
    await ctx.db.patch(args.taskId, {
      status: "needs_approval",
      phase: "planning",
      updatedAt: now,
      workerId: undefined,
      leaseExpiresAt: undefined,
    });
    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      projectId: args.projectId,
      type: "task.stage",
      payload: { stage: "waiting_plan_approval", planVersion: args.planVersion, reason: args.reason ?? null },
      level: "info",
    });
    // One Plan card per task: it reads live state, so a later review round
    // (edit or replan) shows on the same card.
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .order("desc")
      .take(100);
    if (!recent.some((m) => m.card?.kind === "plan")) {
      await ctx.db.insert("messages", {
        projectId: args.projectId,
        taskId: args.taskId,
        conversationId: task.conversationId,
        authorType: "agent",
        content: "",
        card: { kind: "plan", data: { taskId: String(args.taskId) } },
      });
    }
    return { applied: true as const, approvalId };
  },
});

// ─── Plan card: live state ────────────────────────────────────────────────

export const forTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return null;
    const plan = await latestPlan(ctx, task._id);
    const approvals = await planApprovals(ctx, task._id);
    const agents = await runAgents(ctx, task);
    const approval = approvals.at(-1) ?? null;
    if (!plan) {
      return { task: { _id: task._id, title: task.title, status: task.status }, plan: null, approval, enabledRoles: enabledRoleKeys(agents) };
    }
    const subtasks = subtaskRows(plan.payload);
    const estimate = asEstimate(plan.estimate);
    const roles = rolesFor(subtasks, estimate);
    return {
      task: { _id: task._id, title: task.title, status: task.status },
      plan: {
        version: plan.version,
        createdBy: plan.createdBy,
        goal: plan.goal,
        strategy: plan.strategy,
        degradedReason: plan.degradedReason ?? null,
        subtasks: subtasks.map((s) => ({
          key: s.key,
          title: s.title,
          description: s.description,
          kind: s.kind,
          capability: s.capability,
          dependencies: s.dependencies,
          allowedPaths: s.allowedPaths ?? [],
          role: roles.get(s.key) ?? null,
        })),
        estimate,
        estimateLine: estimate ? formatEstimateLine(estimate) : null,
      },
      approval: approval
        ? {
            _id: approval._id,
            status: approval.status,
            planVersion: approval.planVersion ?? null,
            resolvedAt: approval.resolvedAt ?? null,
          }
        : null,
      /** Versions reviewed so far (edits supersede the approval of the version they replace). */
      reviewedVersions: approvals.map((a) => ({ version: a.planVersion ?? null, status: a.status })),
      enabledRoles: enabledRoleKeys(agents),
    };
  },
});

// ─── User actions ─────────────────────────────────────────────────────────

async function pendingPlanApproval(ctx: MutationCtx, approvalId: Id<"approvals">) {
  const approval = await ctx.db.get(approvalId);
  if (!approval || approval.kind !== "plan") throw new Error("Plan review not found");
  await assertProjectAccess(ctx, approval.projectId);
  if (approval.status !== "pending") throw new Error(`This plan review is already ${approval.status}`);
  const task = await ctx.db.get(approval.taskId);
  if (!task || TERMINAL.has(task.status)) throw new Error("The task is no longer running");
  return { approval, task };
}

const editOp = v.union(
  v.object({
    op: v.literal("update"),
    key: v.string(),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
  }),
  v.object({ op: v.literal("reassign"), key: v.string(), role: v.string() }),
  v.object({
    op: v.literal("remove"),
    key: v.string(),
    dependents: v.optional(v.union(v.literal("relink"), v.literal("reject"))),
  })
);

/**
 * Edit the plan under review. Applies the operations, validates the result
 * with the shared plan validator, and on success writes version N+1
 * (createdBy "user") with a recomputed estimate under a fresh pending
 * approval. An invalid edit is refused as a whole and returns its errors.
 */
export const editPlan = mutation({
  args: { approvalId: v.id("approvals"), ops: v.array(editOp) },
  handler: async (ctx, args) => {
    const { approval, task } = await pendingPlanApproval(ctx, args.approvalId);
    if (args.ops.length > MAX_OPS) return { ok: false as const, errors: [`at most ${MAX_OPS} edits per change`] };
    const plan = await latestPlan(ctx, task._id);
    if (!plan || plan.version !== approval.planVersion) {
      return { ok: false as const, errors: ["the plan changed since this review opened; reload and try again"] };
    }
    const agents = await runAgents(ctx, task);
    const ops = args.ops as PlanEditOp[];
    const result = applyPlanEdits({
      plan: plan.payload,
      ops,
      enabledRoles: enabledRoleKeys(agents),
      maxSubtasks: subtaskRows(plan.payload).length,
    });
    if (!result.ok) {
      await ctx.db.insert("taskEvents", {
        taskId: task._id,
        projectId: task.projectId,
        type: "plan.edit_rejected",
        payload: { planVersion: plan.version, errors: result.errors.slice(0, 10) },
        level: "warn",
      });
      return { ok: false as const, errors: result.errors };
    }
    const now = Date.now();
    const version = plan.version + 1;
    const subtasks = subtaskRows(result.plan);
    // Recompute the estimate: unchanged subtasks keep their routed role,
    // reassigned ones take the user's role; models come from the previous
    // estimate (the worker's resolver assignment).
    const previous = asEstimate(plan.estimate);
    const overrides: Record<string, string> = {};
    for (const op of ops) if (op.op === "reassign") overrides[op.key.trim().toLowerCase()] = op.role.trim().toLowerCase();
    const roles = rolesFor(subtasks, previous, overrides);
    const estimate = estimatePlan({
      subtasks: subtasks.map((s) => ({ key: s.key, kind: s.kind, role: roles.get(s.key) ?? null, dependencies: s.dependencies })),
      samples: await loadEstimateSamples(ctx, task.projectId),
      models: (previous?.models ?? {}) as Record<string, EstimateModel>,
      maxConcurrency: typeof (result.plan as { maxConcurrency?: unknown }).maxConcurrency === "number"
        ? ((result.plan as { maxConcurrency: number }).maxConcurrency)
        : undefined,
      now,
    });
    await writePlanVersion(ctx, {
      taskId: task._id,
      projectId: task.projectId,
      version,
      strategy: String((result.plan as { strategy?: unknown }).strategy ?? plan.strategy),
      createdBy: "user",
      goal: plan.goal,
      payload: result.plan,
      subtasks,
      estimate,
      editedFrom: plan.version,
    });
    await closePlanApproval(ctx, approval, "superseded_by_user_edit", now, { supersededBy: version });
    const approvalId = await ctx.db.insert("approvals", {
      taskId: task._id,
      projectId: task.projectId,
      kind: "plan",
      summary: `Review plan v${version} · ${subtasks.length} ${subtasks.length === 1 ? "subtask" : "subtasks"} (edited)`,
      payload: { editedFrom: plan.version },
      planVersion: version,
      status: "pending",
    });
    await ctx.db.patch(task._id, { updatedAt: now });
    await ctx.db.insert("taskEvents", {
      taskId: task._id,
      projectId: task.projectId,
      type: "plan.edited",
      payload: {
        from: plan.version,
        to: version,
        ops: ops.map((op) => ({ op: op.op, key: op.key, ...(op.op === "reassign" ? { role: op.role } : {}) })),
        removed: result.removed,
      },
      level: "info",
    });
    await recordAudit(ctx, {
      tool: "approval",
      action: "plan.edit",
      decision: "recorded",
      target: `plan v${plan.version} → v${version}`,
      projectId: task.projectId,
      taskId: task._id,
      details: { ops: ops.length, removed: result.removed },
    });
    return { ok: true as const, version, approvalId };
  },
});

/** Discard this plan and have the planner make a new one with the user's note. */
export const replanWithNote = mutation({
  args: { approvalId: v.id("approvals"), note: v.string() },
  handler: async (ctx, args) => {
    const { approval, task } = await pendingPlanApproval(ctx, args.approvalId);
    const note = args.note.trim();
    if (!note) return { ok: false as const, errors: ["write a note for the planner first"] };
    if (note.length > NOTE_MAX) return { ok: false as const, errors: [`the note is longer than ${NOTE_MAX} characters`] };
    const now = Date.now();
    await closePlanApproval(ctx, approval, "replan_requested", now);
    await ctx.db.patch(task._id, {
      status: "queued",
      planReviewNote: note,
      workerId: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now,
    });
    await ctx.db.insert("taskEvents", {
      taskId: task._id,
      projectId: task.projectId,
      type: "plan.replan_requested",
      payload: { planVersion: approval.planVersion ?? null, note: note.slice(0, 500) },
      level: "info",
    });
    await recordAudit(ctx, {
      tool: "approval",
      action: "plan.replan",
      decision: "recorded",
      target: approval.summary,
      projectId: task.projectId,
      taskId: task._id,
    });
    return { ok: true as const };
  },
});

/**
 * Called by `approvals.approve` for a `plan` approval (after it is marked
 * approved): re-queue the task so the next claim adopts the approved plan
 * and executes it. Refuses an approval for a superseded version.
 */
export async function onPlanApproved(ctx: MutationCtx, approval: Doc<"approvals">): Promise<void> {
  const task = await ctx.db.get(approval.taskId);
  if (!task || TERMINAL.has(task.status)) return;
  const plan = await latestPlan(ctx, task._id);
  if (!plan || plan.version !== approval.planVersion) {
    throw new Error("This plan was replaced; review the latest version");
  }
  if (task.status !== "needs_approval") return;
  const now = Date.now();
  await ctx.db.patch(task._id, {
    status: "queued",
    workerId: undefined,
    leaseExpiresAt: undefined,
    updatedAt: now,
  });
  await ctx.db.insert("taskEvents", {
    taskId: task._id,
    projectId: task.projectId,
    type: "task.stage",
    payload: { stage: "plan_approved", planVersion: plan.version },
    level: "info",
  });
}

/** Called by `approvals.reject` for a `plan` approval: the task ends as rejected. */
export async function onPlanRejected(ctx: MutationCtx, approval: Doc<"approvals">): Promise<void> {
  const task = await ctx.db.get(approval.taskId);
  if (!task || TERMINAL.has(task.status)) return;
  const now = Date.now();
  await ctx.db.patch(task._id, {
    status: "rejected",
    errorMessage: "Plan rejected by user",
    completedAt: now,
    updatedAt: now,
    workerId: undefined,
    leaseExpiresAt: undefined,
  });
  const subtasks = await ctx.db
    .query("subtasks")
    .withIndex("by_task", (q) => q.eq("taskId", task._id))
    .collect();
  for (const subtask of subtasks) {
    if (subtask.status === "pending" || subtask.status === "ready") {
      await ctx.db.patch(subtask._id, { status: "skipped", error: "Plan rejected by user" });
    }
  }
  await ctx.db.insert("taskEvents", {
    taskId: task._id,
    projectId: task.projectId,
    type: "plan.rejected",
    payload: { planVersion: approval.planVersion ?? null },
    level: "warn",
  });
}

// ─── Project setting ──────────────────────────────────────────────────────

export const setProjectPlanReview = mutation({
  args: { projectId: v.id("projects"), planReview: planReviewSetting },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);
    const next = normalizePlanReview(args.planReview);
    if (normalizePlanReview(project.planReview) === next) return next;
    await ctx.db.patch(args.projectId, { planReview: next });
    await recordAudit(ctx, {
      action: "project.update",
      target: project.name,
      projectId: args.projectId,
      details: { changed: ["planReview"], planReview: next },
    });
    return next;
  },
});

export const getProjectPlanReview = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);
    return normalizePlanReview(project.planReview);
  },
});
