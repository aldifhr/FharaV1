/**
 * Chat usage ledger (plan 040 P3): one tokenUsage row per backend chat LLM
 * call that answered. Real provider usage when the endpoint returned it,
 * else a chars/4 estimate flagged `estimated` (as the worker does).
 * Recording never fails the reply: errors are swallowed.
 */
import type { ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { estimateTokens } from "../contextSnapshot";
import { estimateCostFromPricing } from "../usageLedger";
import type { CompleteResult } from "./llm";

export interface ChatUsageScope {
  /** Absent in a personal chat with no project: tokenUsage rows are per project, so none is recorded. */
  projectId?: Id<"projects">;
  agentId: Id<"agents">;
  callRole: string;
}

/** Wire kind for the ledger, same names as the worker (effects/llmCall providerKindOf). */
function providerKindOf(provider: string | undefined): string | undefined {
  if (!provider) return undefined;
  return provider === "openai" ? "openai-compatible" : provider;
}

/** The recordChatTokenUsage args for one answered call (pure; exported for tests). */
export function chatUsageArgs(
  scope: ChatUsageScope & { projectId: Id<"projects"> },
  call: { system: string; msgs: { role: string; content: string }[]; result: CompleteResult; fallbackModel: string }
) {
  const { result } = call;
  const reported = result.usage;
  const estimated = !reported || reported.inputTokens === undefined || reported.outputTokens === undefined;
  const promptText = [call.system, ...call.msgs.map((m) => m.content)].join("\n");
  const inputTokens = reported?.inputTokens ?? estimateTokens(promptText);
  const outputTokens = reported?.outputTokens ?? estimateTokens(result.content);
  const served = result.servedBy;
  const estimatedCost = estimateCostFromPricing(served, inputTokens, outputTokens);
  const providerKind = providerKindOf(served?.provider);
  return {
    projectId: scope.projectId,
    agentId: scope.agentId,
    model: served?.model || call.fallbackModel,
    inputTokens,
    outputTokens,
    ...(served?.connectionId ? { providerId: served.connectionId as Id<"llmProviders"> } : {}),
    ...(served?.modelRowId ? { modelId: served.modelRowId as Id<"llmModels"> } : {}),
    ...(estimatedCost !== undefined ? { estimatedCost } : {}),
    ...(estimated ? { estimated: true } : {}),
    ...(reported?.cachedInputTokens !== undefined ? { cachedInputTokens: reported.cachedInputTokens } : {}),
    ...(reported?.cacheWriteTokens !== undefined ? { cacheWriteTokens: reported.cacheWriteTokens } : {}),
    ...(reported?.reasoningTokens !== undefined ? { reasoningTokens: reported.reasoningTokens } : {}),
    ...(result.durationMs !== undefined ? { durationMs: Math.max(0, Math.round(result.durationMs)) } : {}),
    ...(providerKind ? { providerKind } : {}),
    callRole: scope.callRole,
  };
}

export async function recordChatUsage(
  ctx: Pick<ActionCtx, "runMutation">,
  scope: ChatUsageScope,
  call: { system: string; msgs: { role: string; content: string }[]; result: CompleteResult; fallbackModel: string }
): Promise<void> {
  const projectId = scope.projectId;
  if (!projectId) return;
  try {
    await ctx.runMutation(internal.orchestration.recordChatTokenUsage, chatUsageArgs({ ...scope, projectId }, call));
  } catch {
    // Observability only: never break the chat reply.
  }
}
