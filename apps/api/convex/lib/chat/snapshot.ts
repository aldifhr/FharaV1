/**
 * Context Snapshot for chat replies: wraps one completeWithAgent call and
 * records what it saw (system prompt split into sections, history, the
 * user's message) plus the reply, timing and error. Recording never fails
 * the reply: errors are swallowed. Disabled by CONTEXT_SNAPSHOTS=0.
 */
import type { ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { buildContextSnapshot, contextSnapshotsEnabled, estimateTokens, type CallRole } from "../contextSnapshot";
import { completeWithAgent, type ChatLlmConfig, type CompleteResult } from "./llm";
import { replyStopOf } from "./replyStop";
import { recordChatUsage } from "./usage";
import { DEFAULT_USER_TIME_ZONE, TimeContextThrottle, withTimeTail } from "../timeContext";

/** D4: one stamp per conversation at most every 10 minutes (per warm isolate). */
const timeThrottle = new TimeContextThrottle();

/**
 * D4: the time line appended to the last user turn (after history, the
 * volatile tail), in the Settings zone. A ctx without runQuery (tests) or a
 * failed read uses Asia/Jakarta.
 */
export async function chatTimeTail(
  ctx: Partial<Pick<ActionCtx, "runQuery">>,
  scope: Pick<ChatSnapshotScope, "conversationId" | "agentId">,
  msgs: { role: string; content: string }[],
  now: number = Date.now()
): Promise<{ role: string; content: string }[]> {
  let zone = DEFAULT_USER_TIME_ZONE;
  try {
    if (ctx.runQuery) zone = await ctx.runQuery(internal.appSettings.userTimeZone, {});
  } catch {
    // Keep the default zone.
  }
  return withTimeTail(msgs, timeThrottle.line(String(scope.conversationId ?? scope.agentId), now, zone));
}

export interface ChatSnapshotScope {
  /** Absent in a personal chat with no project: no snapshot is recorded. */
  projectId?: Id<"projects">;
  conversationId?: Id<"conversations">;
  agentId: Id<"agents">;
  agentRole?: string;
  messageId?: Id<"messages">;
  callRole: CallRole;
}

export async function recordChatSnapshot(
  ctx: Pick<ActionCtx, "runMutation">,
  scope: ChatSnapshotScope,
  call: {
    system: string;
    msgs: { role: string; content: string }[];
    config: ChatLlmConfig;
    response?: string;
    error?: unknown;
    durationMs: number;
    /** D5: the answering call's reported usage and TTFT (absent → chars/4 estimate). */
    result?: Pick<CompleteResult, "usage" | "ttftMs">;
  }
): Promise<void> {
  if (!contextSnapshotsEnabled()) return;
  // contextSnapshots rows are per project (retention, cascade); a personal
  // chat with no project attached records none (plan 039).
  const projectId = scope.projectId;
  if (!projectId) return;
  try {
    const messages = [
      { role: "system", content: call.system },
      ...call.msgs.map((m) => ({ role: m.role, content: m.content })),
    ];
    const promptText = messages.map((m) => m.content).join("\n");
    const usage = call.result?.usage;
    const reported = usage && typeof usage.inputTokens === "number" ? usage : undefined;
    const { meta, body } = buildContextSnapshot({
      callRole: scope.callRole,
      messages,
      response: call.response,
      error: call.error === undefined ? undefined : call.error instanceof Error ? call.error.message : String(call.error),
      model: call.config.model,
      provider: call.config.provider,
      // Reported usage when the endpoint sent it (D5); otherwise chars/4
      // estimates, flagged.
      ...(reported
        ? {
            inputTokens: reported.inputTokens,
            outputTokens: reported.outputTokens ?? (call.response ? estimateTokens(call.response) : 0),
            cachedInputTokens: reported.cachedInputTokens,
          }
        : {
            inputTokens: estimateTokens(promptText),
            outputTokens: call.response ? estimateTokens(call.response) : 0,
            usageEstimated: true,
          }),
      ttftMs: call.result?.ttftMs,
      durationMs: call.durationMs,
    });
    await ctx.runMutation(internal.contextSnapshots.record, {
      projectId,
      ...(scope.conversationId ? { conversationId: scope.conversationId } : {}),
      agentId: scope.agentId,
      ...(scope.agentRole ? { agentRole: scope.agentRole } : {}),
      ...(scope.messageId ? { messageId: scope.messageId } : {}),
      source: "chat",
      meta,
      body,
    });
  } catch {
    // Observability only: never break the chat reply.
  }
}

/** completeWithAgent + a snapshot of the call (success or failure). */
export async function completeWithSnapshot(
  ctx: Pick<ActionCtx, "runMutation"> & Partial<Pick<ActionCtx, "runQuery">>,
  scope: ChatSnapshotScope,
  system: string,
  msgs: { role: string; content: string }[],
  config: ChatLlmConfig,
  onChunk?: Parameters<typeof completeWithAgent>[3]
): Promise<CompleteResult> {
  const startedAt = Date.now();
  msgs = await chatTimeTail(ctx, scope, msgs, startedAt);
  try {
    // A user Stop aborts this call (lib/chat/replyStop.ts): the flag is polled while it runs.
    const stop = replyStopOf(ctx);
    const result = stop
      ? await stop.during(() => completeWithAgent(system, msgs, config, onChunk, { signal: stop.signal }))
      : await completeWithAgent(system, msgs, config, onChunk);
    await recordChatSnapshot(ctx, scope, { system, msgs, config, response: result.content, durationMs: Date.now() - startedAt, result });
    await recordChatUsage(ctx, scope, { system, msgs, result, fallbackModel: config.model });
    return result;
  } catch (error) {
    await recordChatSnapshot(ctx, scope, { system, msgs, config, error, durationMs: Date.now() - startedAt });
    throw error;
  }
}
