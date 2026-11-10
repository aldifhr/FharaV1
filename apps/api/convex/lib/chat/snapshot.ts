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
import { recordChatUsage } from "./usage";

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
    const { meta, body } = buildContextSnapshot({
      callRole: scope.callRole,
      messages,
      response: call.response,
      error: call.error === undefined ? undefined : call.error instanceof Error ? call.error.message : String(call.error),
      model: call.config.model,
      provider: call.config.provider,
      // The chat endpoints report no usage: chars/4 estimates, flagged.
      inputTokens: estimateTokens(promptText),
      outputTokens: call.response ? estimateTokens(call.response) : 0,
      usageEstimated: true,
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
  ctx: Pick<ActionCtx, "runMutation">,
  scope: ChatSnapshotScope,
  system: string,
  msgs: { role: string; content: string }[],
  config: ChatLlmConfig,
  onChunk?: Parameters<typeof completeWithAgent>[3]
): Promise<CompleteResult> {
  const startedAt = Date.now();
  try {
    const result = await completeWithAgent(system, msgs, config, onChunk);
    await recordChatSnapshot(ctx, scope, { system, msgs, config, response: result.content, durationMs: Date.now() - startedAt });
    await recordChatUsage(ctx, scope, { system, msgs, result, fallbackModel: config.model });
    return result;
  } catch (error) {
    await recordChatSnapshot(ctx, scope, { system, msgs, config, error, durationMs: Date.now() - startedAt });
    throw error;
  }
}
