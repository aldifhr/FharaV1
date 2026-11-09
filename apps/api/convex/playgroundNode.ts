"use node";

/**
 * Agent Playground run, in the Node runtime. The read / record / save
 * functions stay in playground.ts; this module only holds the action that
 * calls the user's LLM endpoint (see reviewerNode.ts for why: a plain
 * `http://<ip>:<port>` gateway failed from the default runtime with
 * "LLM request failed: 404" while the "use node" chat reached it).
 *
 * No side effects by construction (playground.ts header): one completion
 * request, one tokenUsage row and one audit row through `recordRun`.
 */
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { completeWithAgent, getGlobalLLMConfig, resolveConfigFromProviders } from "./lib/chat/llm";
import { estimateTokens, redactSecrets, sectionsToMessages, SECTION_KEYS, type SectionKey } from "./lib/contextSnapshot";

const PLAYGROUND_SECTION_CAP = 64 * 1024;

const sectionArg = v.object({ key: v.string(), content: v.string() });

export interface PlaygroundResult {
  ok: boolean;
  content: string;
  reasoning: string;
  error?: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  estimated: true;
  estimatedCost: number | null;
  durationMs: number;
}

export const run = action({
  args: {
    projectId: v.id("projects"),
    snapshotId: v.optional(v.id("contextSnapshots")),
    sections: v.array(sectionArg),
    providerId: v.optional(v.id("llmProviders")),
    modelRowId: v.optional(v.id("llmModels")),
    temperature: v.optional(v.number()),
    toolsEnabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<PlaygroundResult> => {
    const { pool } = await ctx.runQuery(internal.playground.runContext, { projectId: args.projectId });
    const known = new Set<string>(SECTION_KEYS);
    const sections = args.sections
      .filter((s) => known.has(s.key))
      .map((s) => ({ key: s.key as SectionKey, content: s.content.slice(0, PLAYGROUND_SECTION_CAP) }));
    // Tool definitions are prompt text only, included when toggled on; the
    // request itself never carries a tools parameter.
    const { system, messages } = sectionsToMessages(sections, { toolsEnabled: args.toolsEnabled === true });
    const agentLike = args.providerId ? { llmProviderId: String(args.providerId), llmModelId: args.modelRowId ? String(args.modelRowId) : undefined } : undefined;
    const config = await resolveConfigFromProviders(pool, getGlobalLLMConfig(), agentLike);
    const conn = pool.find((p) => String(p._id) === String(args.providerId));
    const modelRow = conn?.models.find((m) => m.modelId === config.model);
    const promptText = [system, ...messages.map((m) => m.content)].join("\n");
    const startedAt = Date.now();
    let content = "";
    let reasoning = "";
    let error: string | undefined;
    try {
      const result = await completeWithAgent(system, messages, config, undefined, { temperature: args.temperature });
      content = result.content;
      reasoning = result.reasoning;
    } catch (e) {
      error = redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 2000);
    }
    const durationMs = Date.now() - startedAt;
    const inputTokens = estimateTokens(promptText);
    const outputTokens = content ? estimateTokens(content) : 0;
    const estimatedCost =
      modelRow?.inputPricePer1k !== undefined && modelRow?.outputPricePer1k !== undefined
        ? (inputTokens / 1000) * modelRow.inputPricePer1k + (outputTokens / 1000) * modelRow.outputPricePer1k
        : null;
    await ctx.runMutation(internal.playground.recordRun, {
      projectId: args.projectId,
      ...(args.snapshotId ? { snapshotId: args.snapshotId } : {}),
      model: config.model,
      ...(conn ? { providerId: conn._id } : {}),
      ...(modelRow?._id ? { modelRowId: modelRow._id as Id<"llmModels"> } : {}),
      inputTokens,
      outputTokens,
      ...(estimatedCost !== null ? { estimatedCost } : {}),
      ok: !error,
    });
    return {
      ok: !error,
      content,
      reasoning,
      ...(error ? { error } : {}),
      model: config.model,
      provider: config.provider,
      inputTokens,
      outputTokens,
      estimated: true,
      estimatedCost,
      durationMs,
    };
  },
});
