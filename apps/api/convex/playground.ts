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
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { assertProjectAccess, visibleProjects } from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";
import { loadProviderPool, type PoolConnectionPayload } from "./lib/llmResolver";
import { redactSecrets } from "./lib/contextSnapshot";

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

// The run action itself (`run`) lives in playgroundNode.ts: it calls the
// user's LLM endpoint, which needs the Node runtime ("use node"), and a
// "use node" module may only export actions.

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
