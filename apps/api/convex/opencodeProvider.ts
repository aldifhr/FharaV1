/**
 * Plan 038: OpenCode as a provider in Settings → LLM & Models.
 *
 * The OpenCode CLI is a special `llmProviders` row (`provider: "opencode"`,
 * no base URL, no key; see lib/opencodeProvider.ts for the semantics). Its
 * models live in `llmModels` like every other model, so they take positions
 * in the one ordered list; adding, removing, reordering and toggling them
 * reuse the llmModels mutations.
 *
 * Detection (installed / version / path) and the "Test" probe come from the
 * worker through the token-gated catalog path (opencodeModels.ts); this
 * module only joins them with the provider row and the worker presence for
 * the Settings row.
 *
 * Backward compatibility with plan 035 (`opencodeSettings`): while no
 * OpenCode row exists, the old app-wide switch keeps deciding. The first
 * time the provider is enabled, a legacy "OpenCode CLI + model" setting is
 * carried over as the first entry of the list, and from then on the row
 * decides (the run context stops forwarding the legacy switch).
 */
import { mutation, query } from "./_generated/server";
import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import type { DataModel, Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import { assertServiceToken } from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";
import { isOpencodeConnection, OPENCODE_PROVIDER, OPENCODE_PROVIDER_NAME } from "./lib/opencodeProvider";
import { materializePositions } from "./llmModels";

/** A worker counts as online when it heartbeated this recently. */
const WORKER_FRESH_MS = 90_000;

type Ctx = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>;

/** The OpenCode provider row, when one was ever added. */
export async function findOpencodeRow(ctx: Ctx): Promise<Doc<"llmProviders"> | null> {
  const rows = await ctx.db.query("llmProviders").collect();
  return rows.find((row) => isOpencodeConnection(row)) ?? null;
}

export interface OpencodeProviderStatus {
  /** The row exists (the provider was added once). */
  configured: boolean;
  enabled: boolean;
  providerId: string | null;
  /** A worker heartbeated recently. */
  workerOnline: boolean;
  /** What the freshest worker found; null = never checked. */
  installed: boolean | null;
  version: string | null;
  path: string | null;
  error: string | null;
  checkedAt: number;
  hostname: string | null;
  /** A "Check again" the worker has not served yet. */
  pendingCheck: boolean;
  /** A "Test" the worker has not served yet. */
  pendingTest: boolean;
  test: { ok: boolean; latencyMs: number; model: string | null; error: string | null; at: number } | null;
  /** The plan 035 switch, for the carry-over hint. */
  legacy: { runtime: "api" | "opencode"; model: string } | null;
}

/** Everything the Settings row shows. Holds no credential material. */
export const status = query({
  args: {},
  handler: async (ctx): Promise<OpencodeProviderStatus> => {
    const row = await findOpencodeRow(ctx);
    const now = Date.now();
    const liveWorkers = await ctx.db
      .query("workers")
      .withIndex("by_status_and_heartbeat", (q) => q.eq("status", "online").gte("lastHeartbeatAt", now - WORKER_FRESH_MS))
      .take(1);
    const fresh = await ctx.db.query("opencodeModelCatalog").withIndex("by_updated_at").order("desc").first();
    const legacyRow = await ctx.db.query("opencodeSettings").first();
    const testAt = fresh?.testResult?.at ?? 0;
    return {
      configured: row !== null,
      enabled: row !== null && row.isEnabled !== false,
      providerId: row ? String(row._id) : null,
      workerOnline: liveWorkers.length > 0,
      installed: fresh ? (fresh.installed ?? fresh.available) : null,
      version: fresh?.version ?? null,
      path: fresh?.path ?? null,
      error: fresh?.error ?? null,
      checkedAt: fresh?.updatedAt ?? 0,
      hostname: fresh?.hostname ?? null,
      pendingCheck: (fresh?.refreshRequestedAt ?? 0) > 0 && (fresh?.refreshRequestedAt ?? 0) >= (fresh?.updatedAt ?? 0),
      pendingTest: (fresh?.testRequestedAt ?? 0) > 0 && (fresh?.testRequestedAt ?? 0) >= testAt,
      test: fresh?.testResult
        ? {
            ok: fresh.testResult.ok,
            latencyMs: fresh.testResult.latencyMs,
            model: fresh.testResult.model ?? null,
            error: fresh.testResult.error ?? null,
            at: fresh.testResult.at,
          }
        : null,
      legacy: legacyRow
        ? { runtime: legacyRow.runtime === "opencode" ? "opencode" : "api", model: legacyRow.model ?? "" }
        : null,
    };
  },
});

/**
 * Enable or disable the OpenCode provider. The first call creates the row
 * and carries a plan 035 "OpenCode CLI + model" setting over as the first
 * entry of the list, so a deployment that used the old switch keeps running
 * its tasks on OpenCode. Token-gated like every provider write (the
 * Settings UI reaches it through /api/llm-providers).
 */
export const setEnabled = mutation({
  args: { token: v.string(), enabled: v.boolean() },
  handler: async (ctx, args): Promise<{ providerId: string; carriedOver: string | null }> => {
    assertServiceToken(args.token);
    const now = Date.now();
    const existing = await findOpencodeRow(ctx);
    if (existing) {
      if ((existing.isEnabled !== false) !== args.enabled) {
        await ctx.db.patch(existing._id, { isEnabled: args.enabled, updatedAt: now });
        await recordAudit(ctx, {
          action: "llmProvider.update",
          target: existing.name,
          details: { changed: ["isEnabled"] },
        });
      }
      return { providerId: String(existing._id), carriedOver: null };
    }
    const providers = await ctx.db.query("llmProviders").collect();
    const id = await ctx.db.insert("llmProviders", {
      name: OPENCODE_PROVIDER_NAME,
      provider: OPENCODE_PROVIDER,
      presetId: OPENCODE_PROVIDER,
      model: "",
      baseUrl: "",
      apiKeyEnv: "",
      priority: providers.reduce((max, p) => Math.max(max, p.priority + 1), 0),
      weight: 100,
      isEnabled: args.enabled,
      createdAt: now,
      updatedAt: now,
    });
    let carriedOver: string | null = null;
    const legacy = await ctx.db.query("opencodeSettings").first();
    const legacyModel = (legacy?.model ?? "").trim();
    if (legacy?.runtime === "opencode" && legacyModel) {
      // The old switch ran EVERY task on OpenCode: keep that by putting the
      // model at the top of the list.
      await materializePositions(ctx);
      for (const model of await ctx.db.query("llmModels").collect()) {
        await ctx.db.patch(model._id, { position: (model.position ?? 0) + 1 });
      }
      await ctx.db.insert("llmModels", {
        providerId: id,
        modelId: legacyModel,
        isAvailable: true,
        position: 0,
        createdAt: now,
        updatedAt: now,
      });
      carriedOver = legacyModel;
    }
    await recordAudit(ctx, {
      action: "llmProvider.create",
      target: OPENCODE_PROVIDER_NAME,
      details: { fields: ["isEnabled"], ...(carriedOver ? { carriedOver } : {}) },
    });
    return { providerId: String(id), carriedOver };
  },
});

/**
 * The plan 035 switch the run context still forwards: only while no
 * OpenCode provider row exists. Once the row exists the ordered list
 * decides, so the worker gets the neutral "api" baseline (which also stops
 * a legacy per-agent `executionRuntime: "opencode"` or the env default from
 * taking over again).
 */
export async function effectiveLegacyOpencode(
  ctx: Ctx,
  legacy: { runtime: "api" | "opencode"; model: string } | null
): Promise<{ runtime: "api" | "opencode"; model: string } | null> {
  const row = await findOpencodeRow(ctx);
  if (row) return { runtime: "api", model: "" };
  return legacy;
}
