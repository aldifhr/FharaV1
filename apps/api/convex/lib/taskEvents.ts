import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * The one writer for `taskEvents` (t3code idea #3: a store-assigned,
 * monotonic sequence per stream; idea only, no code copied).
 *
 * Every task event gets `sequence = last + 1` within its task. The last
 * sequence is read from the `by_task_and_sequence` index (one indexed row),
 * not from a counter on the task doc: patching the task on every event would
 * re-run every subscription that reads the task. Two concurrent appends to
 * the same task both read that index range, so Convex OCC retries the loser
 * and the numbers stay gap-free and unique.
 *
 * Rows written before this helper have no `sequence`; the index sorts them
 * first (undefined < numbers), by `_creationTime`, which is also their real
 * order, so readers can treat the index order as the total order.
 */
export type TaskEventInput = Omit<Doc<"taskEvents">, "_id" | "_creationTime" | "sequence">;

export async function nextTaskEventSequence(ctx: Pick<MutationCtx, "db">, taskId: Id<"tasks">): Promise<number> {
  const last = await ctx.db
    .query("taskEvents")
    .withIndex("by_task_and_sequence", (q) => q.eq("taskId", taskId))
    .order("desc")
    .first();
  return typeof last?.sequence === "number" ? last.sequence + 1 : 1;
}

export async function appendTaskEvent(ctx: Pick<MutationCtx, "db">, event: TaskEventInput): Promise<Id<"taskEvents">> {
  const sequence = await nextTaskEventSequence(ctx, event.taskId);
  return await ctx.db.insert("taskEvents", {
    ...event,
    createdAt: event.createdAt ?? Date.now(),
    sequence,
  });
}

/**
 * The one writer for canonical `agentEvents`. Sequence scope: the
 * conversation when the row belongs to one (unchanged behaviour), otherwise
 * the task. Uses the matching `*_and_sequence` index, so the order follows
 * the sequence, not insertion time.
 */
export type AgentEventInput = Omit<Doc<"agentEvents">, "_id" | "_creationTime" | "sequence" | "createdAt"> & {
  createdAt?: number;
};

export async function appendAgentEvent(ctx: Pick<MutationCtx, "db">, event: AgentEventInput): Promise<Id<"agentEvents">> {
  let last: Doc<"agentEvents"> | null = null;
  if (event.conversationId) {
    last = await ctx.db
      .query("agentEvents")
      .withIndex("by_conversation_and_sequence", (q) => q.eq("conversationId", event.conversationId!))
      .order("desc")
      .first();
  } else if (event.taskId) {
    last = await ctx.db
      .query("agentEvents")
      .withIndex("by_task_and_sequence", (q) => q.eq("taskId", event.taskId!))
      .order("desc")
      .first();
  }
  const sequence = typeof last?.sequence === "number" ? last.sequence + 1 : 1;
  return await ctx.db.insert("agentEvents", {
    ...event,
    createdAt: event.createdAt ?? Date.now(),
    sequence,
  });
}
