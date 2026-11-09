"use node";

/**
 * The Reviewer's LLM run (Second Opinion + Shadow Agent), in the Node
 * runtime. The request / read / store functions stay in reviewer.ts; this
 * module only holds the action that calls the user's LLM endpoint.
 *
 * Why Node: a user's OpenAI-compatible gateway is often a plain
 * `http://<ip>:<port>` endpoint. From the default Convex runtime that fetch
 * failed (Second Opinion showed "LLM request failed: 404" after 29 ms and 0
 * tokens) while chat.ts — already "use node" — reached the same gateway
 * with the same config. A "use node" module may only export actions, so
 * the queries and mutations it calls live in reviewer.ts.
 */
import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { completeWithFallback, getGlobalLLMConfig, resolveConfigChain, type ChatLlmConfig } from "./lib/chat/llm";
import { buildRepoToolProtocol } from "./lib/prompts/chat";
import {
  OPINION_MAX_TOOL_CALLS,
  OPINION_TOKEN_CAP,
  SHADOW_MAX_TOOL_CALLS,
  SHADOW_MAX_NOTES_PER_SUBTASK,
  SHADOW_TOKEN_CAP_PER_TASK,
  SHADOW_MAX_NOTES_PER_TASK,
  buildOpinionSystem,
  buildShadowSystem,
  parseOpinion,
  parseShadowNotes,
} from "./lib/reviewer/opinion";
import { ReviewerBudgetError, runReviewerLoop } from "./lib/reviewer/run";
import { callReadOnlyRepoTool } from "./lib/reviewer/repoToolCall";

/** Runs one second opinion or shadow review. Read-only by construction (lib/reviewer/run.ts). */
export const runReview = internalAction({
  args: { opinionId: v.id("reviewOpinions") },
  handler: async (ctx, args) => {
    const context = await ctx.runQuery(internal.reviewer.getReviewContext, { opinionId: args.opinionId });
    if (!context) {
      await ctx.runMutation(internal.reviewer.finishReview, {
        opinionId: args.opinionId,
        error: "The subtask or message is gone",
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: 0,
      });
      return null;
    }
    const shadow = context.mode === "shadow";
    const tokenCap = shadow ? Math.max(0, SHADOW_TOKEN_CAP_PER_TASK - context.shadowTokensUsed) : OPINION_TOKEN_CAP;
    const notesLeft = Math.max(0, SHADOW_MAX_NOTES_PER_TASK - context.shadowNotesUsed);
    const maxToolCalls = shadow ? SHADOW_MAX_TOOL_CALLS : OPINION_MAX_TOOL_CALLS;
    let hasTools = false;
    try {
      hasTools = (await ctx.runQuery(internal.repoTools.availability, { projectId: context.projectId })).available;
    } catch {
      hasTools = false;
    }
    const toolProtocol = hasTools ? buildRepoToolProtocol(maxToolCalls) : undefined;
    const system = shadow
      ? buildShadowSystem({ persona: context.persona, maxNotes: Math.min(SHADOW_MAX_NOTES_PER_SUBTASK, notesLeft), hasRepoTools: hasTools, toolProtocol })
      : buildOpinionSystem({ persona: context.persona, target: context.target, hasRepoTools: hasTools, toolProtocol });
    let model: string | undefined;
    const usage = { inputTokens: 0, outputTokens: 0, toolCalls: 0 };
    try {
      // Primary (agent > reviewer tier > pool) then the Reviewer agent's
      // fallback model when one is configured. Once a step falls back, the
      // rest of the loop stays on the fallback.
      let chain: ChatLlmConfig[] = await resolveConfigChain(context.providers, getGlobalLLMConfig(), context.prefs);
      model = chain[0].model;
      const result = await runReviewerLoop({
        system,
        material: context.material,
        maxToolCalls: hasTools ? maxToolCalls : 0,
        tokenCap,
        usage,
        step: async (sys, messages) => {
          const reply = await completeWithFallback(sys, messages, chain);
          if (reply.fellBack) chain = [reply.config];
          model = reply.config.model;
          return reply.content;
        },
        callTool: hasTools ? (call) => callReadOnlyRepoTool(ctx, context.projectId, call) : undefined,
      });
      const common = {
        opinionId: args.opinionId,
        model,
        ...(context.agentId ? { agentId: context.agentId } : {}),
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        toolCalls: result.toolCalls,
      };
      if (shadow) {
        const notes = parseShadowNotes(result.answer, Math.min(SHADOW_MAX_NOTES_PER_SUBTASK, notesLeft));
        await ctx.runMutation(internal.reviewer.finishReview, { ...common, notes });
      } else {
        const opinion = parseOpinion(result.answer);
        await ctx.runMutation(internal.reviewer.finishReview, { ...common, ...opinion });
      }
    } catch (error) {
      const message =
        error instanceof ReviewerBudgetError
          ? error.message
          : `The Reviewer could not finish: ${error instanceof Error ? error.message : String(error)}`;
      await ctx.runMutation(internal.reviewer.finishReview, {
        opinionId: args.opinionId,
        error: message,
        model,
        // Tokens already spent before the failure still count.
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        toolCalls: usage.toolCalls,
      });
    }
    return null;
  },
});
