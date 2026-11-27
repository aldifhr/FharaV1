/** Shared fallback: ask the user to pick a role when routing is not confident. */
import { internal } from "@fhara/runtime/api";
import type { ActionCtx } from "@fhara/runtime/functions";
import type { Id } from "@fhara/runtime/data";
import { ROLE_CHOICE_QUESTION } from "../prompts/chat";

export async function postRoleChoiceCard(ctx: ActionCtx, args: {
  projectId?: Id<"projects">;
  conversationId?: Id<"conversations">;
  userMessageId: Id<"messages">;
  agentId?: Id<"agents">;
}): Promise<void> {
  await ctx.runMutation(internal.chatContext.insertAgentMessage, {
    ...(args.projectId ? { projectId: args.projectId } : {}),
    ...(args.agentId ? { agentId: args.agentId } : {}),
    conversationId: args.conversationId,
    replyToMessageId: args.userMessageId,
    content: ROLE_CHOICE_QUESTION,
    card: { kind: "role_choice", data: { question: ROLE_CHOICE_QUESTION } },
  });
}
