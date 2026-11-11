/**
 * In-process wait for a run_command approval (chat UX, Feature 2).
 *
 * The approval path for file changes (`requestApproval`) parks the task in
 * needs_approval and releases its lease; doing that per command would stall
 * or re-run the DAG. Here the worker keeps its lease and heartbeat, asks
 * the backend (which decides auto vs ask from the task's permission mode
 * and the project's "Always allow" rules), and polls the row until the user
 * decides. Stop (the task/node abort signal) and the approval timeout
 * cancel the row and end the wait with a denial the agent can act on.
 *
 * A user PAUSE does not end the wait: pause only stops new dispatch, the
 * waiting subtask is a running node that finishes on the user's decision
 * (the backend records the pause; the draining worker keeps its lease).
 * While waiting, the node's subtask-timeout and stall clocks are held
 * (`holdClock`), so a human wait can never fail the shell subtask. The
 * decision itself is a durable signal (apps/api/convex/taskSignals.ts); the
 * waiter acks it so the one-time allow is not reused by a later replay.
 *
 * The exact-argv allowlist stays a hard deny BEFORE this runs (callers check
 * `isCommandAllowed` first); nothing here widens it.
 */
import { wenv } from "@fhara/config/worker";
import type { WorkerApi } from "@/workerApi";
import type { CommandApprovalOutcome } from "@/execution/commandGate";
import type { AutoReviewRequest } from "@/api/convex/lib/autoReview";

export { commandDeniedOutput, type CommandApprovalOutcome } from "@/execution/commandGate";

export type CommandApprovalApi = Pick<WorkerApi, "requestCommandApproval" | "getCommandApproval" | "cancelCommandApproval"> &
  Partial<Pick<WorkerApi, "ackCommandApproval">>;

export interface CommandApprovalRequest {
  taskId: string;
  projectId: string;
  subtaskKey?: string;
  executionId?: string;
  requestedByAgentId?: string;
  command: string;
  args: string[];
  workspaceRoot?: string;
  /** D6: a rerun without the bwrap sandbox after it refused the command (always asks). */
  kind?: "run_unconfined";
}

/**
 * D7: run the Reviewer's turn for a command the backend sent to review and
 * report it (decisionTurn/autoReview.ts). `allowed` means the backend
 * approved the row; anything else leaves the card for the user.
 */
export type CommandReviewFn = (
  review: { turnId: string; expiresAt: number; request: AutoReviewRequest },
  signal?: AbortSignal
) => Promise<{ allowed: boolean; reason: string }>;

export interface CommandApprovalWaitOptions {
  signal?: AbortSignal;
  /** D7: the Reviewer's turn (Full access). Absent: a command sent to review waits on its card. */
  review?: CommandReviewFn;
  /** Called while waiting so idle/stall watchdogs see the wait as alive. */
  onWaiting?: () => void;
  /** First tick only: the row is pending (show "waiting for approval"). */
  onPending?: (approvalId: string) => void;
  /** Hold the scheduler's subtask timeout / stall clocks during the wait. */
  holdClock?: () => () => void;
  pollMs?: number;
  timeoutMs?: number;
  /** Test seams. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Default wait before a pending command counts as declined (10 min). */
export const COMMAND_APPROVAL_TIMEOUT_MS = wenv("ORCHESTRATOR_COMMAND_APPROVAL_TIMEOUT_MS"); // ≥ 10s, read at module load
const DEFAULT_POLL_MS = 1_500;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function waitForCommandApproval(
  api: CommandApprovalApi,
  request: CommandApprovalRequest,
  options: CommandApprovalWaitOptions = {}
): Promise<CommandApprovalOutcome> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = options.timeoutMs ?? COMMAND_APPROVAL_TIMEOUT_MS;

  let started: Awaited<ReturnType<CommandApprovalApi["requestCommandApproval"]>>;
  try {
    started = await api.requestCommandApproval({
      taskId: request.taskId,
      projectId: request.projectId,
      command: request.command,
      args: request.args,
      ...(request.subtaskKey ? { subtaskKey: request.subtaskKey } : {}),
      ...(request.executionId ? { executionId: request.executionId } : {}),
      ...(request.requestedByAgentId ? { requestedByAgentId: request.requestedByAgentId } : {}),
      ...(request.workspaceRoot ? { workspaceRoot: request.workspaceRoot } : {}),
      ...(request.kind ? { kind: request.kind } : {}),
    });
  } catch (error) {
    // Fail closed: no recorded approval, no command.
    return { allowed: false, via: "error", reason: error instanceof Error ? error.message : String(error) };
  }
  if (started.status === "auto") return { allowed: true, via: "auto", reason: started.reason };

  const approvalId = started.approvalId;
  const release = options.holdClock?.();
  try {
    // D7: Full access asks the Reviewer first; its allow approves the row,
    // anything else (deny, unparsable, no turn) leaves the card for the user.
    if (started.status === "review" && started.review && options.review) {
      const reviewed = await options.review(started.review, options.signal).catch((error: unknown) => ({
        allowed: false,
        reason: error instanceof Error ? error.message : String(error),
      }));
      if (reviewed.allowed) return { allowed: true, via: "auto", reason: reviewed.reason };
    }
    options.onPending?.(approvalId);
    return await pollDecision(api, approvalId, options, { now, sleep, pollMs, timeoutMs });
  } finally {
    release?.();
  }
}

async function pollDecision(
  api: CommandApprovalApi,
  approvalId: string,
  options: CommandApprovalWaitOptions,
  clock: { now: () => number; sleep: (ms: number, signal?: AbortSignal) => Promise<void>; pollMs: number; timeoutMs: number }
): Promise<CommandApprovalOutcome> {
  const { now, sleep, pollMs, timeoutMs } = clock;
  const deadline = now() + timeoutMs;
  const giveUp = async (via: CommandApprovalOutcome["via"], reason: string): Promise<CommandApprovalOutcome> => {
    await api.cancelCommandApproval({ approvalId, reason }).catch(() => undefined);
    return { allowed: false, via, reason };
  };
  const ack = () => void api.ackCommandApproval?.({ approvalId })?.catch(() => undefined);

  for (;;) {
    if (options.signal?.aborted) return giveUp("cancelled", "Task stopped while the command waited for approval");
    if (now() >= deadline) return giveUp("timeout", `No decision within ${Math.round(timeoutMs / 60_000)} min`);
    let row: Awaited<ReturnType<CommandApprovalApi["getCommandApproval"]>> = null;
    try {
      row = await api.getCommandApproval({ approvalId });
    } catch {
      row = null; // transient: try again next tick
    }
    if (row) {
      if (row.status === "approved") {
        ack();
        // Plan 041: "always_exact" is an always-allow scoped to this exact argv.
        const via = row.decision === "always" || row.decision === "always_exact" ? "always" : "allow";
        const reason =
          row.decision === "always_exact" ? "Always allowed (exact command) by the user" : via === "always" ? "Always allowed by the user" : "Allowed by the user";
        return { allowed: true, via, reason, ...(row.note ? { note: row.note } : {}) };
      }
      if (row.status === "rejected") {
        ack();
        return { allowed: false, via: "deny", reason: "Denied by the user", ...(row.note ? { note: row.note } : {}) };
      }
      if (row.status === "cancelled") {
        return { allowed: false, via: "cancelled", reason: row.note ?? "Approval was cancelled" };
      }
      // taskStatus "paused": keep waiting (see the header). Not a give-up.
      if (row.taskStatus && ["done", "failed", "rejected", "cancelled"].includes(row.taskStatus)) {
        return giveUp("cancelled", `Task is ${row.taskStatus}`);
      }
    }
    options.onWaiting?.();
    await sleep(pollMs, options.signal);
  }
}
