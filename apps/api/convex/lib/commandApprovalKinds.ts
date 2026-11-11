/**
 * In-process command approval kinds (chat UX + D6 command sandbox).
 *
 * `run_command` asks before an agent command runs. `run_unconfined` asks
 * before a command the bwrap sandbox refused (a write outside the
 * workspace, or no usable bwrap on the worker) runs again without it: it
 * always asks, in every permission mode, never offers "Always allow" and
 * never reuses an earlier run_command allow.
 */
import { v } from "convex/values";

export type CommandApprovalKind = "run_command" | "run_unconfined";

export function isCommandApprovalKind(kind: string | null | undefined): kind is CommandApprovalKind {
  return kind === "run_command" || kind === "run_unconfined";
}

/** Worker → backend args of one command approval request (worker.ts action and commandApprovals.request). */
export const commandRequestArgs = {
  taskId: v.id("tasks"),
  projectId: v.id("projects"),
  subtaskKey: v.optional(v.string()),
  executionId: v.optional(v.id("executions")),
  requestedByAgentId: v.optional(v.id("agents")),
  command: v.string(),
  args: v.array(v.string()),
  workspaceRoot: v.optional(v.string()),
  workerId: v.optional(v.string()),
  kind: v.optional(v.literal("run_unconfined")),
};

/** Card copy for a run_unconfined approval. */
export const UNCONFINED_WARNING = "Runs again without the command sandbox: it can write anywhere this worker's user can";
