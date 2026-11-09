"use node";

/**
 * Self-Improvement Lab "Suggest fix" LLM run, in the Node runtime. The
 * request / read / store functions stay in improve.ts; this module only
 * holds the action that calls the user's LLM endpoint.
 *
 * Why Node (same as reviewerNode.ts / playgroundNode.ts): a user's
 * OpenAI-compatible gateway is often a plain `http://<ip>:<port>` endpoint.
 * From the default Convex runtime that fetch failed with "LLM request
 * failed: 404" while the "use node" chat reached the same gateway with the
 * same config. The call goes through lib/chat/llm (endpoint candidates with
 * and without /v1, provider-kind routing, errors that name host and model).
 */
import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { completeWithFallback, getGlobalLLMConfig, resolveConfigChain } from "./lib/chat/llm";
import { estimateTokens } from "./lib/reviewer/opinion";
import { buildSuggestionPrompt, resolveSuggestion } from "./lib/improve/suggest";

/** Token cap for the one suggestion call (pre-call gate, estimated). */
const SUGGESTION_TOKEN_CAP = 40_000;

export const runSuggestion = internalAction({
  args: { suggestionId: v.id("improvementSuggestions") },
  handler: async (ctx, args) => {
    const context = await ctx.runQuery(internal.improve.getSuggestionContext, { suggestionId: args.suggestionId });
    const finish = (fields: Omit<Parameters<typeof ctx.runMutation<typeof internal.improve.finishSuggestion>>[1], "suggestionId">) =>
      ctx.runMutation(internal.improve.finishSuggestion, { suggestionId: args.suggestionId, ...fields });
    if (!context) {
      await finish({ status: "error", error: "The run is gone", inputTokens: 0, outputTokens: 0 });
      return null;
    }
    if (context.candidates.length === 0) {
      await finish({ status: "no_change", rationale: "No agent prompt, skill or role took part in this run.", inputTokens: 0, outputTokens: 0 });
      return null;
    }
    const { system, user } = buildSuggestionPrompt(context.run, context.candidates);
    const inputTokens = estimateTokens(system) + estimateTokens(user);
    if (inputTokens > SUGGESTION_TOKEN_CAP) {
      await finish({ status: "error", error: `The run is too large to analyse (${inputTokens} tokens)`, inputTokens: 0, outputTokens: 0 });
      return null;
    }
    let model: string | undefined;
    try {
      // Primary (the Reviewer's prefs > pool) then its fallback model.
      const chain = await resolveConfigChain(context.providers, getGlobalLLMConfig(), context.prefs);
      model = chain[0].model;
      const answer = await completeWithFallback(system, [{ role: "user", content: user }], chain);
      model = answer.config.model;
      const reply = answer.content;
      const outputTokens = estimateTokens(reply);
      const outcome = resolveSuggestion(reply, context.candidates);
      if (!outcome.ok) {
        await finish({ status: "no_change", rationale: outcome.rationale, error: outcome.reason, model, inputTokens, outputTokens });
        return null;
      }
      await finish({
        status: "ready",
        targetKind: outcome.target.kind,
        targetId: outcome.target.id,
        targetLabel: outcome.target.label,
        baseText: outcome.target.text,
        proposedText: outcome.proposedText,
        diff: outcome.diff,
        rationale: outcome.rationale,
        model,
        inputTokens,
        outputTokens,
      });
    } catch (error) {
      await finish({
        status: "error",
        error: `The suggestion failed: ${error instanceof Error ? error.message : String(error)}`,
        model,
        inputTokens: 0,
        outputTokens: 0,
      });
    }
    return null;
  },
});
