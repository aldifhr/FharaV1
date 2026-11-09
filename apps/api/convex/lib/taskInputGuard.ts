import type { Doc, Id } from "../_generated/dataModel";

/**
 * Single input guard for running tasks.
 *
 * Every path that injects user text into a task (steerTask, answerQuestion,
 * the chat "continue" intent that steers) goes through `admitTaskInput`. It
 * re-reads the task, its pending approvals and its open question inside the
 * caller's mutation and refuses fail-closed, so a steer can never be read as
 * the answer to a permission prompt and an answer only lands on the question
 * it was written for. Convex mutations are serializable, so the check and
 * the write that follows it cannot interleave with another writer (the role
 * the input lease plays in the reference design).
 *
 * Idea adapted from OrchestratorInc/agent-orchestrator's
 * `backend/internal/sessionguard/guard.go` (Apache-2.0): re-read before every
 * write, a typed refusal outcome, and "delivered" recorded only on an actual
 * send. No code was copied.
 */

export type TaskInputKind = "steer" | "answer";

export type TaskInputRefusal =
  | "awaiting_approval"
  | "awaiting_plan_approval"
  | "terminal"
  | "not_running"
  | "question_mismatch";

export type TaskInputAdmission = { ok: true } | { ok: false; reason: TaskInputRefusal };

const TERMINAL = new Set(["done", "rejected", "failed", "cancelled"]);
/**
 * A steer may land on a task the worker holds or is about to pick up.
 * Plan 022: a user-`paused` task also takes steers — pausing is the natural
 * moment to redirect a run. The steer is stored undelivered and the worker
 * renders it on its next turn after Resume (delivery does not depend on
 * task status). An answer is still refused on a paused task: it has no
 * open question.
 */
const STEERABLE = new Set(["running", "queued", "paused"]);

type GuardTask = Pick<Doc<"tasks">, "status" | "pendingQuestion">;
type GuardApproval = Pick<Doc<"approvals">, "status" | "payload">;

/** A pending approval for the plan itself (payload.stage === "plan"). */
function isPlanApproval(approval: GuardApproval): boolean {
  const payload = approval.payload as { stage?: unknown } | undefined;
  return payload?.stage === "plan";
}

/**
 * Pure decision over a fresh read. Order: terminal, then any pending
 * approval (plan first), then the kind-specific state check.
 */
export function decideTaskInput(
  task: GuardTask,
  approvals: GuardApproval[],
  kind: TaskInputKind,
  expectedQuestion?: string
): TaskInputAdmission {
  if (TERMINAL.has(task.status)) return { ok: false, reason: "terminal" };
  const pending = approvals.filter((approval) => approval.status === "pending");
  if (pending.some(isPlanApproval)) return { ok: false, reason: "awaiting_plan_approval" };
  // A parked needs_approval task with no row yet still waits on the user.
  if (pending.length > 0 || task.status === "needs_approval") {
    return { ok: false, reason: "awaiting_approval" };
  }
  if (kind === "steer") {
    return STEERABLE.has(task.status) ? { ok: true } : { ok: false, reason: "not_running" };
  }
  // kind === "answer": only the question that is still open.
  if (task.status !== "waiting_input" || !task.pendingQuestion) {
    return { ok: false, reason: "question_mismatch" };
  }
  if (expectedQuestion !== undefined && expectedQuestion.trim() !== task.pendingQuestion.trim()) {
    return { ok: false, reason: "question_mismatch" };
  }
  return { ok: true };
}

/** Re-read the task and its approvals, then decide. */
export async function admitTaskInput(
  ctx: { db: any },
  taskId: Id<"tasks">,
  kind: TaskInputKind,
  opts: { expectedQuestion?: string } = {}
): Promise<TaskInputAdmission> {
  const task = (await ctx.db.get(taskId)) as Doc<"tasks"> | null;
  if (!task) return { ok: false, reason: "not_running" };
  const approvals = (await ctx.db
    .query("approvals")
    .withIndex("by_task", (q: any) => q.eq("taskId", taskId))
    .collect()) as Doc<"approvals">[];
  return decideTaskInput(task, approvals, kind, opts.expectedQuestion);
}

/** The quiet inline line the composer shows for each refusal. */
export const TASK_INPUT_REFUSAL_COPY: Record<TaskInputRefusal, string> = {
  awaiting_approval: "Waiting for your approval. Approve or reject first.",
  awaiting_plan_approval: "Waiting for you to approve the plan. Approve or reject it first.",
  terminal: "This task has finished. Retry it or start a new one.",
  not_running: "The task isn't running right now, so it can't take instructions.",
  question_mismatch: "That question is no longer open. Check the latest one.",
};
