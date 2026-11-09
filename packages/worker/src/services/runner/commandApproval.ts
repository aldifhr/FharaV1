/**
 * In-process wait for a run_command approval (chat UX, Feature 2).
 *
 * The approval path for file changes (`requestApproval`) parks the task in
 * needs_approval and releases its lease; doing that per command would stall
 * or re-run the DAG. Here the worker keeps its lease and heartbeat, asks
 * the backend (which decides auto vs ask from the task's permission mode
 * and the project's "Always allow" rules), and polls the row until the user
 * decides. Pause, stop (the task/node abort signal) and a wait timeout all
 * cancel the row and end the wait with a denial the agent can act on.
 *
 * The exact-argv allowlist stays a hard deny BEFORE this runs (callers check
 * `isCommandAllowed` first); nothing here widens it.
 */
import type { WorkerApi } from "@/workerApi";
import type { CommandApprovalOutcome } from "@/execution/commandGate";

export { commandDeniedOutput, type CommandApprovalOutcome } from "@/execution/commandGate";

export type CommandApprovalApi = Pick<WorkerApi, "requestCommandApproval" | "getCommandApproval" | "cancelCommandApproval">;

export interface CommandApprovalRequest {
  taskId: string;
  projectId: string;
  subtaskKey?: string;
  executionId?: string;
  requestedByAgentId?: string;
  command: string;
  args: string[];
  workspaceRoot?: string;
}

export interface CommandApprovalWaitOptions {
  signal?: AbortSignal;
  /** Called while waiting so idle/stall watchdogs see the wait as alive. */
  onWaiting?: () => void;
  /** First tick only: the row is pending (show "waiting for approval"). */
  onPending?: (approvalId: string) => void;
  pollMs?: number;
  timeoutMs?: number;
  /** Test seams. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Default wait before a pending command counts as declined (10 min). */
export const COMMAND_APPROVAL_TIMEOUT_MS = (() => {
  const raw = Number(process.env.ORCHESTRATOR_COMMAND_APPROVAL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 10_000 ? raw : 10 * 60_000;
})();
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
    });
  } catch (error) {
    // Fail closed: no recorded approval, no command.
    return { allowed: false, via: "error", reason: error instanceof Error ? error.message : String(error) };
  }
  if (started.status === "auto") return { allowed: true, via: "auto", reason: started.reason };

  const approvalId = started.approvalId;
  options.onPending?.(approvalId);
  const deadline = now() + timeoutMs;
  const giveUp = async (via: CommandApprovalOutcome["via"], reason: string): Promise<CommandApprovalOutcome> => {
    await api.cancelCommandApproval({ approvalId, reason }).catch(() => undefined);
    return { allowed: false, via, reason };
  };

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
        const via = row.decision === "always" ? "always" : "allow";
        return { allowed: true, via, reason: via === "always" ? "Always allowed by the user" : "Allowed by the user", ...(row.note ? { note: row.note } : {}) };
      }
      if (row.status === "rejected") {
        return { allowed: false, via: "deny", reason: "Denied by the user", ...(row.note ? { note: row.note } : {}) };
      }
      if (row.status === "cancelled") {
        return { allowed: false, via: "cancelled", reason: row.note ?? "Approval was cancelled" };
      }
      if (row.taskStatus === "paused") return giveUp("paused", "Task paused while the command waited for approval");
      if (row.taskStatus && ["done", "failed", "rejected"].includes(row.taskStatus)) {
        return giveUp("cancelled", `Task is ${row.taskStatus}`);
      }
    }
    options.onWaiting?.();
    await sleep(pollMs, options.signal);
  }
}
