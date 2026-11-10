/**
 * Global LLM selection mode (plan 032): one choice for the whole app —
 * "fallback" or "round_robin" (lib/llmSelection.ts).
 *
 * The mode is a plain setting: no key material, no provider admin. It is
 * public like the rest of the app's settings (local single-user mode) and
 * crosses to the worker inside getRunContext.
 */
import { mutation, query } from "./_generated/server";
import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import type { DataModel } from "./_generated/dataModel";
import { v } from "convex/values";
import { llmSelectionModeValidator } from "./lib/contractValidators";
import {
  DEFAULT_LLM_SELECTION_MODE,
  normalizeSelectionMode,
  type LlmSelectionMode,
} from "./lib/llmSelection";

/** The stored mode, or the default when nothing was ever set. */
export const get = query({
  args: {},
  handler: async (ctx): Promise<{ mode: LlmSelectionMode }> => {
    return { mode: await loadSelectionMode(ctx) };
  },
});

/** Set the global mode (single row, upserted). */
export const set = mutation({
  args: { mode: llmSelectionModeValidator },
  handler: async (ctx, args): Promise<{ mode: LlmSelectionMode }> => {
    const mode = normalizeSelectionMode(args.mode);
    const existing = await ctx.db.query("llmSelectionSettings").first();
    if (existing) {
      await ctx.db.patch(existing._id, { mode, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("llmSelectionSettings", { mode, updatedAt: Date.now() });
    }
    return { mode };
  },
});

/**
 * Read the mode for a backend reader (the run context). Unknown values
 * fall back to the default; a deployment without a row is the default too.
 */
export async function loadSelectionMode(
  ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>
): Promise<LlmSelectionMode> {  const row = await ctx.db.query("llmSelectionSettings").first();
  return row ? normalizeSelectionMode(row.mode) : DEFAULT_LLM_SELECTION_MODE;
}
