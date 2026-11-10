/**
 * Plan 034: the OpenCode model catalog.
 *
 * The OpenCode CLI knows which models it can run (`opencode models`), but
 * that list lives on the worker machine, behind the CLI's own credentials.
 * The worker reads it and publishes it here; the agent editor reads the
 * freshest row so the user picks a model id instead of typing one.
 *
 * The worker-facing path stays token-gated (`worker.ts` → `assertServiceToken`
 * → the internal functions below). The payload carries no credential
 * material: only model ids the CLI printed.
 */
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";

/** Hard cap on the ids one report may carry. */
const MAX_MODELS = 500;
/** Hard cap on one model id. */
const MAX_MODEL_LEN = 120;
/** Rows one read touches (workers are few; the cap bounds a runaway table). */
const MAX_CATALOG_ROWS = 20;

/** Keep only well-formed `provider/model` ids, de-duplicated, in order. */
export function normalizeCatalogModels(models: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of models) {
    const model = raw.trim().slice(0, MAX_MODEL_LEN);
    if (!model || !/^[A-Za-z0-9._-]+\/[^\s]+$/.test(model)) continue;
    if (seen.has(model)) continue;
    seen.add(model);
    out.push(model);
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

/**
 * Worker: publish the model list this CLI reported. Upserts by worker id and
 * clears a pending refresh request (the request has been served).
 */
export const report = internalMutation({
  args: {
    workerId: v.string(),
    hostname: v.optional(v.string()),
    models: v.array(v.string()),
    available: v.boolean(),
    error: v.optional(v.string()),
    command: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ models: number }> => {
    const models = normalizeCatalogModels(args.models);
    const existing = await ctx.db
      .query("opencodeModelCatalog")
      .withIndex("by_worker_id", (q) => q.eq("workerId", args.workerId))
      .unique();
    const payload = {
      hostname: args.hostname?.slice(0, 120),
      models,
      available: args.available,
      error: args.error ? args.error.slice(0, 300) : undefined,
      command: args.command?.slice(0, 120),
      updatedAt: Date.now(),
    };
    if (existing) {
      await ctx.db.patch(existing._id, { ...payload, refreshRequestedAt: undefined });
    } else {
      await ctx.db.insert("opencodeModelCatalog", { workerId: args.workerId, ...payload });
    }
    return { models: models.length };
  },
});

/**
 * Worker: what the UI asked for. `refreshRequestedAt > updatedAt` means the
 * user pressed "Refresh" and the worker has not served it yet.
 */
export const state = internalQuery({
  args: { workerId: v.string() },
  handler: async (ctx, args): Promise<{
    hasCatalog: boolean;
    available: boolean;
    updatedAt: number;
    refreshRequestedAt: number;
  }> => {
    const row = await ctx.db
      .query("opencodeModelCatalog")
      .withIndex("by_worker_id", (q) => q.eq("workerId", args.workerId))
      .unique();
    return {
      hasCatalog: row !== null,
      available: row?.available ?? false,
      updatedAt: row?.updatedAt ?? 0,
      refreshRequestedAt: row?.refreshRequestedAt ?? 0,
    };
  },
});

/**
 * The freshest catalog across workers. The UI shows this one; the worker
 * that runs a task is the one that reports, so the freshest row is the most
 * recent truth about what the CLI can run.
 */
export const list = query({
  args: {},
  handler: async (ctx): Promise<{
    models: string[];
    available: boolean;
    error: string | null;
    updatedAt: number;
    workerId: string | null;
    hostname: string | null;
    pendingRefresh: boolean;
    reportedWorkers: number;
  }> => {
    const rows = await ctx.db
      .query("opencodeModelCatalog")
      .withIndex("by_updated_at")
      .order("desc")
      .take(MAX_CATALOG_ROWS);
    const fresh = rows[0];
    return {
      models: fresh?.models ?? [],
      available: fresh?.available ?? false,
      error: fresh?.error ?? null,
      updatedAt: fresh?.updatedAt ?? 0,
      workerId: fresh?.workerId ?? null,
      hostname: fresh?.hostname ?? null,
      pendingRefresh: rows.some(
        (row) => (row.refreshRequestedAt ?? 0) > 0 && (row.refreshRequestedAt ?? 0) >= (row.updatedAt ?? 0)
      ),
      reportedWorkers: rows.length,
    };
  },
});

/**
 * UI: ask every worker to re-read its model list. The worker serves it on
 * its next poll and clears the request by reporting again.
 */
export const requestRefresh = mutation({
  args: {},
  handler: async (ctx): Promise<{ requested: number }> => {
    const now = Date.now();
    const rows = await ctx.db
      .query("opencodeModelCatalog")
      .withIndex("by_updated_at")
      .order("desc")
      .take(MAX_CATALOG_ROWS);
    for (const row of rows) {
      await ctx.db.patch(row._id, { refreshRequestedAt: now });
    }
    return { requested: rows.length };
  },
});
