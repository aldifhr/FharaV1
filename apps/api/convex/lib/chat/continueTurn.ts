/**
 * Chat action side of interrupted replies (lib/chat/continueReply.ts has
 * the pure rules): keep a cut reply's partial text, and stream the rest of
 * a cut reply into the same message when the user says "continue".
 */
import { internal } from "../../_generated/api";
import type { ActionCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import type { ChatLlmConfig, CompleteResult } from "./llm";
import { completeWithSnapshot, type ChatSnapshotScope } from "./snapshot";
import {
  buildContinueMessages,
  buildContinueSystem,
  interruptedCutOff,
  joinContinuation,
  keptPartial,
  TRUNCATED_REASON,
  type CutOff,
} from "./continueReply";

export const TRUNCATED_CUT_OFF: CutOff = { kind: "truncated", reason: TRUNCATED_REASON };

/**
 * A reply whose stream failed after text arrived: keep that text as the
 * message, marked interrupted (no separate error bubble), and return it as
 * the reply's result.
 */
export async function keepCutReply(
  ctx: Pick<ActionCtx, "runMutation">,
  messageId: Id<"messages">,
  error: unknown,
  kept: { content: string; reasoning: string },
): Promise<CompleteResult & { messageId: Id<"messages"> }> {
  await ctx.runMutation(internal.chatContext.updateStreamingAgentMessage, {
    messageId,
    content: kept.content,
    reasoning: kept.reasoning || undefined,
    streaming: false,
    cutOff: interruptedCutOff(error),
  });
  return { content: kept.content, reasoning: kept.reasoning, reasoningDurationMs: 0, messageId };
}

/** Keep the leading whitespace a cleaner may trim: it is where the join happens. */
function keepLead(raw: string, clean: (raw: string) => string): string {
  const cleaned = clean(raw);
  const lead = /^\s*/u.exec(raw)?.[0] ?? "";
  return cleaned.trim() ? lead + cleaned.trimStart() : "";
}

export type ContinueTarget = {
  messageId: Id<"messages">;
  content: string;
  reasoning: string;
};

/**
 * Stream the rest of a cut reply into the same message. Never throws: a
 * failure leaves the text so far with a fresh cut-off reason (and Continue).
 */
export async function runContinueTurn(
  ctx: Pick<ActionCtx, "runMutation">,
  input: {
    target: ContinueTarget;
    agent: { name: string; role: string; systemPrompt?: string };
    projectName?: string;
    /** The conversation before the cut reply, as chat messages. */
    prior: { role: string; content: string }[];
    config: ChatLlmConfig;
    scope: ChatSnapshotScope;
    /** The reply's visible-text cleaner (tool markup, internal phrasing). */
    clean: (raw: string) => string;
  },
): Promise<void> {
  const { target } = input;
  const messageId = target.messageId;
  const base = target.content;
  await ctx.runMutation(internal.chatContext.updateStreamingAgentMessage, { messageId, streaming: true, clearCutOff: true });
  let lastPatchAt = 0;
  let patchChain: Promise<unknown> = Promise.resolve();
  const onChunk = ({ content }: { content: string }) => {
    const now = Date.now();
    const next = keepLead(content, input.clean);
    if (now - lastPatchAt < 250 || !next) return;
    lastPatchAt = now;
    const joined = joinContinuation(base, next);
    patchChain = patchChain
      .then(() => ctx.runMutation(internal.chatContext.updateStreamingAgentMessage, { messageId, content: joined }))
      .catch(() => undefined);
  };
  const system = buildContinueSystem(input.agent, input.projectName);
  const msgs = buildContinueMessages(input.prior, base);
  let content = base;
  let cutOff: CutOff | undefined;
  try {
    const raw = await completeWithSnapshot(ctx, input.scope, system, msgs, input.config, onChunk);
    const next = keepLead(raw.content, input.clean);
    content = joinContinuation(base, next);
    if (!next) cutOff = { kind: "interrupted", reason: "Reply stopped: the model returned nothing when asked to continue" };
    else if (raw.truncated) cutOff = TRUNCATED_CUT_OFF;
  } catch (error) {
    const kept = keptPartial(error, (text) => keepLead(text, input.clean));
    content = kept ? joinContinuation(base, kept.content) : base;
    cutOff = interruptedCutOff(error);
  }
  await patchChain;
  await ctx.runMutation(internal.chatContext.updateStreamingAgentMessage, {
    messageId,
    content,
    streaming: false,
    ...(cutOff ? { cutOff } : { clearCutOff: true }),
  });
}
