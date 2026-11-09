/**
 * Durable approval signals.
 *
 * Pattern adapted from AkshatGiri/convex-orchestrator (Apache-2.0): a human
 * decision is a row in an inbox, written in the SAME mutation that resolves
 * the approval, and a waiting task is woken by that row instead of by a
 * worker re-deriving "was anything decided?" from the approvals table.
 * Re-implemented for Fhara's task model; no code copied.
 *
 *  - "approval" signal: the task is parked in needs_approval with no lease.
 *    The signal makes it resumable (getResumableTasks reads unconsumed
 *    signals through an index) and the resume claim consumes it. A user
 *    pause on the parked task only records `pausedBy`; the signal waits.
 *  - "command" signal: a run_command decision. The live worker waits for it
 *    in-process (keeping its lease); if that worker died mid-wait, the
 *    replayed subtask's `request` reuses an unconsumed allow instead of
 *    asking the user twice.
 */
import { internalMutation, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";

export type SignalDecision = "approved" | "rejected";

/** Approval kinds a parked task resumes from (the worker's resume path). */
export const RESUMABLE_APPROVAL_KINDS = new Set(["apply_changes"]);

export function commandLineOf(approval: Doc<"approvals">): string | undefined {
  const command = (approval.payload as { command?: unknown } | undefined)?.command;
  return typeof command === "string" ? command : undefined;
}

/**
 * Record the decision as a signal and wake the task. Call it from the
 * mutation that resolves the approval so both commit together.
 */
export async function signalApprovalDecision(
  ctx: MutationCtx,
  approval: Doc<"approvals">,
  decision: SignalDecision
): Promise<{ signalId: Id<"taskSignals">; woke: boolean }> {
  const now = Date.now();
  const isCommand = approval.kind === "run_command";
  const signalId = await ctx.db.insert("taskSignals", {
    taskId: approval.taskId,
    projectId: approval.projectId,
    name: isCommand ? "command" : "approval",
    approvalId: approval._id,
    approvalKind: approval.kind,
    decision,
    ...(approval.subtaskKey ? { subtaskKey: approval.subtaskKey } : {}),
    ...(isCommand && commandLineOf(approval) ? { command: commandLineOf(approval) } : {}),
    createdAt: now,
  });
  let woke = false;
  const task = await ctx.db.get(approval.taskId);
  if (task && !isCommand && task.status === "needs_approval" && RESUMABLE_APPROVAL_KINDS.has(approval.kind)) {
    const stillPending = await ctx.db
      .query("approvals")
      .withIndex("by_task", (q) => q.eq("taskId", approval.taskId))
      .filter((q) => q.eq(q.field("status"), "pending"))
      .take(1);
    woke = stillPending.length === 0 && !task.pausedBy;
    await ctx.db.patch(task._id, { updatedAt: now });
    await ctx.db.insert("taskEvents", {
      taskId: task._id,
      projectId: task.projectId,
      type: "task.signalled",
      payload: { signal: "approval", decision, approvalId: approval._id, kind: approval.kind, resumable: woke, paused: Boolean(task.pausedBy) },
      level: "info",
    });
  }
  return { signalId, woke };
}

/** Mark every unconsumed signal of one name on a task consumed. */
export async function consumeTaskSignals(
  ctx: MutationCtx,
  taskId: Id<"tasks">,
  name: "approval" | "command",
  consumedBy: string
): Promise<number> {
  const open = await ctx.db
    .query("taskSignals")
    .withIndex("by_task_and_consumed", (q) => q.eq("taskId", taskId).eq("consumedAt", undefined))
    .take(100);
  const now = Date.now();
  let consumed = 0;
  for (const signal of open) {
    if (signal.name !== name) continue;
    await ctx.db.patch(signal._id, { consumedAt: now, consumedBy });
    consumed += 1;
  }
  return consumed;
}

/**
 * One-off migration for the deploy that introduced signals: an apply_changes
 * approval resolved BEFORE this deploy, on a task still parked in
 * needs_approval, has no signal and would never resume. Idempotent.
 * Run: npx convex run taskSignals:backfillParkedApprovals
 */
export const backfillParkedApprovals = internalMutation({
  args: {},
  handler: async (ctx) => {
    const parked = await ctx.db
      .query("tasks")
      .withIndex("by_status", (q) => q.eq("status", "needs_approval"))
      .take(200);
    let created = 0;
    for (const task of parked) {
      const approvals = await ctx.db
        .query("approvals")
        .withIndex("by_task", (q) => q.eq("taskId", task._id))
        .collect();
      for (const approval of approvals) {
        if (!RESUMABLE_APPROVAL_KINDS.has(approval.kind)) continue;
        if (approval.status !== "approved" && approval.status !== "rejected") continue;
        const existing = await ctx.db
          .query("taskSignals")
          .withIndex("by_approval", (q) => q.eq("approvalId", approval._id))
          .take(1);
        if (existing.length > 0) continue;
        await ctx.db.insert("taskSignals", {
          taskId: task._id,
          projectId: task.projectId,
          name: "approval",
          approvalId: approval._id,
          approvalKind: approval.kind,
          decision: approval.status,
          ...(approval.subtaskKey ? { subtaskKey: approval.subtaskKey } : {}),
          createdAt: approval.resolvedAt ?? Date.now(),
        });
        created += 1;
      }
    }
    return { created };
  },
});
