"use node";

/**
 * Magic prompt (prompt enhancement), in the Node runtime. Provider CRUD and
 * the pool query stay in llmProviders.ts; this module only holds the action
 * that calls the user's LLM endpoint.
 *
 * Why Node (same as reviewerNode.ts): from the default
 * Convex runtime a plain `http://<ip>:<port>` OpenAI-compatible gateway
 * answered "LLM request failed: 404" while the "use node" chat reached it
 * with the same config. The call now goes through lib/chat/llm, which tries
 * the base URL with and without /v1, routes every non-anthropic kind to
 * chat completions, and names status, kind, host and model on failure.
 */
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { assertServiceToken } from "./lib/authz";
import { completeWithAgent, getGlobalLLMConfig, resolveConfigFromProviders } from "./lib/chat/llm";
import { ENHANCEMENT_SYSTEM_PROMPT, enhancementUserMessage } from "./lib/prompts/enhance";
import { resolveConnectionKey, type PoolConnectionPayload } from "./lib/llmResolver";
import { listProviderModels } from "./lib/llmModelList";

/**
 * Enhance a short/vague prompt with the primary connection of the provider
 * pool, else the global LLM config. Returns the draft unchanged when the
 * model answers with nothing.
 */
export const enhancePrompt = action({
  args: { token: v.string(), prompt: v.string() },
  handler: async (ctx, args): Promise<string> => {
    assertServiceToken(args.token);
    const pool: PoolConnectionPayload[] = await ctx.runQuery(internal.llmProviders.getForProject, {});
    const config = await resolveConfigFromProviders(pool, getGlobalLLMConfig());
    if (!config.apiKey) {
      throw new Error("No LLM API key configured. Add a provider in Settings or set LLM_API_KEY.");
    }
    const result = await completeWithAgent(ENHANCEMENT_SYSTEM_PROMPT, [
      { role: "user", content: enhancementUserMessage(args.prompt) },
    ], config);
    return result.content.trim() || args.prompt;
  },
});

export interface LlmTestResult {
  ok: boolean;
  connection: string;
  model?: string;
  latencyMs: number;
  /** First characters of the answer (ok) or the error message (not ok). */
  detail: string;
}

/**
 * Test one provider connection or one of its models with a tiny completion
 * through the same backend client chat uses (lib/chat/llm). No fallback:
 * the answer names exactly the connection and model that was tried. With
 * no modelRowId the connection's first available model in list order is
 * used; a connection with no model at all is tested by listing its models.
 * Never returns key material (errors are masked by llmHttpError).
 */
export const testModel = action({
  args: {
    token: v.string(),
    providerId: v.id("llmProviders"),
    modelRowId: v.optional(v.id("llmModels")),
  },
  handler: async (ctx, args): Promise<LlmTestResult> => {
    assertServiceToken(args.token);
    const pool: PoolConnectionPayload[] = await ctx.runQuery(internal.llmProviders.getForProject, {});
    let connection = pool.find((p) => p._id === args.providerId);
    if (!connection) {
      // Disabled connections are not in the pool; test them anyway.
      const all: PoolConnectionPayload[] = await ctx.runQuery(internal.llmProviders.getAllForTest, {});
      connection = all.find((p) => p._id === args.providerId);
    }
    if (!connection) {
      return { ok: false, connection: "?", latencyMs: 0, detail: "Provider not found" };
    }
    const ordered = [...connection.models].sort(
      (a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER)
    );
    const model = args.modelRowId
      ? connection.models.find((m) => m._id === args.modelRowId)
      : ordered.find((m) => m.isAvailable) ?? ordered[0];
    const startedAt = Date.now();
    try {
      const apiKey = await resolveConnectionKey(connection);
      if (!model) {
        const ids = await listProviderModels(connection.baseUrl.replace(/\/$/, ""), connection.provider, apiKey || undefined);
        return {
          ok: true,
          connection: connection.name,
          latencyMs: Date.now() - startedAt,
          detail: `Key works; ${ids.length} model${ids.length === 1 ? "" : "s"} available. Add one to the list.`,
        };
      }
      const result = await completeWithAgent(
        "You are a connectivity check. Answer with the single word OK.",
        [{ role: "user", content: "ping" }],
        { provider: connection.provider.toLowerCase(), model: model.modelId, baseUrl: connection.baseUrl, apiKey }
      );
      const text = result.content.trim() || result.reasoning.trim();
      return {
        ok: text.length > 0,
        connection: connection.name,
        model: model.modelId,
        latencyMs: Date.now() - startedAt,
        detail: text ? text.slice(0, 80) : "The model answered with an empty response",
      };
    } catch (error) {
      return {
        ok: false,
        connection: connection.name,
        model: model?.modelId,
        latencyMs: Date.now() - startedAt,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  },
});
