import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { isPersonalConversation } from "./conversationShape";

/**
 * Plan 039 D1: the conversation a task's stage card (plan, push, PR fix)
 * is posted into. A task started from an attached personal chat keeps its
 * cards in the project's task thread (they carry projectId) and out of the
 * personal chat, whose messages never carry a project. The personal chat
 * shows the assignment card that links to the task.
 */
export async function taskCardConversationId(
  ctx: QueryCtx | MutationCtx,
  conversationId: Id<"conversations"> | undefined
): Promise<Id<"conversations"> | undefined> {
  if (!conversationId) return undefined;
  const conversation = await ctx.db.get(conversationId);
  return conversation && isPersonalConversation(conversation) ? undefined : conversationId;
}
