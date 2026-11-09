/**
 * Agent Playground: run one edited prompt (from a Context Snapshot or blank)
 * once against a configured LLM provider and show the result next to the
 * original.
 *
 * No side effects by construction. The run action only:
 *   1. reads (access check, provider pool) through internal queries,
 *   2. makes ONE completion request (no tools parameter is ever sent; tool
 *      definitions can only ride along as prompt text, and a tool call in the
 *      reply is shown, never executed),
 *   3. records one tokenUsage row (kind "playground", no task) and one audit
 *      row through `recordRun`.
 * It never writes files, runs commands, or touches tasks, subtasks, messages
 * or approvals; playground.test.ts asserts exactly that.
 */
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { assertProjectAccess, visibleProjects } from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";
import { loadProviderPool, type PoolConnectionPayload } from "./lib/llmResolver";
import { completeWithAgent, getGlobalLLMConfig, resolveConfigFromProviders } from "./lib/chat/llm";
import { estimateTokens, redactSecrets, sectionsToMessages, SECTION_KEYS, type SectionKey } from "./lib/contextSnapshot";

const PLAYGROUND_SECTION_CAP = 64 * 1024;

/** Models the playground can call: connection + model names, never keys. */
export const models = query({
  args: {},
  handler: async (ctx) => {
    const pool = await loadProviderPool(ctx);
    return pool.flatMap((conn) =>
      conn.models
        .filter((m) => m.isAvailable)
        .map((m) => ({
          providerId: conn._id,
          providerName: conn.name,
          provider: conn.provider,
          modelRowId: m._id ?? null,
          modelId: m.modelId,
          label: m.displayName ?? m.modelId,
          priced: m.inputPricePer1k !== undefined && m.outputPricePer1k !== undefined,
        }))
    );
  },
});

/** Projects the viewer may run the playground in (usage is recorded there). */
export const projects = query({
  args: {},
  handler: async (ctx) => {
    return (await visibleProjects(ctx)).map((p) => ({ _id: p._id, name: p.name }));
  },
});

export const runContext = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<{ pool: PoolConnectionPayload[] }> => {
    await assertProjectAccess(ctx, args.projectId);
    return { pool: await loadProviderPool(ctx) };
  },
});

export const recordRun = internalMutation({
  args: {
    projectId: v.id("projects"),
    snapshotId: v.optional(v.id("contextSnapshots")),
    model: v.string(),
    providerId: v.optional(v.id("llmProviders")),
    modelRowId: v.optional(v.id("llmModels")),
    inputTokens: v.number(),
    outputTokens: v.number(),
    estimatedCost: v.optional(v.number()),
    ok: v.boolean(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("tokenUsage", {
      projectId: args.projectId,
      agentName: "Playground",
      model: args.model,
      ...(args.providerId ? { providerId: args.providerId } : {}),
      ...(args.modelRowId ? { modelId: args.modelRowId } : {}),
      ...(args.estimatedCost !== undefined ? { estimatedCost: args.estimatedCost } : {}),
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      estimated: true,
      kind: "playground",
      createdAt: Date.now(),
    });
    await recordAudit(ctx, {
      action: "playground.run",
      tool: "playground",
      target: args.model,
      decision: args.ok ? "allowed" : "recorded",
      details: {
        model: args.model,
        inputTokens: args.inputTokens,
        outputTokens: args.outputTokens,
        ...(args.snapshotId ? { snapshotId: String(args.snapshotId) } : {}),
        ok: args.ok,
      },
      projectId: args.projectId,
    });
  },
});

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

/** Save a variant as an unpinned project note (never injected into prompts). */
export const saveVariant = mutation({
  args: { projectId: v.id("projects"), title: v.string(), content: v.string() },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);
    const title = args.title.trim().slice(0, 120) || "Playground variant";
    const now = Date.now();
    const id = await ctx.db.insert("memories", {
      scope: "project",
      projectId: project._id,
      title,
      content: redactSecrets(args.content).slice(0, 60_000),
      tags: ["playground"],
      pinned: false,
      source: "user",
      createdAt: now,
      updatedAt: now,
    });
    await recordAudit(ctx, {
      action: "playground.save_variant",
      tool: "playground",
      target: title,
      details: { changed: ["memories"] },
      projectId: project._id,
    });
    return id;
  },
});
