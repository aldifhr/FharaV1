/**
 * App-wide OpenCode runtime (plan 035).
 *
 * The OpenCode CLI, its credentials and its model list live on the worker
 * machine, so the choice "which runtime, which model" is one setting for the
 * whole app instead of a field on every agent. The agent form keeps the
 * Fhara LLM pickers (provider / model / fallback).
 *
 * One row, upserted, like llmSelection.ts. No key material: the model is a
 * `provider/model` id the CLI resolves with its own credentials. The worker
 * reads it through the run context.
 */
import { mutation, query } from "./_generated/server";
import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import type { DataModel } from "./_generated/dataModel";
import { v } from "convex/values";
import { normalizeOpencodeModel } from "./agents";
import { isOpencodeConnection } from "./lib/opencodeProvider";
import { assertRegistryWriteAccess } from "./lib/authz";

/** The runtime the app-wide setting selects. */
export type OpencodeRuntime = "api" | "opencode";

export interface OpencodeSettings {
  runtime: OpencodeRuntime;
  /** `provider/model`; empty = Fhara's own LLM. */
  model: string;
  /** False when no row was ever written (the worker falls back). */
  configured: boolean;
  /**
   * Plan 038: the OpenCode provider row exists, so the ordered model list
   * decides per subtask (OpenCode entry = OpenCode, API entry = built-in)
   * and this switch no longer applies.
   */
  viaModelList?: boolean;
}

/** Read the app-wide setting. */
export const get = query({
  args: {},
  handler: async (ctx): Promise<OpencodeSettings> => {
    const providerRows = await ctx.db.query("llmProviders").collect();
    if (providerRows.some((p) => isOpencodeConnection(p))) {
      return { runtime: "api", model: "", configured: true, viaModelList: true };
    }
    const row = await ctx.db.query("opencodeSettings").first();
    if (!row) return { runtime: "api", model: "", configured: false };
    return {
      runtime: row.runtime === "opencode" ? "opencode" : "api",
      model: row.model ?? "",
      configured: true,
    };
  },
});

/**
 * Set the app-wide setting. The model follows the same rule as the agent
 * field: `provider/model`, empty clears it (the CLI then uses Fhara's LLM).
 */
export const set = mutation({
  args: {
    runtime: v.union(v.literal("api"), v.literal("opencode")),
    model: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<OpencodeSettings> => {
    await assertRegistryWriteAccess(ctx);
    const model = normalizeOpencodeModel(args.model ?? "") ?? "";
    const existing = await ctx.db.query("opencodeSettings").first();
    if (existing) {
      await ctx.db.patch(existing._id, { runtime: args.runtime, model, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("opencodeSettings", { runtime: args.runtime, model, updatedAt: Date.now() });
    }
    return { runtime: args.runtime, model, configured: true };
  },
});

/**
 * Read the setting for a backend reader (the run context). No row = not
 * configured: the worker then keeps its legacy behaviour (the per-agent
 * value, then the env default).
 */
export async function loadOpencodeSettings(
  ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>
): Promise<{ runtime: OpencodeRuntime; model: string } | null> {
  const row = await ctx.db.query("opencodeSettings").first();
  if (!row) return null;
  return {
    runtime: row.runtime === "opencode" ? "opencode" : "api",
    model: row.model ?? "",
  };
}
