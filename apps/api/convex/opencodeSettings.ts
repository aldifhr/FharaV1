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

/** Plan 057: which provider CLI the native runtime spawns. */
export type NativeProviderDriver = "opencode" | "codex";

export interface OpencodeSettings {
  runtime: OpencodeRuntime;
  /** `provider/model`; empty = Fhara's own LLM. */
  model: string;
  /** Plan 057: the CLI behind `native-provider`; defaults to OpenCode. */
  driver: NativeProviderDriver;
  /** False when no row was ever written (the worker falls back). */
  configured: boolean;
  /**
   * Plan 038: the OpenCode provider row exists, so the ordered model list
   * decides per subtask (OpenCode entry = OpenCode, API entry = built-in)
   * and this switch no longer applies.
   */
  viaModelList?: boolean;
}

function driverOf(value: string | undefined): NativeProviderDriver {
  return value === "codex" ? "codex" : "opencode";
}

/** Read the app-wide setting. */
export const get = query({
  args: {},
  handler: async (ctx): Promise<OpencodeSettings> => {
    const providerRows = await ctx.db.query("llmProviders").collect();
    if (providerRows.some((p) => isOpencodeConnection(p))) {
      const row = await ctx.db.query("opencodeSettings").first();
      return {
        runtime: "api",
        model: "",
        driver: driverOf(row?.driver),
        configured: true,
        viaModelList: true,
      };
    }
    const row = await ctx.db.query("opencodeSettings").first();
    if (!row) return { runtime: "api", model: "", driver: "opencode", configured: false };
    return {
      runtime: row.runtime === "opencode" ? "opencode" : "api",
      model: row.model ?? "",
      driver: driverOf(row.driver),
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
    driver: v.optional(v.union(v.literal("opencode"), v.literal("codex"))),
  },
  handler: async (ctx, args): Promise<OpencodeSettings> => {
    await assertRegistryWriteAccess(ctx);
    const model = normalizeOpencodeModel(args.model ?? "") ?? "";
    const driver = driverOf(args.driver);
    const existing = await ctx.db.query("opencodeSettings").first();
    if (existing) {
      await ctx.db.patch(existing._id, { runtime: args.runtime, model, driver, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("opencodeSettings", { runtime: args.runtime, model, driver, updatedAt: Date.now() });
    }
    return { runtime: args.runtime, model, driver, configured: true };
  },
});

/**
 * Plan 057: pick the provider CLI without touching the runtime or the model.
 * Upserts the same single row, so an older deployment gets one when the
 * operator first chooses Codex.
 */
export const setDriver = mutation({
  args: { driver: v.union(v.literal("opencode"), v.literal("codex")) },
  handler: async (ctx, args): Promise<OpencodeSettings> => {
    await assertRegistryWriteAccess(ctx);
    const existing = await ctx.db.query("opencodeSettings").first();
    if (existing) {
      await ctx.db.patch(existing._id, { driver: args.driver, updatedAt: Date.now() });
      return {
        runtime: existing.runtime === "opencode" ? "opencode" : "api",
        model: existing.model ?? "",
        driver: args.driver,
        configured: true,
      };
    }
    await ctx.db.insert("opencodeSettings", {
      runtime: "api",
      model: "",
      driver: args.driver,
      updatedAt: Date.now(),
    });
    return { runtime: "api", model: "", driver: args.driver, configured: true };
  },
});

/**
 * Read the setting for a backend reader (the run context). No row = not
 * configured: the worker then keeps its legacy behaviour (the per-agent
 * value, then the env default).
 */
export async function loadOpencodeSettings(
  ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>
): Promise<{ runtime: OpencodeRuntime; model: string; driver: NativeProviderDriver } | null> {
  const row = await ctx.db.query("opencodeSettings").first();
  if (!row) return null;
  return {
    runtime: row.runtime === "opencode" ? "opencode" : "api",
    model: row.model ?? "",
    driver: driverOf(row.driver),
  };
}
