import { internal } from "../../_generated/api";
import type { ActionCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { replyFailureText } from "./replyLifecycle";
import { bindReplyStop, isChatStopped, watchReplyStop } from "./replyStop";

/**
 * Durable reply run (t3code idea #1): the "already replied?" check and the
 * claim are one mutation, so a double-scheduled run returns before it
 * creates a bubble. The claim is settled answered/failed here; a run killed
 * by the 10-minute Node cap is settled by chatReplies.sweepStale.
 *
 * Stop (lib/chat/replyStop.ts): while `run` works, the user's Stop flag is
 * polled and aborts the run's LLM calls. A stopped run is already settled by
 * chatReplies.stopReply, so it ends quietly here: no "failed", no rethrow.
 */
export async function runDurableReply(
  ctx: ActionCtx,
  userMessageId: Id<"messages">,
  run: () => Promise<void>
): Promise<void> {
  const claim = await ctx.runMutation(internal.chatReplies.claimReply, { userMessageId });
  if (!claim.claimed) return;
  const stop = watchReplyStop(() =>
    ctx.runQuery(internal.chatReplies.replyStopRequested, { userMessageId, runId: claim.runId })
  );
  bindReplyStop(ctx, stop);
  try {
    await run();
  } catch (error) {
    // The run may have failed on a refused write before the poll noticed.
    if (isChatStopped(error, stop.signal) || (await stop.check())) return;
    await ctx.runMutation(internal.chatReplies.settleReply, {
      userMessageId,
      runId: claim.runId,
      outcome: "failed",
      error: replyFailureText(error),
    });
    throw error;
  } finally {
    await stop.dispose();
  }
  // A no-op when the reply was stopped (settleReply only settles "replying").
  await ctx.runMutation(internal.chatReplies.settleReply, { userMessageId, runId: claim.runId, outcome: "answered" });
}
