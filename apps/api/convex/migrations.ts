import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
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

/**
 * Plan 039 (personal chat): stamp `kind: "project"` on conversations
 * created before `kind` existed. Ids are unchanged and no message is
 * rewritten (D10). Readers already treat a missing kind as "project", so
 * this is explicit bookkeeping and may run any time after the deploy.
 * Idempotent and batched: it reschedules itself until a pass finds nothing.
 *
 *   npx convex run migrations:backfillConversationKinds
 *   npx convex run migrations:verifyConversationKinds
 */
export const CONVERSATION_BACKFILL_BATCH = 200;

export const backfillConversationKinds = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), scanned: v.optional(v.number()), patched: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ scanned: number; patched: number; done: boolean; cursor: string | null }> => {
    const page = await ctx.db
      .query("conversations")
      .paginate({ cursor: args.cursor ?? null, numItems: CONVERSATION_BACKFILL_BATCH });
    let patched = args.patched ?? 0;
    for (const row of page.page) {
      if (row.kind === undefined) {
        await ctx.db.patch(row._id, { kind: "project" });
        patched += 1;
      }
    }
    const scanned = (args.scanned ?? 0) + page.page.length;
    const done = page.isDone;
    if (!done) {
      await ctx.scheduler.runAfter(0, internal.migrations.backfillConversationKinds, {
        cursor: page.continueCursor,
        scanned,
        patched,
      });
    }
    return { scanned, patched, done, cursor: done ? null : page.continueCursor };
  },
});

/**
 * Plan 039 invariants after the backfill. Every count except
 * `conversations` must be 0:
 *  - withoutKind: conversations still missing `kind` (backfill not finished);
 *  - personalWithoutAgent: personal rows with no agentId;
 *  - projectWithoutProject: project/team rows with no projectId;
 *  - personalMessagesWithProject: messages in a personal conversation that
 *    carry a projectId (D1 invariant).
 */
export const verifyConversationKinds = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("conversations").collect();
    let withoutKind = 0;
    let personalWithoutAgent = 0;
    let projectWithoutProject = 0;
    let personalMessagesWithProject = 0;
    let personal = 0;
    for (const row of rows) {
      if (row.kind === undefined) withoutKind += 1;
      if (row.kind === "personal") {
        personal += 1;
        if (!row.agentId) personalWithoutAgent += 1;
        const messages = await ctx.db
          .query("messages")
          .withIndex("by_conversation", (q) => q.eq("conversationId", row._id))
          .collect();
        personalMessagesWithProject += messages.filter((m) => m.projectId !== undefined).length;
      } else if (!row.projectId) {
        projectWithoutProject += 1;
      }
    }
    return {
      conversations: rows.length,
      personal,
      withoutKind,
      personalWithoutAgent,
      projectWithoutProject,
      personalMessagesWithProject,
      ok: withoutKind === 0 && personalWithoutAgent === 0 && projectWithoutProject === 0 && personalMessagesWithProject === 0,
    };
  },
});

/**
 * Plan 039 rollback helper, never scheduled automatically: deletes every
 * personal conversation with its participant rows and messages, one batch
 * per call (rerun until done). Only needed before narrowing
 * `conversations.projectId` / `messages.projectId` back to required, which
 * Convex refuses while a personal row exists. Export the data first.
 */
export const deletePersonalConversations = internalMutation({
  args: { confirm: v.literal("delete personal conversations") },
  handler: async (ctx): Promise<{ deletedConversations: number; deletedMessages: number; done: boolean }> => {
    const rows = await ctx.db
      .query("conversations")
      .withIndex("by_kind_and_last_message", (q) => q.eq("kind", "personal"))
      .take(20);
    let deletedMessages = 0;
    for (const row of rows) {
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_conversation", (q) => q.eq("conversationId", row._id))
        .collect();
      for (const m of messages) {
        await ctx.db.delete(m._id);
        deletedMessages += 1;
      }
      const participants = await ctx.db
        .query("conversationParticipants")
        .withIndex("by_conversation", (q) => q.eq("conversationId", row._id))
        .collect();
      for (const p of participants) await ctx.db.delete(p._id);
      await ctx.db.delete(row._id);
    }
    return { deletedConversations: rows.length, deletedMessages, done: rows.length < 20 };
  },
});

// ─── L4 (P1d): retire the per-agent LLM layers ────────────────────────────

/** Agent fields the global chain replaced (L4). Kept `v.optional` in the schema for one release. */
export const RETIRED_AGENT_LLM_FIELDS = [
  "llmProviderId",
  "llmModelId",
  "llmFallbackProviderId",
  "llmFallbackModelId",
  "llmSelectionPolicy",
  "executionRuntime",
  "opencodeModel",
] as const;

/** Template fields the global chain replaced (L4). */
export const RETIRED_TEMPLATE_LLM_FIELDS = ["llmProviderId", "llmModelId", "runtime", "opencodeModel"] as const;

export interface ClearedLlmField {
  table: "agents" | "agentTemplates";
  name: string;
  field: string;
  oldValue: string;
}

/** The retired fields a row still carries, as log entries (pure; empty = nothing to clear). */
export function retiredLlmFields(
  table: ClearedLlmField["table"],
  row: Record<string, unknown> & { name: string },
  fields: readonly string[]
): ClearedLlmField[] {
  return fields
    .filter((field) => row[field] !== undefined && row[field] !== null)
    .map((field) => ({ table, name: row.name, field, oldValue: String(row[field]) }));
}

/**
 * L4: clear the retired per-agent LLM fields (assignment, fallback,
 * selection policy, runtime, OpenCode model) on every agent and template,
 * and log each cleared value (table, name, field, old value). Idempotent:
 * a second run finds nothing and clears nothing. Run once after deploy:
 *   npx convex run migrations:clearPerAgentLlm
 */
export const clearPerAgentLlm = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ agentsCleared: number; templatesCleared: number; cleared: ClearedLlmField[] }> => {
    const cleared: ClearedLlmField[] = [];
    let agentsCleared = 0;
    let templatesCleared = 0;
    for (const agent of await ctx.db.query("agents").collect()) {
      const found = retiredLlmFields("agents", agent, RETIRED_AGENT_LLM_FIELDS);
      if (found.length === 0) continue;
      await ctx.db.patch(agent._id, Object.fromEntries(found.map((entry) => [entry.field, undefined])));
      cleared.push(...found);
      agentsCleared++;
    }
    for (const template of await ctx.db.query("agentTemplates").collect()) {
      const found = retiredLlmFields("agentTemplates", template, RETIRED_TEMPLATE_LLM_FIELDS);
      if (found.length === 0) continue;
      await ctx.db.patch(template._id, Object.fromEntries(found.map((entry) => [entry.field, undefined])));
      cleared.push(...found);
      templatesCleared++;
    }
    for (const entry of cleared) {
      console.log(`[L4 clearPerAgentLlm] ${entry.table} "${entry.name}": ${entry.field} = ${entry.oldValue} (cleared)`);
    }
    console.log(`[L4 clearPerAgentLlm] ${agentsCleared} agent(s), ${templatesCleared} template(s), ${cleared.length} field(s) cleared`);
    return { agentsCleared, templatesCleared, cleared };
  },
});
