import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * Everything that belongs to one conversation, deleted with it in the same
 * transaction: messages, participant rows, context summaries, the
 * `threadIndex` row, its agent events, its context snapshots (with their
 * bodies), and the scheduled tasks that post into it (with their runs).
 * Messages go first so a reply scheduled before the delete claims nothing
 * and no-ops (`chatContext.insertAgentMessage` also refuses a gone
 * conversation). Tasks dispatched from the chat keep living on the project
 * board; their `conversationId` dangles, which `taskCardConversationId`
 * treats as "no chat".
 */
export async function deleteConversationCascade(
  ctx: MutationCtx,
  conversation: Doc<"conversations">
): Promise<{ messages: number }> {
  const conversationId = conversation._id;
  const messages = await ctx.db
    .query("messages")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
    .collect();
  for (const row of messages) await ctx.db.delete(row._id);
  const participants = await ctx.db
    .query("conversationParticipants")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
    .collect();
  for (const row of participants) await ctx.db.delete(row._id);
  const summaries = await ctx.db
    .query("contextSummaries")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
    .collect();
  for (const row of summaries) await ctx.db.delete(row._id);
  const events = await ctx.db
    .query("agentEvents")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
    .collect();
  for (const row of events) await ctx.db.delete(row._id);
  const snapshots = await ctx.db
    .query("contextSnapshots")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
    .collect();
  for (const snapshot of snapshots) {
    const bodies = await ctx.db
      .query("contextSnapshotBodies")
      .withIndex("by_snapshot", (q) => q.eq("snapshotId", snapshot._id))
      .collect();
    for (const body of bodies) await ctx.db.delete(body._id);
    await ctx.db.delete(snapshot._id);
  }
  if (conversation.projectId) {
    const projectId = conversation.projectId;
    const scheduled = await ctx.db
      .query("scheduledTasks")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    for (const task of scheduled) {
      if (task.target.kind !== "conversation" || task.target.conversationId !== conversationId) continue;
      const runs = await ctx.db
        .query("scheduledTaskRuns")
        .withIndex("by_scheduled_task", (q) => q.eq("scheduledTaskId", task._id))
        .collect();
      for (const run of runs) await ctx.db.delete(run._id);
      await ctx.db.delete(task._id);
    }
  }
  const threadRow = await ctx.db
    .query("threadIndex")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
    .unique();
  if (threadRow) await ctx.db.delete(threadRow._id);
  await ctx.db.delete(conversationId);
  return { messages: messages.length };
}
