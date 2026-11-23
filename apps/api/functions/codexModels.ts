/** Plan 075: model ids discovered from the worker's signed-in Codex CLI. */
import { internalMutation, internalQuery, mutation, query } from "@fhara/runtime/functions";
import { v } from "@fhara/runtime/values";

const MAX_MODELS = 500;
const MAX_ROWS = 20;

export function normalizeCodexModels(models: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of models) {
    const model = raw.trim().slice(0, 120);
    if (!model || !/^[A-Za-z0-9._-]+$/.test(model) || seen.has(model)) continue;
    seen.add(model);
    normalized.push(model);
    if (normalized.length >= MAX_MODELS) break;
  }
  return normalized;
}

export const report = internalMutation({
  args: {
    workerId: v.string(),
    hostname: v.optional(v.string()),
    models: v.array(v.string()),
    available: v.boolean(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ models: number }> => {
    const models = normalizeCodexModels(args.models);
    const row = await ctx.db.query("codexModelCatalog")
      .withIndex("by_worker_id", (q) => q.eq("workerId", args.workerId)).unique();
    const payload = {
      hostname: args.hostname?.slice(0, 120),
      models,
      available: args.available,
      error: args.error?.slice(0, 240),
      updatedAt: Date.now(),
    };
    if (row) await ctx.db.patch(row._id, { ...payload, refreshRequestedAt: undefined });
    else await ctx.db.insert("codexModelCatalog", { workerId: args.workerId, ...payload });
    return { models: models.length };
  },
});

export const state = internalQuery({
  args: { workerId: v.string() },
  handler: async (ctx, args): Promise<{
    hasCatalog: boolean;
    updatedAt: number;
    refreshRequestedAt: number;
  }> => {
    const row = await ctx.db.query("codexModelCatalog")
      .withIndex("by_worker_id", (q) => q.eq("workerId", args.workerId)).unique();
    return {
      hasCatalog: row !== null,
      updatedAt: row?.updatedAt ?? 0,
      refreshRequestedAt: row?.refreshRequestedAt ?? 0,
    };
  },
});

export const list = query({
  args: {},
  handler: async (ctx): Promise<{
    models: string[];
    available: boolean;
    error: string | null;
    updatedAt: number;
    pendingRefresh: boolean;
    reportedWorkers: number;
  }> => {
    const rows = await ctx.db.query("codexModelCatalog")
      .withIndex("by_updated_at").order("desc").take(MAX_ROWS);
    const latest = rows[0];
    return {
      models: latest?.models ?? [],
      available: latest?.available ?? false,
      error: latest?.error ?? null,
      updatedAt: latest?.updatedAt ?? 0,
      pendingRefresh: rows.some((row) =>
        (row.refreshRequestedAt ?? 0) > 0 && (row.refreshRequestedAt ?? 0) >= row.updatedAt
      ),
      reportedWorkers: rows.length,
    };
  },
});

export const requestRefresh = mutation({
  args: {},
  handler: async (ctx): Promise<{ requested: number }> => {
    const rows = await ctx.db.query("codexModelCatalog")
      .withIndex("by_updated_at").order("desc").take(MAX_ROWS);
    const now = Date.now();
    for (const row of rows) await ctx.db.patch(row._id, { refreshRequestedAt: now });
    return { requested: rows.length };
  },
});
