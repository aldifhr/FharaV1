/**
 * GOAT G13: CTO-first questions (audit/goat-plan-2026-11-11.md, idea #10).
 *
 * A question an agent asks (an executor escalation, or `question.ask` from a
 * direct thread through the Fhara MCP server) goes to the CTO's decision
 * turn first when lib/questionPolicy.ts says it is a technical question
 * inside the CTO's ceiling. Everything above the ceiling (secrets, push,
 * destructive, security, product, a dependency under supervised mode)
 * reaches the user as before.
 *
 * Lifecycle of one `decisionTurns` row:
 *   open      → the worker runs the decision turn (the LLM call is worker-side);
 *   answered  → `answer` commits, in ONE mutation, the decision, a
 *               `taskSignals` row named "answer" (the outbox) and an audit
 *               row. Delivery is separate: the live run consumes its inline
 *               answer, and a task_input answer is delivered by `deliver`
 *               (scheduled, and retried by the sweep until consumed);
 *   escalated → the CTO declined (or its answer crossed the ceiling): the
 *               question goes to the user, with an audit row;
 *   expired   → nobody answered in time. Expiry NEVER picks an option, not
 *               even the recommended one: the question goes to the user.
 *
 * Every worker-facing function takes `workerToken` (AGENTS.md #2). The
 * policy is re-run here, so a worker cannot route a push or a secret
 * question to the CTO. D7 (auto review) and N7 (native questions) reuse the
 * table, the outbox and the worker's runDecisionTurn with their own purpose.
 */
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { assertServiceToken, getVisibleTask } from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";
import { appendTaskEvent } from "./lib/taskEvents";
import { patchTask } from "./lib/threadIndex";
import { projectTeamIds } from "./lib/projectTeam";
import { normalizeRoleKey } from "./lib/roles";
import { answerCrossesCeiling, classifyQuestion } from "./lib/questionPolicy";
import { decisionDeliveryValidator, decisionTurnSourceValidator } from "./lib/decisionTurnSchema";
import { touchBriefQuestion } from "./briefs";

const TERMINAL = new Set<Doc<"tasks">["status"]>(["done", "failed", "rejected", "cancelled"]);
export const DECISION_TTL_MIN_MS = 30_000;
export const DECISION_TTL_MAX_MS = 60 * 60_000;
const CLAIM_MS = 2 * 60_000;
const TEXT_MAX = 2000;
const SWEEP_BATCH = 50;

type Source = Infer<typeof decisionTurnSourceValidator>;
type Delivery = Infer<typeof decisionDeliveryValidator>;

export type OpenResult =
  | { route: "user"; category: string; reason: string; noCto?: true }
  | { route: "cto"; turnId: Id<"decisionTurns">; status: "open"; expiresAt: number }
  | { route: "cto"; turnId: Id<"decisionTurns">; status: "answered"; answer: string; chosenOption?: string; rationale?: string };

const clampTtl = (ttlMs: number) => Math.min(DECISION_TTL_MAX_MS, Math.max(DECISION_TTL_MIN_MS, Math.floor(ttlMs)));
const cleanOptions = (options: readonly string[] | undefined) =>
  [...new Set((options ?? []).map((option) => option.trim()).filter(Boolean))].slice(0, 6);

/** The project's enabled CTO agent, or null (no CTO in the team = the user decides). */
export async function projectCto(ctx: Pick<MutationCtx, "db">, project: Doc<"projects">): Promise<Doc<"agents"> | null> {
  for (const id of await projectTeamIds(ctx, project)) {
    const agent = await ctx.db.get(id);
    if (agent && agent.isEnabled !== false && normalizeRoleKey(agent.role) === "cto") return agent;
  }
  return null;
}

export interface OpenTurnInput {
  task: Doc<"tasks">;
  source: Source;
  delivery: Delivery;
  question: string;
  options?: readonly string[];
  kind?: string;
  reason?: string;
  detail?: string;
  subtaskKey?: string;
  dedupeKey: string;
  ttlMs: number;
  workerId?: string;
}

/**
 * Route one question. Returns `user` without writing anything when the policy
 * (or a missing CTO) says the user decides; otherwise opens, re-claims or
 * replays the turn under `dedupeKey`.
 */
export async function openDecisionTurn(ctx: MutationCtx, input: OpenTurnInput): Promise<OpenResult> {
  const { task } = input;
  const options = cleanOptions(input.options);
  const policy = classifyQuestion({
    kind: input.kind,
    question: input.question,
    reason: input.reason,
    detail: input.detail,
    options,
    permissionMode: task.permissionMode,
  });
  if (policy.route === "user") return { route: "user", category: policy.category, reason: policy.reason };
  const project = await ctx.db.get(task.projectId);
  const cto = project ? await projectCto(ctx, project) : null;
  if (!cto) return { route: "user", category: policy.category, reason: "No CTO in this project's team", noCto: true };

  const now = Date.now();
  const existing = await ctx.db
    .query("decisionTurns")
    .withIndex("by_dedupe", (q) => q.eq("dedupeKey", input.dedupeKey))
    .order("desc")
    .first();
  if (existing) {
    if (existing.status === "answered" && existing.signalId) {
      const signal = await ctx.db.get(existing.signalId);
      // Not yet delivered: hand the committed answer back (the outbox retry).
      if (signal && signal.consumedAt === undefined) {
        return {
          route: "cto",
          turnId: existing._id,
          status: "answered",
          answer: existing.answer ?? "",
          ...(existing.chosenOption ? { chosenOption: existing.chosenOption } : {}),
          ...(existing.rationale ? { rationale: existing.rationale } : {}),
        };
      }
      return { route: "user", category: policy.category, reason: "The CTO already answered this and it came back" };
    }
    if (existing.status === "escalated") return { route: "user", category: policy.category, reason: "The CTO handed this to the user" };
    if (existing.status === "expired") return { route: "user", category: policy.category, reason: "The CTO did not answer in time" };
    if (existing.expiresAt <= now) {
      await expireTurn(ctx, existing, "expired before a worker answered");
      return { route: "user", category: policy.category, reason: "The CTO did not answer in time" };
    }
    // Open and live: the worker that held it died mid-turn; this one takes it over.
    await ctx.db.patch(existing._id, { claimedBy: input.workerId, claimedUntil: now + CLAIM_MS });
    return { route: "cto", turnId: existing._id, status: "open", expiresAt: existing.expiresAt };
  }

  const expiresAt = now + clampTtl(input.ttlMs);
  const turnId = await ctx.db.insert("decisionTurns", {
    taskId: task._id,
    projectId: task.projectId,
    ...(input.subtaskKey ? { subtaskKey: input.subtaskKey } : {}),
    role: "cto",
    purpose: "question",
    source: input.source,
    delivery: input.delivery,
    ...(input.kind ? { kind: input.kind } : {}),
    category: policy.category,
    question: input.question.slice(0, TEXT_MAX),
    ...(options.length > 0 ? { options } : {}),
    dedupeKey: input.dedupeKey,
    status: "open",
    expiresAt,
    ...(input.workerId ? { claimedBy: input.workerId, claimedUntil: now + CLAIM_MS } : {}),
    agentId: cto._id,
    createdAt: now,
  });
  await appendTaskEvent(ctx, {
    taskId: task._id,
    projectId: task.projectId,
    type: "decision.routed",
    payload: { turnId, to: "cto", source: input.source, category: policy.category, question: input.question.slice(0, 500) },
    ...(input.subtaskKey ? { subtaskKey: input.subtaskKey } : {}),
    level: "info",
  });
  return { route: "cto", turnId, status: "open", expiresAt };
}

/**
 * Hand a task_input question to the user, the way question.ask parks a task:
 * waiting_input with the question (Needs you). Skipped when the task settled,
 * waits on an approval, already asks something, or a worker holds it.
 */
async function parkForUser(ctx: MutationCtx, turn: Doc<"decisionTurns">, why: string): Promise<boolean> {
  const task = await ctx.db.get(turn.taskId);
  if (!task || TERMINAL.has(task.status) || task.status === "needs_approval") return false;
  if (task.status === "waiting_input" && task.pendingQuestion) return false;
  if (task.workerId && (task.leaseExpiresAt ?? 0) > Date.now()) return false;
  await patchTask(ctx, task._id, {
    status: "waiting_input",
    pendingQuestion: turn.question,
    pendingOptions: turn.options && turn.options.length >= 2 ? turn.options : undefined,
    updatedAt: Date.now(),
  });
  await touchBriefQuestion(ctx, task, { add: turn.question });
  await appendTaskEvent(ctx, {
    taskId: task._id,
    projectId: task.projectId,
    type: "task.input_asked",
    payload: { question: turn.question.slice(0, 500), source: turn.source, turnId: turn._id, why },
    level: "info",
  });
  return true;
}

/** Close an open turn as expired. No option is chosen; a task_input question goes to the user. */
async function expireTurn(ctx: MutationCtx, turn: Doc<"decisionTurns">, why: string): Promise<void> {
  if (turn.status !== "open") return;
  await ctx.db.patch(turn._id, { status: "expired", decidedAt: Date.now(), claimedBy: undefined, claimedUntil: undefined });
  await appendTaskEvent(ctx, {
    taskId: turn.taskId,
    projectId: turn.projectId,
    type: "decision.expired",
    payload: { turnId: turn._id, role: turn.role, why, autoPicked: false },
    ...(turn.subtaskKey ? { subtaskKey: turn.subtaskKey } : {}),
    level: "warn",
  });
  if (turn.delivery === "task_input") await parkForUser(ctx, turn, "expired");
}

const tokenArg = { workerToken: v.string() };

/** Worker: route a question (escalation path). */
export const open = mutation({
  args: {
    ...tokenArg,
    taskId: v.id("tasks"),
    workerId: v.string(),
    source: decisionTurnSourceValidator,
    delivery: decisionDeliveryValidator,
    question: v.string(),
    options: v.optional(v.array(v.string())),
    kind: v.optional(v.string()),
    reason: v.optional(v.string()),
    detail: v.optional(v.string()),
    subtaskKey: v.optional(v.string()),
    dedupeKey: v.string(),
    ttlMs: v.number(),
  },
  handler: async (ctx, args): Promise<OpenResult> => {
    assertServiceToken(args.workerToken);
    const task = await ctx.db.get(args.taskId);
    if (!task || TERMINAL.has(task.status)) return { route: "user", category: "product", reason: "Task not open" };
    const { workerToken: _token, taskId: _taskId, ...rest } = args;
    return await openDecisionTurn(ctx, { ...rest, task });
  },
});

/** Worker: claim the next open task_input turn (questions from direct threads via MCP). */
export const claimNext = mutation({
  args: { ...tokenArg, workerId: v.string() },
  handler: async (ctx, args) => {
    assertServiceToken(args.workerToken);
    const now = Date.now();
    const rows = await ctx.db
      .query("decisionTurns")
      .withIndex("by_status_and_expires", (q) => q.eq("status", "open").gt("expiresAt", now))
      .take(SWEEP_BATCH);
    const turn = rows.find((row) => row.delivery === "task_input" && (row.claimedUntil ?? 0) <= now);
    if (!turn) return null;
    await ctx.db.patch(turn._id, { claimedBy: args.workerId, claimedUntil: now + CLAIM_MS });
    return {
      turnId: turn._id,
      taskId: turn.taskId,
      projectId: turn.projectId,
      question: turn.question,
      options: turn.options ?? [],
      kind: turn.kind ?? null,
      category: turn.category,
      expiresAt: turn.expiresAt,
    };
  },
});

/**
 * Worker: record the decision turn's verdict. One transaction writes the
 * turn, the outbox signal (answers only) and the audit row. Refused after
 * expiry: a late answer never lands, and nothing is picked for it.
 */
export const answer = mutation({
  args: {
    ...tokenArg,
    turnId: v.id("decisionTurns"),
    workerId: v.string(),
    verdict: v.union(v.literal("answer"), v.literal("escalate")),
    answer: v.optional(v.string()),
    chosenOption: v.optional(v.string()),
    rationale: v.string(),
  },
  handler: async (ctx, args) => {
    assertServiceToken(args.workerToken);
    const turn = await ctx.db.get(args.turnId);
    if (!turn) return { applied: false as const, reason: "not_found" as const };
    if (turn.status !== "open") return { applied: false as const, reason: "closed" as const };
    const now = Date.now();
    if (turn.expiresAt <= now) {
      await expireTurn(ctx, turn, "the answer arrived after the deadline");
      return { applied: false as const, reason: "expired" as const };
    }
    const options = turn.options ?? [];
    const text = (args.answer ?? "").trim().slice(0, TEXT_MAX);
    const chosen = args.chosenOption?.trim();
    if (args.verdict === "answer" && options.length > 0 && (!chosen || !options.includes(chosen))) {
      return { applied: false as const, reason: "invalid_option" as const };
    }
    const crosses = args.verdict === "answer" && answerCrossesCeiling(text, chosen);
    const escalate = args.verdict === "escalate" || !text || crosses;
    const rationale = (crosses ? "The answer crossed the CTO's ceiling; " : "") + args.rationale.trim().slice(0, TEXT_MAX);
    const agent = turn.agentId ? await ctx.db.get(turn.agentId) : null;
    let signalId: Id<"taskSignals"> | undefined;
    if (!escalate) {
      signalId = await ctx.db.insert("taskSignals", {
        taskId: turn.taskId,
        projectId: turn.projectId,
        name: "answer",
        decisionTurnId: turn._id,
        answer: text,
        ...(turn.subtaskKey ? { subtaskKey: turn.subtaskKey } : {}),
        createdAt: now,
      });
    }
    await ctx.db.patch(turn._id, {
      status: escalate ? "escalated" : "answered",
      ...(escalate ? {} : { answer: text, ...(chosen ? { chosenOption: chosen } : {}), signalId }),
      rationale,
      decidedAt: now,
      claimedBy: undefined,
      claimedUntil: undefined,
    });
    await recordAudit(ctx, {
      actor: agent?.name ? `cto:${agent.name}` : "cto",
      tool: "decision_turn",
      action: escalate ? "decision.cto_escalated" : "decision.cto_answered",
      decision: escalate ? "denied" : "allowed",
      target: turn.question,
      projectId: turn.projectId,
      taskId: turn.taskId,
      details: {
        turnId: turn._id,
        role: turn.role,
        source: turn.source,
        category: turn.category,
        ...(turn.kind ? { kind: turn.kind } : {}),
        ...(chosen && !escalate ? { chosenOption: chosen } : {}),
        rationale: rationale.slice(0, 500),
      },
    });
    await appendTaskEvent(ctx, {
      taskId: turn.taskId,
      projectId: turn.projectId,
      type: escalate ? "decision.escalated" : "decision.answered",
      payload: { turnId: turn._id, role: turn.role, ...(escalate ? {} : { answer: text.slice(0, 500), chosenOption: chosen ?? null }) },
      ...(turn.subtaskKey ? { subtaskKey: turn.subtaskKey } : {}),
      level: "info",
    });
    if (turn.delivery === "task_input") {
      if (escalate) await parkForUser(ctx, turn, "escalated");
      else if (signalId) await ctx.scheduler.runAfter(0, internal.decisionTurns.deliver, { signalId });
    }
    return { applied: true as const, status: escalate ? ("escalated" as const) : ("answered" as const) };
  },
});

/** Worker: the decision turn could not finish in time (or the worker gave up): expire it. */
export const expire = mutation({
  args: { ...tokenArg, turnId: v.id("decisionTurns"), why: v.string() },
  handler: async (ctx, args) => {
    assertServiceToken(args.workerToken);
    const turn = await ctx.db.get(args.turnId);
    if (!turn || turn.status !== "open") return { applied: false };
    await expireTurn(ctx, turn, args.why.slice(0, 200));
    return { applied: true };
  },
});

/** Worker (inline delivery): the live run applied the answer; consume its signal. Idempotent. */
export const consume = mutation({
  args: { ...tokenArg, turnId: v.id("decisionTurns"), workerId: v.string() },
  handler: async (ctx, args) => {
    assertServiceToken(args.workerToken);
    const turn = await ctx.db.get(args.turnId);
    const signal = turn?.signalId ? await ctx.db.get(turn.signalId) : null;
    if (!signal || signal.consumedAt !== undefined) return { consumed: false };
    await ctx.db.patch(signal._id, { consumedAt: Date.now(), consumedBy: args.workerId });
    return { consumed: true };
  },
});

/**
 * Deliver one task_input answer: record it as the task's answer input (the
 * next run renders it into the prompt, like a user answer) and wake a task
 * parked on that question. Idempotent: a consumed signal is skipped.
 */
export const deliver = internalMutation({
  args: { signalId: v.id("taskSignals") },
  handler: async (ctx, args) => {
    const signal = await ctx.db.get(args.signalId);
    if (!signal || signal.name !== "answer" || signal.consumedAt !== undefined) return { delivered: false };
    const turn = signal.decisionTurnId ? await ctx.db.get(signal.decisionTurnId) : null;
    const task = await ctx.db.get(signal.taskId);
    const now = Date.now();
    if (!turn || turn.delivery !== "task_input") return { delivered: false };
    if (!task || TERMINAL.has(task.status)) {
      await ctx.db.patch(signal._id, { consumedAt: now, consumedBy: "terminal" });
      return { delivered: false };
    }
    await ctx.db.insert("taskInputs", {
      taskId: task._id,
      projectId: task.projectId,
      kind: "answer",
      text: `CTO: ${signal.answer ?? ""}`.slice(0, TEXT_MAX),
      question: turn.question,
      delivered: false,
      createdAt: now,
    });
    await appendTaskEvent(ctx, {
      taskId: task._id,
      projectId: task.projectId,
      type: "task.input_answered",
      payload: { answer: (signal.answer ?? "").slice(0, 500), by: "cto", turnId: turn._id },
      level: "info",
    });
    if (task.status === "waiting_input" && task.pendingQuestion === turn.question) {
      await touchBriefQuestion(ctx, task, { resolve: task.pendingQuestion });
      await patchTask(ctx, task._id, {
        status: "queued",
        pendingQuestion: undefined,
        pendingOptions: undefined,
        workerId: undefined,
        leaseExpiresAt: undefined,
        updatedAt: now,
      });
    }
    await ctx.db.patch(signal._id, { consumedAt: now, consumedBy: "deliver" });
    return { delivered: true };
  },
});

/** Cron: expire turns past their deadline (never auto-picking) and retry undelivered task_input answers. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const stale = await ctx.db
      .query("decisionTurns")
      .withIndex("by_status_and_expires", (q) => q.eq("status", "open").lte("expiresAt", now))
      .take(SWEEP_BATCH);
    for (const turn of stale) await expireTurn(ctx, turn, "no answer before the deadline");
    const open = await ctx.db
      .query("taskSignals")
      .withIndex("by_name_and_consumed", (q) => q.eq("name", "answer").eq("consumedAt", undefined))
      .take(SWEEP_BATCH);
    let redelivered = 0;
    for (const signal of open) {
      const turn = signal.decisionTurnId ? await ctx.db.get(signal.decisionTurnId) : null;
      if (turn?.delivery !== "task_input" || now - signal.createdAt < 30_000) continue;
      await ctx.scheduler.runAfter(0, internal.decisionTurns.deliver, { signalId: signal._id });
      redelivered += 1;
    }
    return { expired: stale.length, redelivered };
  },
});

/**
 * UI (ui-g13): the task's newest CTO decision turn, for the quiet System line
 * in the task thread ("Waiting on CTO · expires in 9m", the answer, or
 * "Sent to you"). Null when the task has none or the caller cannot see it.
 */
export const latestForTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return null;
    const turn = await ctx.db
      .query("decisionTurns")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .order("desc")
      .first();
    if (!turn) return null;
    return {
      _id: turn._id,
      role: turn.role,
      status: turn.status,
      expiresAt: turn.expiresAt,
      createdAt: turn.createdAt,
      decidedAt: turn.decidedAt ?? null,
      answer: turn.answer ? turn.answer.slice(0, 500) : null,
      chosenOption: turn.chosenOption ?? null,
    };
  },
});
