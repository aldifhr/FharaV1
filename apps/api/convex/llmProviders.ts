import { internalQuery, query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db.query("llmProviders").collect();
    return docs.map(({ apiKey, ...p }) => ({ ...p, apiKeyConfigured: Boolean(apiKey) }));
  },
});

export const get = query({
  args: {},
  handler: async (ctx) => {
    const enabled = await ctx.db.query("llmProviders").collect();
    return enabled
      .filter((p) => p.isEnabled !== false)
      .map(({ apiKey, ...p }) => ({ ...p, apiKeyConfigured: Boolean(apiKey) }));
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    provider: v.string(),
    model: v.string(),
    baseUrl: v.string(),
    apiKeyEnv: v.string(),
    apiKey: v.optional(v.string()),
    priority: v.number(),
    weight: v.optional(v.number()),
    modelPatterns: v.optional(v.array(v.string())),
    isEnabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("llmProviders", {
      ...args,
      weight: args.weight ?? 100,
      isEnabled: args.isEnabled ?? true,
      createdAt: Date.now(),
    });
    return id;
  },
});

export const updateProvider = mutation({
  args: {
    id: v.id("llmProviders"),
    name: v.optional(v.string()),
    provider: v.optional(v.string()),
    model: v.optional(v.string()),
    baseUrl: v.optional(v.string()),
    apiKeyEnv: v.optional(v.string()),
    apiKey: v.optional(v.string()),
    priority: v.optional(v.number()),
    weight: v.optional(v.number()),
    modelPatterns: v.optional(v.array(v.string())),
    isEnabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { id, ...updates } = args;
    await ctx.db.patch(id, updates);
  },
});

export const remove = mutation({
  args: { id: v.id("llmProviders") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});

export const getForProject = internalQuery({
  args: { projectId: v.optional(v.id("projects")) },
  handler: async (ctx) => {
    const providers = await ctx.db.query("llmProviders").collect();
    return providers
      .filter((p) => p.isEnabled !== false)
      .sort((a, b) => a.priority - b.priority);
  },
});
