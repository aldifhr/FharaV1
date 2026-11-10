import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { assertServiceToken } from "./lib/authz";
import { changedFields, recordAudit, setFields } from "./lib/recordAudit";
import { nextPosition, positionsFromOrder, sortModelRows } from "./lib/llmOrder";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { isOpencodeConnection, isOpencodeModelId } from "./lib/opencodeProvider";

/**
 * Give every model row a position, in the current list order, when some
 * rows have none (rows written before the list existed). Run before an
 * insert so a new model lands at the END of the list, not ahead of the
 * unpositioned rows.
 */
export async function materializePositions(ctx: MutationCtx): Promise<void> {
  const models = await ctx.db.query("llmModels").collect();
  if (models.every((m) => typeof m.position === "number")) return;
  const providers = await ctx.db.query("llmProviders").collect();
  const ordered = sortModelRows(models, providers);
  for (const [index, model] of ordered.entries()) {
    if (model.position !== index) await ctx.db.patch(model._id, { position: index });
  }
}

/**
 * Model Registry (spec §4B): models are their own entities, independent of
 * agents and reusable across the agents assigned to their connection.
 * Reads are public (the registry holds no secrets); writes require the
 * service token, exactly like provider writes, and reach the backend only
 * through the server-side route (apps/web/app/api/llm-providers).
 */

const modelFields = {
  modelId: v.string(),
  displayName: v.optional(v.string()),
  contextWindow: v.optional(v.number()),
  supportsTools: v.optional(v.boolean()),
  supportsReasoning: v.optional(v.boolean()),
  inputPricePer1k: v.optional(v.number()),
  outputPricePer1k: v.optional(v.number()),
  isAvailable: v.optional(v.boolean()),
};

export const list = query({
  args: { providerId: v.optional(v.id("llmProviders")) },
  handler: async (ctx, args) => {
    const docs = args.providerId
      ? await ctx.db
          .query("llmModels")
          .withIndex("by_provider", (q) => q.eq("providerId", args.providerId!))
          .collect()
      : await ctx.db.query("llmModels").collect();
    // List order (lib/llmOrder.ts): the fallback order Settings shows.
    const providers = await ctx.db.query("llmProviders").collect();
    return sortModelRows(docs, providers);
  },
});

/**
 * Set the whole model order at once: `orderedIds` must name every model
 * row exactly once. Position i goes to the i-th id, and each connection's
 * priority follows its first model, so legacy readers of priority agree.
 * One mutation, so the order is never half-applied.
 */
export const reorder = mutation({
  args: { token: v.string(), orderedIds: v.array(v.id("llmModels")) },
  handler: async (ctx, args) => {
    assertServiceToken(args.token);
    const models = await ctx.db.query("llmModels").collect();
    const ids = args.orderedIds.map(String);
    if (new Set(ids).size !== ids.length) throw new Error("The model order lists a model twice");
    const known = new Set(models.map((m) => String(m._id)));
    if (ids.length !== known.size || ids.some((id) => !known.has(id))) {
      throw new Error("The model order is out of date; reload and try again");
    }
    const { positions, providerPriority } = positionsFromOrder(
      ids,
      new Map(models.map((m) => [String(m._id), String(m.providerId)]))
    );
    const now = Date.now();
    for (const model of models) {
      const position = positions.get(String(model._id))!;
      if (model.position !== position) await ctx.db.patch(model._id, { position, updatedAt: now });
    }
    for (const [providerId, priority] of providerPriority) {
      const provider = await ctx.db.get(providerId as Id<"llmProviders">);
      if (provider && provider.priority !== priority) {
        await ctx.db.patch(provider._id, { priority, updatedAt: now });
      }
    }
    await recordAudit(ctx, { action: "llmModel.reorder", details: { count: ids.length } });
    return { ok: true };
  },
});

export const create = mutation({
  args: { token: v.string(), providerId: v.id("llmProviders"), ...modelFields },
  handler: async (ctx, args) => {
    assertServiceToken(args.token);
    const provider = await ctx.db.get(args.providerId);
    if (!provider) throw new Error(`Provider connection not found: ${args.providerId}`);
    const modelId = args.modelId.trim();
    if (!modelId) throw new Error("Model identifier is required");
    // Plan 038: the CLI takes `-m provider/model`.
    if (isOpencodeConnection(provider) && !isOpencodeModelId(modelId)) {
      throw new Error(`OpenCode models are "provider/model" ids (got "${modelId.slice(0, 80)}")`);
    }
    const existing = await ctx.db
      .query("llmModels")
      .withIndex("by_provider_and_model", (q) =>
        q.eq("providerId", args.providerId).eq("modelId", modelId)
      )
      .first();
    if (existing) {
      throw new Error(
        `Model "${modelId}" is already registered for provider "${provider.name}"`
      );
    }
    await materializePositions(ctx);
    const now = Date.now();
    const id = await ctx.db.insert("llmModels", {
      providerId: args.providerId,
      position: nextPosition(await ctx.db.query("llmModels").collect()),
      modelId,
      displayName: args.displayName?.trim() || undefined,
      contextWindow: args.contextWindow,
      supportsTools: args.supportsTools,
      supportsReasoning: args.supportsReasoning,
      inputPricePer1k: args.inputPricePer1k,
      outputPricePer1k: args.outputPricePer1k,
      isAvailable: args.isAvailable ?? true,
      createdAt: now,
      updatedAt: now,
    });
    const { token: _token, ...fields } = args;
    await recordAudit(ctx, {
      action: "llmModel.create",
      target: `${provider.name} / ${modelId}`,
      details: { fields: setFields(fields) },
    });
    return id;
  },
});

export const update = mutation({
  args: {
    token: v.string(),
    id: v.id("llmModels"),
    modelId: v.optional(v.string()),
    displayName: v.optional(v.string()),
    contextWindow: v.optional(v.number()),
    supportsTools: v.optional(v.boolean()),
    supportsReasoning: v.optional(v.boolean()),
    inputPricePer1k: v.optional(v.number()),
    outputPricePer1k: v.optional(v.number()),
    isAvailable: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    assertServiceToken(args.token);
    const { token: _token, id, ...updates } = args;
    const doc = await ctx.db.get(id);
    if (!doc) throw new Error(`Model not found: ${id}`);
    if (updates.modelId !== undefined) {
      const modelId = updates.modelId.trim();
      if (!modelId) throw new Error("Model identifier is required");
      if (isOpencodeConnection(await ctx.db.get(doc.providerId)) && !isOpencodeModelId(modelId)) {
        throw new Error(`OpenCode models are "provider/model" ids (got "${modelId.slice(0, 80)}")`);
      }
      updates.modelId = modelId;
    }
    if (updates.displayName !== undefined) {
      updates.displayName = updates.displayName.trim() || undefined;
    }
    await ctx.db.patch(id, { ...updates, updatedAt: Date.now() });
    const changed = changedFields(doc as Record<string, unknown>, updates);
    if (changed.length) {
      await recordAudit(ctx, {
        action: "llmModel.update",
        target: updates.modelId ?? doc.modelId,
        details: { changed },
      });
    }
  },
});

export const remove = mutation({
  args: { token: v.string(), id: v.id("llmModels") },
  handler: async (ctx, args) => {
    assertServiceToken(args.token);
    const doc = await ctx.db.get(args.id);
    await ctx.db.delete(args.id);
    await recordAudit(ctx, { action: "llmModel.remove", target: doc?.modelId });
  },
});
