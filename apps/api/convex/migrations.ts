import { internalMutation, internalQuery } from "./_generated/server";
import { encryptApiKey, reEncryptApiKey } from "./lib/llmCrypto";

/**
 * Phase 2 data migration (spec §4B/§5.3) — internal, idempotent, safe to
 * re-run. Two effects:
 *
 * 1. Providers: the legacy single `model` column becomes a row in the
 *    `llmModels` registry, and a plaintext `apiKey` is encrypted into
 *    `apiKeyCiphertext` (AES-256-GCM) and then CLEARED from the document.
 * 2. Agents: rows still carrying pre-global-LLM fields
 *    (llmProvider/llmModel/llmBaseUrl/llmApiKeyEnv/llmApiKey) are linked to
 *    a real provider connection through the new assignment fields
 *    (llmProviderId/llmModelId). A plaintext legacy agent key is encrypted
 *    onto its connection (first key wins if several agents share one
 *    connection), then every legacy field is cleared.
 *
 * Follow-up deploy step (NOT done here, by design): once this migration is
 * verified (`verifyMigration` reports zero plaintext anywhere), a separate
 * schema deploy can drop `llmProviders.apiKey`, `llmProviders.model` and
 * the agents legacy columns.
 */

interface MigrationSummary {
  providersProcessed: number;
  modelsCreated: number;
  keysEncrypted: number;
  plaintextKeysCleared: number;
  agentsProcessed: number;
  agentsLinked: number;
  legacyKeysOntoConnections: number;
  legacyKeysSkipped: number;
  connectionsCreated: number;
}

export const migrateProvidersAndAgents = internalMutation({
  args: {},
  handler: async (ctx): Promise<MigrationSummary> => {
    const now = Date.now();
    const summary: MigrationSummary = {
      providersProcessed: 0,
      modelsCreated: 0,
      keysEncrypted: 0,
      plaintextKeysCleared: 0,
      agentsProcessed: 0,
      agentsLinked: 0,
      legacyKeysOntoConnections: 0,
      legacyKeysSkipped: 0,
      connectionsCreated: 0,
    };

    const providers = await ctx.db.query("llmProviders").collect();
    // connectionId -> whether it already holds an encrypted key (this run).
    const connectionHasKey = new Map<string, boolean>();

    const ensureModelRow = async (
      providerId: (typeof providers)[number]["_id"],
      modelId: string
    ) => {
      const existing = await ctx.db
        .query("llmModels")
        .withIndex("by_provider_and_model", (q) =>
          q.eq("providerId", providerId).eq("modelId", modelId)
        )
        .first();
      if (existing) return existing._id;
      summary.modelsCreated++;
      return await ctx.db.insert("llmModels", {
        providerId,
        modelId,
        isAvailable: true,
        createdAt: now,
        updatedAt: now,
      });
    };

    for (const provider of providers) {
      summary.providersProcessed++;
      connectionHasKey.set(
        provider._id,
        Boolean(provider.apiKeyCiphertext || provider.apiKey)
      );
      const patch: Record<string, unknown> = {};
      if (provider.updatedAt === undefined) patch.updatedAt = provider.createdAt ?? now;
      if (provider.model?.trim()) {
        await ensureModelRow(provider._id, provider.model.trim());
      }
      if (provider.apiKey) {
        if (!provider.apiKeyCiphertext) {
          patch.apiKeyCiphertext = await encryptApiKey(provider.apiKey);
          summary.keysEncrypted++;
          connectionHasKey.set(provider._id, true);
        }
        patch.apiKey = undefined;
        summary.plaintextKeysCleared++;
      }
      if (Object.keys(patch).length > 0) await ctx.db.patch(provider._id, patch);
    }

    const agents = await ctx.db.query("agents").collect();
    const hasLegacy = (a: (typeof agents)[number]) =>
      Boolean(a.llmApiKey || a.llmProvider || a.llmModel || a.llmBaseUrl || a.llmApiKeyEnv);

    let legacyConnectionId: (typeof providers)[number]["_id"] | null = null;
    const findOrCreateLegacyConnection = async (
      agent: (typeof agents)[number]
    ): Promise<(typeof providers)[number]["_id"]> => {
      // Prefer an existing connection that matches the legacy coordinates.
      const all = await ctx.db.query("llmProviders").collect();
      const match = all.find(
        (p) =>
          (agent.llmBaseUrl && p.baseUrl === agent.llmBaseUrl) ||
          (agent.llmProvider && p.provider === agent.llmProvider && !agent.llmBaseUrl)
      );
      if (match) return match._id;
      if (legacyConnectionId) return legacyConnectionId;
      const maxPriority = all.reduce((max, p) => Math.max(max, p.priority), 0);
      legacyConnectionId = await ctx.db.insert("llmProviders", {
        name: "Legacy (migrated)",
        provider: agent.llmProvider ?? "openai-compatible",
        model: agent.llmModel ?? "",
        baseUrl: agent.llmBaseUrl ?? "",
        apiKeyEnv: agent.llmApiKeyEnv ?? "LLM_API_KEY",
        priority: maxPriority + 10,
        weight: 100,
        isEnabled: true,
        createdAt: now,
        updatedAt: now,
      });
      summary.connectionsCreated++;
      connectionHasKey.set(legacyConnectionId, false);
      return legacyConnectionId;
    };

    for (const agent of agents) {
      if (!hasLegacy(agent)) continue;
      summary.agentsProcessed++;
      const connectionId = await findOrCreateLegacyConnection(agent);

      if (agent.llmApiKey) {
        if (!connectionHasKey.get(connectionId)) {
          await ctx.db.patch(connectionId, {
            apiKeyCiphertext: await encryptApiKey(agent.llmApiKey),
            updatedAt: now,
          });
          connectionHasKey.set(connectionId, true);
          summary.legacyKeysOntoConnections++;
        } else {
          summary.legacyKeysSkipped++;
        }
      }

      let modelRowId: (typeof agents)[number]["llmModelId"];
      if (agent.llmModel?.trim()) {
        modelRowId = await ensureModelRow(connectionId, agent.llmModel.trim());
      }

      await ctx.db.patch(agent._id, {
        ...(agent.llmProviderId ? {} : { llmProviderId: connectionId }),
        ...(modelRowId && !agent.llmModelId ? { llmModelId: modelRowId } : {}),
        llmApiKey: undefined,
        llmApiKeyEnv: undefined,
        llmBaseUrl: undefined,
        llmModel: undefined,
        llmProvider: undefined,
      });
      summary.agentsLinked++;
    }

    return summary;
  },
});

/**
 * Post-migration verification: counts only — never returns key material.
 * `providersWithPlaintextKey` and `agentsWithPlaintextKey` must both be 0
 * before the follow-up schema deploy drops the legacy columns.
 */
export const verifyMigration = internalQuery({
  args: {},
  handler: async (ctx) => {
    const providers = await ctx.db.query("llmProviders").collect();
    const models = await ctx.db.query("llmModels").collect();
    const agents = await ctx.db.query("agents").collect();
    return {
      providersTotal: providers.length,
      providersWithPlaintextKey: providers.filter((p) => Boolean(p.apiKey)).length,
      providersWithCiphertext: providers.filter((p) => Boolean(p.apiKeyCiphertext)).length,
      providersWithoutAnyKey: providers.filter(
        (p) => !p.apiKey && !p.apiKeyCiphertext
      ).length,
      modelsTotal: models.length,
      agentsTotal: agents.length,
      agentsWithPlaintextKey: agents.filter((a) => Boolean(a.llmApiKey)).length,
      agentsWithAnyLegacyField: agents.filter((a) =>
        Boolean(a.llmApiKey || a.llmProvider || a.llmModel || a.llmBaseUrl || a.llmApiKeyEnv)
      ).length,
      agentsWithAssignment: agents.filter((a) => Boolean(a.llmProviderId)).length,
    };
  },
});

/**
 * Credential rotation (spec §5): re-encrypt every stored provider key from
 * `PROVIDER_ENCRYPTION_KEY_OLD` to the current `PROVIDER_ENCRYPTION_KEY`.
 * Procedure: set the new key as PROVIDER_ENCRYPTION_KEY on BOTH the Convex
 * deployment and the worker, set the old key as PROVIDER_ENCRYPTION_KEY_OLD
 * on the deployment, run this mutation, then remove the _OLD variable.
 */
export const rotateEncryptionKeys = internalMutation({
  args: {},
  handler: async (ctx) => {
    const providers = await ctx.db.query("llmProviders").collect();
    let rotated = 0;
    for (const provider of providers) {
      if (!provider.apiKeyCiphertext) continue;
      await ctx.db.patch(provider._id, {
        apiKeyCiphertext: await reEncryptApiKey(provider.apiKeyCiphertext, provider.name),
        updatedAt: Date.now(),
      });
      rotated++;
    }
    return { rotated };
  },
});
