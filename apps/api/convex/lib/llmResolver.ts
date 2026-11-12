import { isSafeApiKeyEnv } from "./apiKeyEnv";
import type { QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { decryptApiKey } from "./llmCrypto";
import { normalizeSelectionMode, type LlmSelectionMode } from "./llmSelection";
import { isOpencodeConnection } from "./opencodeProvider";
import { normalizeModelTiers, type ModelTiers } from "./modelTiers";
import { cenvParse, cenvRaw } from "@fhara/config/convex";

/**
 * Backend provider-pool assembly (spec §4) — the single place where
 * provider connections + the model registry are joined into the payload
 * consumed by trusted internal callers (worker run context, chat context,
 * model discovery). Previously this join was duplicated in
 * orchestration.ts, chatContext.ts and llmProviders.ts, and it forwarded
 * the PLAINTEXT apiKey; it now forwards only `apiKeyCiphertext`
 * (AES-256-GCM, see llmCrypto.ts) — decryption happens either here for
 * backend-side use (chat) or on the worker with its own key copy.
 *
 * The worker has its own resolver implementation
 * (packages/worker/src/llm/resolver.ts) over this same payload contract:
 * the Convex runtime cannot import worker code, so two thin
 * implementations over one data contract are a deliberate platform
 * consequence (PLAN Phase 2).
 */

export interface PoolModelPayload {
  _id?: Id<"llmModels">;
  modelId: string;
  displayName?: string;
  contextWindow?: number;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  inputPricePer1k?: number;
  outputPricePer1k?: number;
  isAvailable: boolean;
  /** Place in the one model list (lib/llmOrder.ts). Unset on legacy rows. */
  position?: number;
  /** True when synthesized from the legacy `model` column (pre-migration row). */
  legacy?: boolean;
}

export interface PoolConnectionPayload {
  _id: Id<"llmProviders">;
  name: string;
  provider: string;
  /**
   * Transitional compat: the first available modelId. Pre-Phase-2 consumers
   * read `model` directly off the provider row; it stays populated until
   * every consumer reads `models`.
   */
  model: string;
  baseUrl: string;
  apiKeyEnv: string;
  /** @deprecated Legacy plaintext key. Read only as fallback until migration. */
  apiKey?: string;
  apiKeyCiphertext?: string;
  priority: number;
  weight: number;
  modelPatterns?: string[];
  isEnabled?: boolean;
  models: PoolModelPayload[];
  /**
   * The app-wide selection mode (plan 032), repeated on every row so a
   * caller that only holds the pool array (backend chat) orders and
   * rotates it the same way the worker does. No credential material.
   */
  selectionMode?: LlmSelectionMode;
  /**
   * L4: the project's model per role, repeated on every row ONLY when
   * FHARA_LLM_ROLE_OVERRIDE is on and the caller named a project. Absent
   * means the global chain alone (lib/llmChain.ts orderChain).
   */
  roleTiers?: ModelTiers;
}

/** L4: FHARA_LLM_ROLE_OVERRIDE — the Settings value, else the Convex env (default off). */
export async function roleOverrideOn(ctx: QueryCtx): Promise<boolean> {
  const row = await ctx.db.query("appSettings").first();
  const stored = row?.values?.find((entry) => entry.key === "FHARA_LLM_ROLE_OVERRIDE")?.value;
  return cenvParse("FHARA_LLM_ROLE_OVERRIDE", stored || cenvRaw("FHARA_LLM_ROLE_OVERRIDE"));
}

/** L4: the project's tiers when the override is on, else undefined (tiers ignored). */
export async function activeRoleTiers(ctx: QueryCtx, projectId: Id<"projects"> | undefined): Promise<ModelTiers | undefined> {
  if (!projectId || !(await roleOverrideOn(ctx))) return undefined;
  const tiers = normalizeModelTiers((await ctx.db.get(projectId))?.modelTiers);
  return Object.keys(tiers).length > 0 ? tiers : undefined;
}

/**
 * Load the enabled provider pool: connections sorted by priority, each with
 * its registered models. A connection whose models have not been migrated
 * yet (no llmModels rows) exposes its legacy `model` column as a single
 * synthesized model so resolution keeps working during the transition.
 *
 * Plan 038: the OpenCode row (lib/opencodeProvider.ts) is NOT an HTTP
 * connection, so it is left out unless the caller runs tasks on the worker
 * (`includeOpencode`, the run context only). Chat, review and every other
 * backend LLM call never see it.
 */
export async function loadProviderPool(
  ctx: QueryCtx,
  options: { includeDisabled?: boolean; includeOpencode?: boolean; projectId?: Id<"projects"> } = {}
): Promise<PoolConnectionPayload[]> {
  const providers = await ctx.db.query("llmProviders").collect();
  const modelDocs = await ctx.db.query("llmModels").collect();
  const modelsByProvider = new Map<string, PoolModelPayload[]>();
  for (const m of modelDocs) {
    const list = modelsByProvider.get(m.providerId) ?? [];
    list.push({
      _id: m._id,
      modelId: m.modelId,
      displayName: m.displayName,
      contextWindow: m.contextWindow,
      supportsTools: m.supportsTools,
      supportsReasoning: m.supportsReasoning,
      inputPricePer1k: m.inputPricePer1k,
      outputPricePer1k: m.outputPricePer1k,
      isAvailable: m.isAvailable,
      ...(typeof m.position === "number" ? { position: m.position } : {}),
    });
    modelsByProvider.set(m.providerId, list);
  }

  const settings = await ctx.db.query("llmSelectionSettings").first();
  const selectionMode = normalizeSelectionMode(settings?.mode);
  const roleTiers = await activeRoleTiers(ctx, options.projectId);
  const pool: PoolConnectionPayload[] = [];
  for (const p of providers) {
    if (p.isEnabled === false && !options.includeDisabled) continue;
    if (isOpencodeConnection(p) && !options.includeOpencode) continue;
    let models = modelsByProvider.get(p._id) ?? [];
    if (models.length === 0 && p.model) {
      models = [{ modelId: p.model, isAvailable: true, legacy: true }];
    }
    pool.push({
      _id: p._id,
      name: p.name,
      provider: p.provider,
      model: models.find((m) => m.isAvailable)?.modelId ?? p.model ?? "",
      baseUrl: p.baseUrl,
      apiKeyEnv: p.apiKeyEnv,
      apiKeyCiphertext: p.apiKeyCiphertext,
      priority: p.priority,
      weight: p.weight,
      modelPatterns: p.modelPatterns,
      isEnabled: p.isEnabled,
      models,
      selectionMode,
      ...(roleTiers ? { roleTiers } : {}),
    });
  }
  pool.sort((a, b) => a.priority - b.priority);
  return pool;
}

/**
 * Resolve the usable plaintext key for a connection, for TRUSTED
 * backend-side use only (chat completions, model discovery). Decrypts the
 * stored ciphertext — a decryption failure is a hard error naming the
 * provider — then falls back to the legacy plaintext `apiKey` column, then
 * to the env var named by `apiKeyEnv`. The result must never leave the
 * backend.
 */
export async function resolveConnectionKey(
  connection: Pick<PoolConnectionPayload, "name" | "apiKey" | "apiKeyEnv" | "apiKeyCiphertext">
): Promise<string> {
  if (connection.apiKeyCiphertext) {
    return await decryptApiKey(connection.apiKeyCiphertext, connection.name);
  }
  if (connection.apiKey) {
    return connection.apiKey.trim();
  }
  // Never read a platform secret by name (release audit P0-3), even from
  // a row written before apiKeyEnv was validated.
  if (!isSafeApiKeyEnv(connection.apiKeyEnv)) return "";
  const env: Record<string, string | undefined> =
    (globalThis as any).process?.env ?? {};
  return env[connection.apiKeyEnv]?.trim() ?? "";
}
