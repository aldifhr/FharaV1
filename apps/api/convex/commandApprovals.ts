/**
 * In-process command approvals (chat UX, Feature 2).
 *
 * `orchestration.requestApproval` parks the whole task in needs_approval and
 * RELEASES its lease; approving re-queues the run. That is right for
 * apply_changes (a stage boundary) but would stall or re-run the DAG for a
 * single command. A run_command approval therefore waits in-process: the
 * worker keeps its lease and heartbeat, writes a pending row here, polls
 * `get` until the user decides, and cancels the row itself on pause, stop
 * or timeout. The task status never changes.
 *
 * Policy (lib/commandRules.ts): dangerous / push-like commands always ask
 * and never offer "Always allow"; a project rule, an exact entry (plan 041)
 * or Full access approves (recorded as decidedBy "auto"); everything else asks.
 * D7: in Full access the project's Reviewer judges the command first
 * (lib/autoReview.ts, `review` below); with no Reviewer in the team the
 * pre-D7 behaviour stands.
 */
import { internalMutation, internalQuery, mutation, type MutationCtx } from "./_generated/server";
import { checkShown } from "./lib/approvalFingerprint";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { assertProjectAccess, assertServiceToken, getViewerId } from "./lib/authz";
import { projectTeamIds } from "./lib/projectTeam";
import { normalizeRoleKey } from "./lib/roles";
import { AUTO_REVIEW_TTL_MS, autoReviewFloor, describeReviewVerdict, parseAutoReviewOutput, type AutoReviewRequest } from "./lib/autoReview";
import { recordAudit } from "./lib/recordAudit";
import { holdsTaskLease } from "./orchestration";
import { signalApprovalDecision, supersedePendingCommandApprovals } from "./taskSignals";
import { autoReviewApplies, normalizePermissionMode } from "./lib/permissionModes";
import {
  addCommandAllowExact,
  addCommandAllowRule,
  commandApprovalPolicy,
  effectiveCommandDecision,
  formatCommand,
  normalizeRulePrefix,
  removeCommandAllowExact,
  type CommandDecision,
} from "./lib/commandRules";
import { appendTaskEvent } from "./lib/taskEvents";
import { commandRequestArgs, isCommandApprovalKind, UNCONFINED_WARNING, type CommandRequestResult } from "./lib/commandApprovalKinds";

const TERMINAL = new Set(["done", "failed", "rejected", "cancelled"]);
const LEASE_LOST = "Lease lost: this task is no longer owned by this worker";
/** Note recorded when a chat message declines a waiting command (threadbear behaviour). */
export const USER_REPLIED_NOTE = "user replied instead";

export const decisionValidator = v.union(v.literal("allow"), v.literal("always"), v.literal("always_exact"), v.literal("deny"));

/**
 * Worker → backend: ask for one command. Returns `auto` (approved row
 * already written, run it), `pending` with the row id to wait on, or
 * `review` (D7, Full access): the row is pending while the project's
 * Reviewer judges it; the worker runs that decision turn and reports it
 * through `review`, then waits on the same row like any card.
 * D6: kind `run_unconfined` (a rerun without the bwrap sandbox) always
 * asks, in every mode, offers no "Always allow", reuses no earlier allow
 * and is never sent to the Reviewer.
 */
export const request = internalMutation({
  args: commandRequestArgs,
  handler: async (ctx, args): Promise<CommandRequestResult> => {
    const task = await ctx.db.get(args.taskId);
    if (!task || task.projectId !== args.projectId) throw new Error("Task not found");
    if (TERMINAL.has(task.status)) throw new Error(`Task is already ${task.status}`);
    if (!(await holdsTaskLease(ctx, args.taskId, args.workerId))) throw new Error(LEASE_LOST);
    const project = await ctx.db.get(args.projectId);
    const mode = normalizePermissionMode(task.permissionMode);
    const policy = commandApprovalPolicy({
      mode,
      command: args.command,
      args: args.args,
      rules: project?.commandAllowRules,
      exact: project?.commandAllowExact,
      workspaceRoot: args.workspaceRoot,
    });
    const line = formatCommand(args.command, args.args);
    const now = Date.now();
    const unconfined = args.kind === "run_unconfined";
    const danger = unconfined ? UNCONFINED_WARNING : policy.danger;
    const base: CommandApprovalBase = {
      taskId: args.taskId,
      projectId: args.projectId,
      kind: unconfined ? ("run_unconfined" as const) : ("run_command" as const),
      summary: `${unconfined ? "Run without the sandbox:" : "Run"} ${line}`.slice(0, 300),
      payload: { command: line, head: policy.head, inline: true, ...(danger ? { danger } : {}), ...(unconfined ? { unconfined: true } : {}) },
      toolName: "run_command",
      arguments: { command: args.command, args: args.args },
      ...(args.workspaceRoot ? { workspacePath: args.workspaceRoot } : {}),
      ...(args.requestedByAgentId ? { requestedByAgentId: args.requestedByAgentId } : {}),
      ...(args.executionId ? { executionId: args.executionId } : {}),
      ...(args.subtaskKey ? { subtaskKey: args.subtaskKey } : {}),
      offerAlways: unconfined ? false : policy.offerAlways,
    };
    // D7: Full access asks the Reviewer before it auto-approves (never for a
    // project rule or exact entry the user set, never for run_unconfined).
    const reviewed = !unconfined && autoReviewApplies(mode, "run_command") && !policy.rule && !policy.exact;
    const reviewer = reviewed && project ? await projectRoleAgent(ctx, project, "reviewer") : null;
    if (policy.action === "auto" && !unconfined && !reviewer) {
      const approvalId = await insertAutoApproved(ctx, base, {
        mode,
        reason: reviewed ? `${policy.reason} (no Reviewer in the team)` : policy.reason,
        actor: policy.exact ? "command-exact" : policy.rule ? "command-rule" : "permission-mode",
        details: { ...(policy.rule ? { rule: policy.rule.prefix } : {}), ...(policy.exact ? { exact: true } : {}) },
      });
      return { status: "auto", approvalId, reason: policy.reason, offerAlways: policy.offerAlways };
    }
    // Replay after a lost worker: the user already allowed this exact
    // command for this subtask and no waiter consumed the signal (the old
    // worker died mid-wait). Reuse that decision instead of asking twice.
    const reused = unconfined ? null : await reusableAllow(ctx, args.taskId, args.subtaskKey, line);
    // Command signals always carry their approval (only G13 answer rows have none).
    if (reused?.approvalId) {
      await ctx.db.patch(reused._id, { consumedAt: now, consumedBy: args.workerId ?? "replay" });
      await appendTaskEvent(ctx, {
        taskId: args.taskId,
        projectId: args.projectId,
        type: "approval.signal_reused",
        payload: { kind: "run_command", summary: base.summary, subtaskKey: args.subtaskKey, approvalId: reused.approvalId },
        subtaskKey: args.subtaskKey,
        level: "info",
      });
      return { status: "auto", approvalId: reused.approvalId, reason: "Allowed by the user earlier", offerAlways: policy.offerAlways };
    }
    // Same replay, user not decided yet: adopt the orphaned pending card
    // instead of showing a second one for the same command.
    const orphan = (
      await ctx.db
        .query("approvals")
        .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
        .take(200)
    ).find(
      (row) =>
        row.status === "pending" &&
        row.kind === base.kind &&
        (row.subtaskKey ?? null) === (args.subtaskKey ?? null) &&
        (row.payload as { command?: unknown } | undefined)?.command === line
    );
    if (orphan) {
      return { status: "pending", approvalId: orphan._id, reason: policy.reason, offerAlways: orphan.offerAlways ?? base.offerAlways };
    }
    // Idempotent per (task, subtask): one subtask waits on one command at
    // a time, so an older pending card for this subtask belongs to a run
    // that is gone (re-run after lease recovery, different command). Close
    // it before showing the new one.
    await supersedePendingCommandApprovals(ctx, args.taskId, "superseded: the subtask re-ran and asked again", {
      subtaskKey: args.subtaskKey ?? null,
    });
    if (reviewer && project) {
      const floor = autoReviewFloor(args.command, args.args, args.workspaceRoot);
      if (floor.kind === "rule") {
        // Decided by rule, before any model: audited, then the card.
        const review = { state: "done", by: "rule", risk: floor.risk, decision: "deny", reason: floor.reason };
        const approvalId = await insertPendingCard(ctx, base, { mode, reason: floor.reason, review });
        await auditReviewVerdict(ctx, base, line, {
          action: "auto_review.deny",
          decision: "denied",
          actor: "auto-review:rule",
          approvalId,
          mode,
          by: "rule",
          risk: floor.risk,
          reason: floor.reason,
        });
        return { status: "pending", approvalId, reason: floor.reason, offerAlways: base.offerAlways };
      }
      const request = await reviewRequestFor(ctx, task, project, args, line, policy.danger, mode);
      const approvalId = await insertPendingCard(ctx, base, { mode, reason: "The Reviewer checks this command", review: { state: "reviewing" }, quiet: true });
      const expiresAt = now + AUTO_REVIEW_TTL_MS;
      const turnId = await ctx.db.insert("decisionTurns", {
        taskId: args.taskId,
        projectId: args.projectId,
        ...(args.subtaskKey ? { subtaskKey: args.subtaskKey } : {}),
        role: "reviewer",
        purpose: "auto_review",
        source: "command",
        delivery: "inline",
        kind: "run_command",
        category: "command",
        question: line.slice(0, 2000),
        dedupeKey: `review:${approvalId}`,
        status: "open",
        expiresAt,
        ...(args.workerId ? { claimedBy: args.workerId, claimedUntil: expiresAt } : {}),
        agentId: reviewer._id,
        approvalId,
        createdAt: now,
      });
      await ctx.db.patch(approvalId, { payload: { ...base.payload, review: { state: "reviewing", turnId } } });
      await appendTaskEvent(ctx, {
        taskId: args.taskId,
        projectId: args.projectId,
        type: "decision.routed",
        payload: { turnId, to: "reviewer", source: "command", category: "command", question: line.slice(0, 500), approvalId },
        ...(args.subtaskKey ? { subtaskKey: args.subtaskKey } : {}),
        level: "info",
      });
      return { status: "review", approvalId, reason: "The Reviewer checks this command first", offerAlways: base.offerAlways, review: { turnId, expiresAt, request } };
    }
    const approvalId = await insertPendingCard(ctx, base, { mode, reason: policy.reason });
    return { status: "pending", approvalId, reason: unconfined ? "The command sandbox refused this command" : policy.reason, offerAlways: base.offerAlways };
  },
});

type CommandApprovalBase = Omit<Doc<"approvals">, "_id" | "_creationTime" | "status" | "offerAlways"> & {
  payload: Record<string, unknown>;
  subtaskKey?: string;
  offerAlways: boolean;
};

/** An approved row decided without the user (mode, rule or exact entry), with its event and audit row. */
async function insertAutoApproved(
  ctx: MutationCtx,
  base: CommandApprovalBase,
  how: { mode: string; reason: string; actor: string; details?: Record<string, unknown> }
): Promise<Id<"approvals">> {
  const now = Date.now();
  const approvalId = await ctx.db.insert("approvals", {
    ...base,
    status: "approved",
    resolvedAt: now,
    decidedBy: "auto",
    decision: "allow",
    history: [{ at: now, status: "approved", by: "auto", mode: how.mode, reason: how.reason }],
  });
  await appendTaskEvent(ctx, {
    taskId: base.taskId,
    projectId: base.projectId,
    type: "approval.auto_approved",
    payload: { kind: "run_command", summary: base.summary, subtaskKey: base.subtaskKey, mode: how.mode, reason: how.reason },
    subtaskKey: base.subtaskKey,
    level: "info",
  });
  await recordAudit(ctx, {
    actor: how.actor,
    tool: "run_command",
    action: "approval.auto_approve",
    decision: "allowed",
    target: String(base.payload.command ?? base.summary),
    projectId: base.projectId,
    taskId: base.taskId,
    details: { mode: how.mode, reason: how.reason, approvalId, ...(how.details ?? {}) },
  });
  return approvalId;
}

/** A pending card. `quiet` (D7, under review) holds the "approval requested" event until the Reviewer hands it over. */
async function insertPendingCard(
  ctx: MutationCtx,
  base: CommandApprovalBase,
  how: { mode: string; reason: string; review?: Record<string, unknown>; quiet?: boolean }
): Promise<Id<"approvals">> {
  const now = Date.now();
  const approvalId = await ctx.db.insert("approvals", {
    ...base,
    ...(how.review ? { payload: { ...base.payload, review: how.review } } : {}),
    status: "pending",
    history: [{ at: now, status: "pending", mode: how.mode, reason: how.reason }],
  });
  if (!how.quiet) await announceCard(ctx, base, approvalId);
  return approvalId;
}

async function announceCard(
  ctx: MutationCtx,
  row: Pick<Doc<"approvals">, "taskId" | "projectId" | "kind" | "summary" | "subtaskKey" | "executionId">,
  approvalId: Id<"approvals">
) {
  await appendTaskEvent(ctx, {
    taskId: row.taskId,
    projectId: row.projectId,
    type: "approval.requested",
    payload: { kind: row.kind, summary: row.summary, subtaskKey: row.subtaskKey, inline: true, approvalId },
    executionId: row.executionId,
    subtaskKey: row.subtaskKey,
    level: "warn",
  });
}

/** The project's enabled agent playing `role` (D7: the Reviewer), or null. */
async function projectRoleAgent(ctx: MutationCtx, project: Doc<"projects">, role: string): Promise<Doc<"agents"> | null> {
  for (const id of await projectTeamIds(ctx, project)) {
    const agent = await ctx.db.get(id);
    if (agent && agent.isEnabled !== false && normalizeRoleKey(agent.role) === role) return agent;
  }
  return null;
}

const INSTRUCTION_MAX = 2000;
const MAX_STEERS = 5;
const MAX_FACT_COMMANDS = 20;

/**
 * What the Reviewer judges against: the user's own words for the task (its
 * request, then steers) as instructions, and the task title plus earlier
 * commands of the task as facts (they can prove a task-created object,
 * never authorize).
 */
async function reviewRequestFor(
  ctx: MutationCtx,
  task: Doc<"tasks">,
  project: Doc<"projects">,
  args: { command: string; args: string[]; workspaceRoot?: string },
  line: string,
  danger: string | null,
  mode: string
): Promise<AutoReviewRequest> {
  const steers = (
    await ctx.db
      .query("taskInputs")
      .withIndex("by_task_and_delivered", (q) => q.eq("taskId", task._id))
      .take(200)
  )
    .filter((input) => input.kind === "steer")
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-MAX_STEERS)
    .map((input) => input.text.slice(0, INSTRUCTION_MAX));
  const earlier = (
    await ctx.db
      .query("approvals")
      .withIndex("by_task", (q) => q.eq("taskId", task._id))
      .take(200)
  )
    .filter((row) => row.kind === "run_command" && row.status === "approved")
    .sort((a, b) => (a.resolvedAt ?? a._creationTime) - (b.resolvedAt ?? b._creationTime))
    .slice(-MAX_FACT_COMMANDS)
    .map((row) => `Ran earlier in this task: ${String((row.payload as { command?: unknown } | undefined)?.command ?? row.summary)}`);
  return {
    environment: { workspaceRoot: args.workspaceRoot ?? project.workspacePath ?? null, permissionMode: mode },
    instructions: [task.command.slice(0, INSTRUCTION_MAX), ...steers].filter((text) => text.trim().length > 0),
    facts: [`Task title: ${task.title.slice(0, 300)}`, ...earlier],
    pending: { command: args.command, args: [...args.args], line, danger },
  };
}

/** One audit row per auto-review verdict (allow, deny, unparsable, unavailable, expired). */
async function auditReviewVerdict(
  ctx: MutationCtx,
  row: Pick<Doc<"approvals">, "taskId" | "projectId">,
  line: string,
  entry: {
    action: string;
    decision: "allowed" | "denied" | "pending";
    actor: string;
    approvalId: Id<"approvals">;
    by: string;
    mode?: string;
    risk?: string;
    reason?: string;
    turnId?: Id<"decisionTurns">;
  }
) {
  const { action, decision, actor, ...details } = entry;
  await recordAudit(ctx, {
    actor,
    tool: "auto_review",
    action,
    decision,
    target: line,
    projectId: row.projectId,
    taskId: row.taskId,
    details: Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)),
  });
}

/**
 * Worker (D7): the Reviewer's turn for one command finished. One mutation
 * parses the output strictly, writes the audit row, closes the decision
 * turn and resolves the card: allow → approved ("auto"); deny, unparsable,
 * unavailable or expired → the card stays for the user. A card the user
 * (or a chat reply) already decided is left alone.
 */
export const review = mutation({
  args: {
    workerToken: v.string(),
    turnId: v.id("decisionTurns"),
    workerId: v.string(),
    output: v.optional(v.string()),
    failure: v.optional(v.object({ kind: v.union(v.literal("unavailable"), v.literal("expired")), reason: v.string() })),
  },
  handler: async (ctx, args): Promise<{ allowed: boolean; approvalId: Id<"approvals"> | null; reason: string }> => {
    assertServiceToken(args.workerToken);
    const turn = await ctx.db.get(args.turnId);
    if (!turn || turn.purpose !== "auto_review" || !turn.approvalId) return { allowed: false, approvalId: null, reason: "Not an auto-review turn" };
    const approval = await ctx.db.get(turn.approvalId);
    if (!approval) return { allowed: false, approvalId: null, reason: "Approval not found" };
    const line = String((approval.payload as { command?: unknown } | undefined)?.command ?? approval.summary);
    const now = Date.now();
    const closeTurn = (status: "answered" | "escalated" | "expired", extra: { answer?: string; chosenOption?: string; rationale?: string } = {}) =>
      ctx.db.patch(turn._id, { status, decidedAt: now, claimedBy: undefined, claimedUntil: undefined, ...extra });
    if (approval.status !== "pending" || turn.status !== "open") {
      if (turn.status === "open") await closeTurn("expired", { rationale: `The card was ${approval.status} before the review finished` });
      return { allowed: false, approvalId: approval._id, reason: `Already ${approval.status}` };
    }
    if (!(await holdsTaskLease(ctx, turn.taskId, args.workerId))) throw new Error(LEASE_LOST);
    const agent = turn.agentId ? await ctx.db.get(turn.agentId) : null;
    const actor = agent?.name ? `reviewer:${agent.name}` : "reviewer";
    const failure = turn.expiresAt <= now ? { kind: "expired" as const, reason: "The review ran past its deadline" } : args.failure;
    const mode = normalizePermissionMode((await ctx.db.get(turn.taskId))?.permissionMode);
    const audit = { approvalId: approval._id, turnId: turn._id, mode, by: "reviewer" };
    const handOver = async (note: string, review: Record<string, unknown>) => {
      await ctx.db.patch(approval._id, {
        payload: { ...(approval.payload as Record<string, unknown>), review: { ...review, turnId: turn._id } },
        history: [...(approval.history ?? []), { at: now, status: "pending", by: "auto_review", reason: note }],
      });
      await announceCard(ctx, approval, approval._id);
      return { allowed: false, approvalId: approval._id, reason: note };
    };
    if (failure) {
      const reason = failure.reason.slice(0, 500);
      await closeTurn("expired", { rationale: reason });
      await auditReviewVerdict(ctx, approval, line, { action: `auto_review.${failure.kind}`, decision: "pending", actor, ...audit, reason });
      return await handOver(`The Reviewer could not decide: ${reason}`.slice(0, 500), { state: failure.kind, reason });
    }
    const parsed = parseAutoReviewOutput(args.output ?? "");
    if (!parsed.ok) {
      await closeTurn("escalated", { rationale: parsed.error });
      await auditReviewVerdict(ctx, approval, line, { action: "auto_review.unparsable", decision: "pending", actor, ...audit, reason: parsed.error });
      return await handOver(parsed.error, { state: "unparsable", reason: parsed.error });
    }
    const verdict = parsed.verdict;
    const label = describeReviewVerdict(verdict);
    if (verdict.decision === "deny") {
      await closeTurn("escalated", { answer: JSON.stringify(verdict), rationale: label });
      await auditReviewVerdict(ctx, approval, line, { action: "auto_review.deny", decision: "denied", actor, ...audit, risk: verdict.risk, reason: verdict.reason });
      return await handOver(`Reviewer: ${label}`.slice(0, 500), {
        state: "done",
        by: "reviewer",
        risk: verdict.risk,
        decision: "deny",
        ...(verdict.reason ? { reason: verdict.reason } : {}),
      });
    }
    await closeTurn("answered", { answer: JSON.stringify(verdict), chosenOption: "allow", rationale: label });
    await ctx.db.patch(approval._id, {
      status: "approved",
      resolvedAt: now,
      decidedBy: "auto",
      decision: "allow",
      payload: {
        ...(approval.payload as Record<string, unknown>),
        review: { state: "done", by: "reviewer", risk: verdict.risk, decision: "allow", turnId: turn._id },
      },
      history: [...(approval.history ?? []), { at: now, status: "approved", by: "auto_review", mode, reason: `Reviewer: ${label}` }],
    });
    await auditReviewVerdict(ctx, approval, line, { action: "auto_review.allow", decision: "allowed", actor, ...audit, risk: verdict.risk });
    await appendTaskEvent(ctx, {
      taskId: approval.taskId,
      projectId: approval.projectId,
      type: "approval.auto_approved",
      payload: { kind: approval.kind, summary: approval.summary, subtaskKey: approval.subtaskKey, mode, reason: `Reviewer: ${label}`, risk: verdict.risk },
      subtaskKey: approval.subtaskKey,
      level: "info",
    });
    return { allowed: true, approvalId: approval._id, reason: `Reviewer: ${label}` };
  },
});

async function reusableAllow(
  ctx: MutationCtx,
  taskId: Id<"tasks">,
  subtaskKey: string | undefined,
  line: string
): Promise<Doc<"taskSignals"> | null> {
  const open = await ctx.db
    .query("taskSignals")
    .withIndex("by_task_and_consumed", (q) => q.eq("taskId", taskId).eq("consumedAt", undefined))
    .take(50);
  return (
    open.find(
      (signal) =>
        signal.name === "command" &&
        signal.decision === "approved" &&
        signal.command === line &&
        (signal.subtaskKey ?? null) === (subtaskKey ?? null)
    ) ?? null
  );
}

/**
 * Worker: the in-process waiter saw the decision. Consumes its signal so a
 * later replay of the subtask asks again (an allow is one-time). Idempotent.
 */
export const ack = internalMutation({
  args: { approvalId: v.id("approvals"), workerId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const signals = await ctx.db
      .query("taskSignals")
      .withIndex("by_approval", (q) => q.eq("approvalId", args.approvalId))
      .take(5);
    let consumed = 0;
    for (const signal of signals) {
      if (signal.consumedAt !== undefined) continue;
      await ctx.db.patch(signal._id, { consumedAt: Date.now(), consumedBy: args.workerId ?? "worker" });
      consumed += 1;
    }
    return { consumed };
  },
});

/** Worker poll: the row's state plus the task status (pause / stop). */
export const get = internalQuery({
  args: { approvalId: v.id("approvals") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.approvalId);
    if (!row) return null;
    const task = await ctx.db.get(row.taskId);
    return {
      status: row.status,
      decision: row.decision ?? null,
      note: row.note ?? null,
      taskStatus: task?.status ?? null,
    };
  },
});

/** Worker: close a wait it gave up on (pause, stop, timeout). Idempotent. */
export const cancel = internalMutation({
  args: { approvalId: v.id("approvals"), reason: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.approvalId);
    if (!row || row.status !== "pending") return { applied: false };
    const now = Date.now();
    await ctx.db.patch(args.approvalId, {
      status: "cancelled",
      resolvedAt: now,
      note: args.reason.slice(0, 500),
      history: [...(row.history ?? []), { at: now, status: "cancelled", reason: args.reason }],
    });
    await appendTaskEvent(ctx, {
      taskId: row.taskId,
      projectId: row.projectId,
      type: "approval.cancelled",
      payload: { kind: row.kind, summary: row.summary, reason: args.reason },
      subtaskKey: row.subtaskKey,
      level: "info",
    });
    return { applied: true };
  },
});

/**
 * Resolve one approval with a decision. Shared by `respond`, the legacy
 * approve/reject mutations (run_command rows) and the chat-reply decline.
 */
export async function resolveCommandApproval(
  ctx: MutationCtx,
  approval: Doc<"approvals">,
  requested: CommandDecision,
  options: { note?: string; actor?: string } = {}
): Promise<CommandDecision> {
  if (approval.status !== "pending") throw new Error(`Approval already ${approval.status}`);
  const decision = effectiveCommandDecision(requested, approval.offerAlways);
  const now = Date.now();
  const note = options.note?.trim().slice(0, 1000) || undefined;
  await ctx.db.patch(approval._id, {
    status: decision === "deny" ? "rejected" : "approved",
    resolvedAt: now,
    decidedBy: "user",
    decision,
    ...(note ? { note } : {}),
    history: [...(approval.history ?? []), { at: now, status: decision === "deny" ? "rejected" : "approved", decision, by: options.actor ?? "user" }],
  });
  // Durable signal in the same mutation: the live waiter reads the row; a
  // replayed subtask (its worker died mid-wait) reuses an unconsumed allow.
  await signalApprovalDecision(ctx, approval, decision === "deny" ? "rejected" : "approved");
  const command = String((approval.payload as { command?: unknown } | undefined)?.command ?? approval.summary);
  if (decision === "always") {
    const head = String((approval.payload as { head?: unknown } | undefined)?.head ?? "");
    const prefix = normalizeRulePrefix(head);
    if (prefix) {
      const project = await ctx.db.get(approval.projectId);
      const createdBy = options.actor ?? (await getViewerId(ctx)) ?? "user";
      await ctx.db.patch(approval.projectId, {
        commandAllowRules: addCommandAllowRule(project?.commandAllowRules, prefix, createdBy, now),
      });
      await recordAudit(ctx, {
        tool: "run_command",
        action: "command_rule.add",
        decision: "allowed",
        target: prefix,
        projectId: approval.projectId,
        taskId: approval.taskId,
        details: { approvalId: approval._id, command },
      });
    }
  }
  if (decision === "always_exact") {
    // Plan 041: the literal argv the worker asked for (approval.arguments).
    const argv = approval.arguments as { command?: unknown; args?: unknown } | undefined;
    const exactCommand = typeof argv?.command === "string" ? argv.command : "";
    const exactArgs = Array.isArray(argv?.args) && argv!.args.every((a) => typeof a === "string") ? (argv!.args as string[]) : null;
    if (exactCommand && exactArgs) {
      const project = await ctx.db.get(approval.projectId);
      const createdBy = options.actor ?? (await getViewerId(ctx)) ?? "user";
      await ctx.db.patch(approval.projectId, {
        commandAllowExact: addCommandAllowExact(project?.commandAllowExact, exactCommand, exactArgs, createdBy, now),
      });
      await recordAudit(ctx, {
        tool: "run_command",
        action: "command_exact.add",
        decision: "allowed",
        target: command,
        projectId: approval.projectId,
        taskId: approval.taskId,
        details: { approvalId: approval._id },
      });
    }
  }
  await appendTaskEvent(ctx, {
    taskId: approval.taskId,
    projectId: approval.projectId,
    type: decision === "deny" ? "approval.rejected" : "approval.approved",
    payload: { kind: approval.kind, summary: approval.summary, decision, ...(note ? { note } : {}) },
    subtaskKey: approval.subtaskKey,
    level: decision === "deny" ? "warn" : "info",
  });
  await recordAudit(ctx, {
    tool: "approval",
    action: decision === "deny" ? "approval.reject" : "approval.approve",
    decision: decision === "deny" ? "denied" : "allowed",
    target: approval.summary,
    projectId: approval.projectId,
    taskId: approval.taskId,
    details: {
      kind: approval.kind,
      decision,
      ...(requested !== decision ? { requested } : {}),
      ...(approval.toolName ? { toolName: approval.toolName } : {}),
    },
  });
  return decision;
}

/**
 * The user's Allow / Always allow / Deny. "always" is downgraded to "allow"
 * when the card did not offer it (server-side; the client cannot force it).
 * For non-command approvals allow/deny map to approve/reject semantics via
 * the existing mutations, so this is run_command only.
 */
export const respond = mutation({
  args: {
    approvalId: v.id("approvals"),
    decision: decisionValidator,
    note: v.optional(v.string()),
    // O6: bind the decision to what was shown (lib/approvalFingerprint.ts).
    fingerprint: v.optional(v.string()),
    shownAt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ decision: CommandDecision }> => {
    const approval = await ctx.db.get(args.approvalId);
    if (!approval) throw new Error("Approval not found");
    await assertProjectAccess(ctx, approval.projectId);
    if (!isCommandApprovalKind(approval.kind)) throw new Error("Only command approvals take Allow / Always allow / Deny");
    // git_push / merge_pr never reach this point (other kinds); a push-like
    // run_command was never offered "always", so always_exact is downgraded.
    const shown = await checkShown(approval, args);
    if (!shown.ok) throw new Error(shown.reason);
    const decision = await resolveCommandApproval(ctx, approval, args.decision, { note: args.note });
    return { decision };
  },
});

/**
 * A message typed while a command waits declines it (Deny, note "user
 * replied instead: …"), so the agent continues with the user's words
 * instead of blocking. Scoped to one task thread, or to the chat's
 * conversation (tasks dispatched from it, or with no conversation).
 */
export async function declineWaitingCommands(
  ctx: MutationCtx,
  scope: { projectId: Id<"projects">; conversationId?: Id<"conversations">; taskId?: Id<"tasks">; text?: string }
): Promise<number> {
  const pending = await ctx.db
    .query("approvals")
    .withIndex("by_project_and_status", (q) => q.eq("projectId", scope.projectId).eq("status", "pending"))
    .take(50);
  const snippet = (scope.text ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const note = snippet ? `${USER_REPLIED_NOTE}: ${snippet}` : USER_REPLIED_NOTE;
  let declined = 0;
  for (const approval of pending) {
    if (!isCommandApprovalKind(approval.kind) || (approval.payload as { inline?: unknown } | undefined)?.inline !== true) continue;
    if (scope.taskId) {
      if (approval.taskId !== scope.taskId) continue;
    } else {
      const task = await ctx.db.get(approval.taskId);
      if (task?.conversationId && scope.conversationId && task.conversationId !== scope.conversationId) continue;
    }
    await resolveCommandApproval(ctx, approval, "deny", { note, actor: "chat-reply" });
    declined += 1;
  }
  return declined;
}

export const declineWaiting = internalMutation({
  args: {
    projectId: v.id("projects"),
    conversationId: v.optional(v.id("conversations")),
    taskId: v.optional(v.id("tasks")),
    text: v.optional(v.string()),
  },
  handler: async (ctx, args) => ({ declined: await declineWaitingCommands(ctx, args) }),
});

/** Manage project: remove one "Always allow" rule (audited). */
export const removeRule = mutation({
  args: { projectId: v.id("projects"), prefix: v.string() },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Project not found");
    const head = normalizeRulePrefix(args.prefix);
    const rules = project.commandAllowRules ?? [];
    const next = rules.filter((rule) => normalizeRulePrefix(rule.prefix) !== head);
    if (next.length === rules.length) return { removed: false };
    await ctx.db.patch(args.projectId, { commandAllowRules: next });
    await recordAudit(ctx, {
      tool: "run_command",
      action: "command_rule.remove",
      decision: "recorded",
      target: head,
      projectId: args.projectId,
    });
    return { removed: true };
  },
});

/** Manage project: remove one "always allow this exact command" entry (audited). Plan 041. */
export const removeExactRule = mutation({
  args: { projectId: v.id("projects"), command: v.string(), args: v.array(v.string()) },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Project not found");
    const entries = project.commandAllowExact ?? [];
    const next = removeCommandAllowExact(entries, args.command, args.args);
    if (next.length === entries.length) return { removed: false };
    await ctx.db.patch(args.projectId, { commandAllowExact: next });
    await recordAudit(ctx, {
      tool: "run_command",
      action: "command_exact.remove",
      decision: "recorded",
      target: formatCommand(args.command, args.args),
      projectId: args.projectId,
    });
    return { removed: true };
  },
});
