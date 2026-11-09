import type { QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { decryptApiKey } from "./llmCrypto";

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
}

/**
 * Load the enabled provider pool: connections sorted by priority, each with
 * its registered models. A connection whose models have not been migrated
 * yet (no llmModels rows) exposes its legacy `model` column as a single
 * synthesized model so resolution keeps working during the transition.
 */
export async function loadProviderPool(
  ctx: QueryCtx
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
    });
    modelsByProvider.set(m.providerId, list);
  }

  const pool: PoolConnectionPayload[] = [];
  for (const p of providers) {
    if (p.isEnabled === false) continue;
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
    });
  }
  pool.sort((a, b) => a.priority - b.priority);
  return pool;
}

/**
 * The primary connection for agent-less callers (chat): the lowest-priority
 * connection that has at least one available model.
 */
export function pickPrimaryConnection(
  pool: PoolConnectionPayload[]
): { connection: PoolConnectionPayload; model: PoolModelPayload } | null {
  for (const connection of pool) {
    const model = connection.models.find((m) => m.isAvailable);
    if (model) return { connection, model };
  }
  return null;
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
  const env: Record<string, string | undefined> =
    (globalThis as any).process?.env ?? {};
  return env[connection.apiKeyEnv]?.trim() ?? "";
}
