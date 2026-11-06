import { action, internalQuery, query, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { assertServiceToken } from "./authz";

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

/**
 * Provider writes are admin operations: whoever controls baseUrl/apiKey
 * controls where the worker sends credentials (spec §9.3). They therefore
 * require the service token, exactly like the worker actions in worker.ts.
 * The web UI reaches them only through the server-side route
 * (apps/web/app/api/llm-providers), which holds the token on the server —
 * the browser never sees it. Read queries stay public and strip the key.
 */
export const create = mutation({
  args: {
    token: v.string(),
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
    assertServiceToken(args.token);
    const { token: _token, ...fields } = args;
    const id = await ctx.db.insert("llmProviders", {
      ...fields,
      weight: args.weight ?? 100,
      isEnabled: args.isEnabled ?? true,
      createdAt: Date.now(),
    });
    return id;
  },
});

export const updateProvider = mutation({
  args: {
    token: v.string(),
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
    assertServiceToken(args.token);
    const { id, token: _token, ...updates } = args;
    await ctx.db.patch(id, updates);
  },
});

export const remove = mutation({
  args: { token: v.string(), id: v.id("llmProviders") },
  handler: async (ctx, args) => {
    assertServiceToken(args.token);
    await ctx.db.delete(args.id);
  },
});

/**
 * Server-side "test connection / list models" for the Settings UI. Runs on
 * the backend so the browser never sends a provider key directly to an
 * arbitrary baseUrl: the key either comes from the saved provider row
 * (providerId) or is passed once by the caller (the Next server route) and
 * is never stored by this action.
 */
export const fetchModels = action({
  args: {
    token: v.string(),
    baseUrl: v.string(),
    providerId: v.optional(v.id("llmProviders")),
    apiKey: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<string[]> => {
    assertServiceToken(args.token);
    const base = args.baseUrl.trim().replace(/\/$/, "");
    if (!base) throw new Error("Base URL is required");
    let apiKey = args.apiKey?.trim() || undefined;
    if (!apiKey && args.providerId) {
      const providers: Array<{ _id: string; apiKey?: string }> =
        await ctx.runQuery(internal.llmProviders.getForProject, {});
      apiKey = providers.find((p) => p._id === args.providerId)?.apiKey;
    }
    if (!apiKey) {
      throw new Error(
        "An API key is required (enter one, or fetch models for a saved provider)"
      );
    }
    const res = await fetch(`${base}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Provider returned HTTP ${res.status}`);
    const data: any = await res.json();
    const ids: string[] = (data.data ?? data.models ?? [])
      .map((m: any) => (typeof m === "string" ? m : m?.id))
      .filter(Boolean);
    return [...new Set(ids)].sort();
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
