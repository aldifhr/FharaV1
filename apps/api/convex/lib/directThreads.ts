/**
 * Direct threads (threadbear T2): shared helpers for `directThreads.ts`,
 * the lease recovery in `orchestration.recoverStale`, and tests.
 *
 * A direct thread is a `tasks` row with `mode: "direct"`: one agent loop
 * (an OpenCode ACP session in the worker, or the API loop as a fallback),
 * run as one of the nine fixed roles. It never goes through the planner.
 *
 * Status lifecycle of the task row:
 *   queued        a message waits and no worker holds the thread
 *   running       a worker holds it (a turn is live, or the session is idle
 *                 but not yet released); the worker heartbeat renews the lease
 *   waiting_input released after DIRECT_IDLE_MIN, or recovered after a worker
 *                 died; the next message re-queues it
 *   cancelled     archived / stopped by the user (terminal)
 *
 * Approvals for a direct thread are in-process (the worker keeps its lease
 * and polls the row), like run_command cards. They never go through
 * `orchestration.requestApproval`, which drops the lease and re-queues.
 */
import { v } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { appendTaskEvent } from "./taskEvents";
import { commandHead, dangerousCommandReason } from "./commandRules";
import type { PermissionMode } from "./permissionModes";
import { buildContinuationText, decideContinuation } from "./restartContinuation";
import { directContinuationTimes, loadDirectTurnSteps } from "./restartSteps";
import { patchTask } from "./threadIndex";

/** Tool output above this many bytes is stored in eventBodies, read lazily. */
export const EVENT_BODY_THRESHOLD = 2 * 1024;
/** Characters of a large tool output kept inline on the taskEvents row. */
export const EVENT_BODY_PREVIEW = 300;
/** Largest body stored (Convex documents are capped at 1 MiB). */
export const EVENT_BODY_MAX = 512 * 1024;
/** Longest stream row text kept (the tail of a long reply). */
export const STREAM_TEXT_MAX = 64 * 1024;

/** Persisted event types of a direct thread (threadbear protocol names). */
export const DIRECT_EVENT_TYPES = [
  "user.message",
  "assistant.text",
  "reasoning",
  "tool.call",
  "tool.result",
  "edit.diff",
  "approval.requested",
  "approval.resolved",
  "turn.started",
  "turn.steered",
  "turn.completed",
  "system.note",
  "plan.updated",
  // Nuphos N4: one per session start (op, pid, phases, outcome; no content).
  "session.restore",
] as const;
export type DirectEventType = (typeof DIRECT_EVENT_TYPES)[number];

export function isDirectEventType(type: string): type is DirectEventType {
  return (DIRECT_EVENT_TYPES as readonly string[]).includes(type);
}

export function isDirectTask(task: Pick<Doc<"tasks">, "mode"> | null | undefined): boolean {
  return task?.mode === "direct";
}

/** A pending approval row written for a direct thread's tool call. */
export function isDirectCard(row: Doc<"approvals">): boolean {
  return (row.payload as { direct?: unknown } | undefined)?.direct === true;
}

/**
 * Why a direct card was closed without an answer (Nuphos N5). Every close
 * writes `approval.resolved {decision: "cancelled", reason, message}`, so
 * an empty turn is always attributable. The worker names the first four
 * (packages/worker/src/direct/toolGate.ts CANCEL_REASONS, same list):
 *   interrupt     Stop, or the turn watchdog stopping the turn
 *   gate_error    the request couldn't be shaped or recorded
 *   no_option     the agent offered no plain allow/reject for the answer
 *   expired       nobody answered within DIRECT_APPROVAL_MAX_MIN; the agent
 *                 is told no and the turn goes on
 *   closed        the thread was closed (archived)
 *   session_ended the worker released the session
 *   worker_lost   the worker died while the card waited (lease recovery)
 */
export const DIRECT_CANCEL_REASONS = ["interrupt", "gate_error", "no_option", "expired", "closed", "session_ended", "worker_lost"] as const;
export type DirectCancelReason = (typeof DIRECT_CANCEL_REASONS)[number];
export const directCancelReasonValidator = v.union(
  v.literal("interrupt"),
  v.literal("gate_error"),
  v.literal("no_option"),
  v.literal("expired"),
  v.literal("closed"),
  v.literal("session_ended"),
  v.literal("worker_lost")
);

export function isDirectCancelReason(value: unknown): value is DirectCancelReason {
  return typeof value === "string" && (DIRECT_CANCEL_REASONS as readonly string[]).includes(value);
}

/** What the worker polls for one card (directThreads.approvalState). */
export type DirectApprovalState = {
  status: string;
  decision: string | null;
  note: string | null;
  taskStatus: string | null;
  /** Why the card was closed, when it was closed without an answer. */
  reason: DirectCancelReason | null;
};

/** The reason a closed card carries (its last history entry), if any. */
export function directCancelReasonOf(row: Pick<Doc<"approvals">, "history">): DirectCancelReason | null {
  const last = (row.history ?? [])[(row.history ?? []).length - 1] as { code?: unknown } | undefined;
  return isDirectCancelReason(last?.code) ? last.code : null;
}

/** Close one pending direct card with a reason (idempotent: false when it wasn't pending). */
export async function cancelDirectCard(
  ctx: MutationCtx,
  row: Doc<"approvals">,
  code: DirectCancelReason,
  message: string,
  now = Date.now()
): Promise<boolean> {
  if (row.status !== "pending" || !isDirectCard(row)) return false;
  const text = message.slice(0, 500);
  await ctx.db.patch(row._id, {
    status: "cancelled",
    resolvedAt: now,
    note: text,
    history: [...(row.history ?? []), { at: now, status: "cancelled", reason: text, code }],
  });
  await appendTaskEvent(ctx, {
    taskId: row.taskId,
    projectId: row.projectId,
    type: "approval.resolved",
    payload: { approvalId: row._id, itemId: (row.payload as { itemId?: string } | undefined)?.itemId, decision: "cancelled", reason: code, message: text },
    level: code === "expired" || code === "gate_error" || code === "no_option" ? "warn" : "info",
  });
  return true;
}

/**
 * Close every pending card of a direct thread (Stop, worker death,
 * archive, release) with the reason. The waiting worker answers the agent
 * `cancelled`.
 */
export async function expireDirectCards(ctx: MutationCtx, taskId: Id<"tasks">, code: DirectCancelReason, message: string): Promise<number> {
  const rows = await ctx.db
    .query("approvals")
    .withIndex("by_task", (q) => q.eq("taskId", taskId))
    .order("desc")
    .take(200);
  const now = Date.now();
  let closed = 0;
  for (const row of rows) if (await cancelDirectCard(ctx, row, code, message, now)) closed += 1;
  return closed;
}

/** User messages after `afterSeq`, oldest first (bounded). */
export async function userMessagesAfter(
  ctx: Pick<QueryCtx, "db">,
  taskId: Id<"tasks">,
  afterSeq: number,
  limit = 50
): Promise<Doc<"taskEvents">[]> {
  const rows = await ctx.db
    .query("taskEvents")
    .withIndex("by_task_and_sequence", (q) => q.eq("taskId", taskId).gt("sequence", afterSeq))
    .take(500);
  return rows.filter((row) => row.type === "user.message").slice(0, limit);
}

/**
 * Lease recovery for a direct thread whose worker died (threadbear
 * runner.recover, ported). The open turn gets `turn.completed
 * {outcome: "interrupted"}` unless the log already has it; open cards
 * expire; queued messages that were cut off are listed in a note rather
 * than silently re-sent. The thread then waits for the user.
 */
export async function recoverDirectThread(ctx: MutationCtx, task: Doc<"tasks">, now: number): Promise<void> {
  const direct = task.direct;
  await expireDirectCards(ctx, task._id, "worker_lost", "The worker stopped while this waited for an answer.");
  const turnId = direct?.turnId;
  let closedTurn = false;
  if (turnId) {
    const done = await ctx.db
      .query("taskEvents")
      .withIndex("by_task_and_event_key", (q) => q.eq("taskId", task._id).eq("eventKey", `turn.completed:${turnId}`))
      .first();
    if (!done) {
      await appendTaskEvent(ctx, {
        taskId: task._id,
        projectId: task.projectId,
        type: "turn.completed",
        eventKey: `turn.completed:${turnId}`,
        payload: { turnId, outcome: "interrupted", durationMs: 0, error: "The worker stopped during this turn." },
        level: "warn",
      });
      closedTurn = true;
    }
  }
  const queued = await userMessagesAfter(ctx, task._id, direct?.deliveredSeq ?? 0);
  if (queued.length > 0) {
    const list = queued
      .map((row) => `- ${String((row.payload as { text?: unknown } | undefined)?.text ?? "").replace(/\s+/g, " ").slice(0, 120)}`)
      .join("\n");
    await appendTaskEvent(ctx, {
      taskId: task._id,
      projectId: task.projectId,
      type: "system.note",
      payload: { text: `The worker stopped before these messages were sent to the agent. Send them again to continue:\n${list}` },
      level: "warn",
    });
  }
  // The cut-off messages are accounted for (the note), so they are not
  // delivered by the next claim either.
  const lastQueued = queued.length > 0 ? queued[queued.length - 1].sequence ?? 0 : 0;
  // G4: the cut-off turn is continued (its recorded steps + CONTINUE_PROMPT
  // as the next message) unless the loop guard refuses; then it waits.
  const continued = closedTurn && turnId ? await continueCutOffTurn(ctx, task, turnId, now) : false;
  await patchTask(ctx, task._id, {
    status: continued ? "queued" : "waiting_input",
    workerId: undefined,
    leaseExpiresAt: undefined,
    updatedAt: now,
    ...(direct
      ? {
          direct: {
            ...direct,
            status: "stopped" as const,
            turnId: undefined,
            idleSince: now,
            stoppedMidTurn: closedTurn || direct.stoppedMidTurn,
            deliveredSeq: Math.max(direct.deliveredSeq ?? 0, lastQueued),
          },
        }
      : {}),
  });
  await appendTaskEvent(ctx, {
    taskId: task._id,
    projectId: task.projectId,
    type: "task.recovered",
    payload: { action: continued ? "direct_continued" : "direct_stopped", reason: "stale_lease", workerId: task.workerId ?? null, closedTurn },
    level: "warn",
    createdAt: now,
  });
}

/**
 * G4 recover-and-continue for a direct thread: queue one continuation
 * message (CONTINUE_PROMPT plus the turn's recorded steps), or record why
 * the loop guard refused it. Returns whether the thread was re-queued.
 */
async function continueCutOffTurn(ctx: MutationCtx, task: Doc<"tasks">, turnId: string, now: number): Promise<boolean> {
  const decision = decideContinuation(await directContinuationTimes(ctx, task._id), now);
  if (!decision.allowed) {
    await appendTaskEvent(ctx, {
      taskId: task._id,
      projectId: task.projectId,
      type: "system.note",
      payload: { text: `${decision.reason} Send a message to continue.`, continuation: "refused" },
      level: "warn",
    });
    return false;
  }
  const steps = await loadDirectTurnSteps(ctx, task._id, turnId);
  await appendTaskEvent(ctx, {
    taskId: task._id,
    projectId: task.projectId,
    type: "user.message",
    eventKey: `user.message:continuation:${turnId}`,
    payload: { text: buildContinuationText(steps), clientId: `continuation:${turnId}`, origin: "continuation", attempt: decision.attempt },
    level: "info",
    createdAt: now,
  });
  return true;
}

// ── Approval policy ────────────────────────────────────────────────────

/** What the worker reports about one ACP permission request. */
export interface DirectToolRequest {
  /** ACP tool kind (execute, edit, delete, move, fetch, other …). */
  acpKind: string;
  title: string;
  /** Shell command words when the command is a plain argv; null when it needs a shell. */
  argv?: string[] | null;
  command?: string;
  /** The file paths the call names (absolute). */
  paths?: string[];
  /** Whether a named file runs as code (hooks, CI, OpenCode config) or might. */
  codeWrite?: boolean | "unsure";
  /** Thread rule key that would cover this call ("Always allow"), if any. */
  ruleKey?: string;
  /** The real folder the call runs in. */
  cwd?: string;
  /** The worktree the thread runs in: an edit outside it never auto-allows. */
  workspaceRoot?: string;
}

export interface DirectApprovalPolicy {
  action: "auto" | "ask";
  kind: "run_command" | "tool_call";
  reason: string;
  offerAlways: boolean;
}

const EDIT_KINDS = new Set(["edit", "delete", "move"]);

function insideRoot(file: string, root: string | undefined): boolean {
  if (!root) return false;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const r = norm(root);
  const f = norm(file);
  return f === r || f.startsWith(`${r}/`);
}

/**
 * The policy for one direct-thread tool call under the task's permission
 * mode, read when the call is asked (not when the turn began).
 *
 * - Push-like or otherwise dangerous commands (lib/commandRules) and
 *   commands that need a shell always ask, in every mode, with no Always.
 * - A write to a file that runs as code always asks, with no Always.
 * - A thread rule (tasks.direct.allowRules) approves its exact call.
 * - full_access approves the rest; auto_edits approves edits inside the
 *   worktree; supervised asks.
 *
 * Every "auto" outcome is still recorded as an approved row with
 * `decidedBy: "auto"` (rule 5).
 */
export function directApprovalPolicy(input: {
  mode: PermissionMode;
  request: DirectToolRequest;
  allowRules?: readonly string[];
}): DirectApprovalPolicy {
  const { request } = input;
  const isCommand = request.acpKind === "execute";
  const kind = isCommand ? "run_command" : "tool_call";
  if (isCommand) {
    const argv = request.argv ?? null;
    if (!argv || argv.length === 0) {
      return { action: "ask", kind, reason: "Needs a shell to run, so it always asks", offerAlways: false };
    }
    const danger = dangerousCommandReason(argv[0], argv.slice(1), request.workspaceRoot);
    if (danger) return { action: "ask", kind, reason: danger, offerAlways: false };
    if (request.ruleKey && input.allowRules?.includes(request.ruleKey)) {
      return { action: "auto", kind, reason: "Always allowed in this thread", offerAlways: false };
    }
    if (input.mode === "full_access") return { action: "auto", kind, reason: "Full access", offerAlways: false };
    return {
      action: "ask",
      kind,
      reason: input.mode === "auto_edits" ? "Auto-accept edits still asks for commands" : "Supervised mode asks for every command",
      offerAlways: false,
    };
  }
  if (request.codeWrite) {
    return {
      action: "ask",
      kind,
      reason: request.codeWrite === "unsure" ? "Fhara can't tell whether this file runs as code" : "Fhara runs this file as code",
      offerAlways: false,
    };
  }
  if (request.ruleKey && input.allowRules?.includes(request.ruleKey)) {
    return { action: "auto", kind, reason: "Always allowed in this thread", offerAlways: false };
  }
  if (input.mode === "full_access") return { action: "auto", kind, reason: "Full access", offerAlways: false };
  const paths = request.paths ?? [];
  if (
    input.mode === "auto_edits" &&
    EDIT_KINDS.has(request.acpKind) &&
    paths.length > 0 &&
    paths.every((p) => insideRoot(p, request.workspaceRoot))
  ) {
    return { action: "auto", kind, reason: "Auto-accept edits", offerAlways: false };
  }
  return { action: "ask", kind, reason: "Asks before this tool runs", offerAlways: false };
}

/** The command head shown on a card ("npm run test"), when argv is plain. */
export function directCommandHead(argv: readonly string[] | null | undefined): string {
  if (!argv || argv.length === 0) return "";
  return commandHead(argv[0], argv.slice(1));
}
