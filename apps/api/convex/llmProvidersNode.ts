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
import type { PoolConnectionPayload } from "./lib/llmResolver";

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
