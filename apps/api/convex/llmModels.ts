import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { assertServiceToken } from "./authz";

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
    return docs.sort((a, b) => a.modelId.localeCompare(b.modelId));
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
    const now = Date.now();
    return await ctx.db.insert("llmModels", {
      providerId: args.providerId,
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
      updates.modelId = modelId;
    }
    if (updates.displayName !== undefined) {
      updates.displayName = updates.displayName.trim() || undefined;
    }
    await ctx.db.patch(id, { ...updates, updatedAt: Date.now() });
  },
});

export const remove = mutation({
  args: { token: v.string(), id: v.id("llmModels") },
  handler: async (ctx, args) => {
    assertServiceToken(args.token);
    await ctx.db.delete(args.id);
  },
});
