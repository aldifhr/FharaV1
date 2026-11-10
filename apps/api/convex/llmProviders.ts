import { action, internalQuery, query, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { assertServiceToken } from "./lib/authz";
import { assertSafeApiKeyEnv, isSafeApiKeyEnv } from "./lib/apiKeyEnv";
import { changedFields, recordAudit, setFields } from "./lib/recordAudit";
import { encryptApiKey, decryptApiKey } from "./lib/llmCrypto";
import { loadProviderPool, type PoolConnectionPayload } from "./lib/llmResolver";
import { listProviderModels } from "./lib/llmModelList";
import { nextPosition } from "./lib/llmOrder";
import { materializePositions } from "./llmModels";

/**
 * Whether this deployment can store a provider key: the Convex env has a
 * PROVIDER_ENCRYPTION_KEY. Settings shows a setup hint instead of a raw
 * error when it does not. Returns a boolean only, never the value.
 */
export const encryptionStatus = query({
  args: {},
  handler: async (): Promise<{ configured: boolean }> => {
    const env: Record<string, string | undefined> = (globalThis as any).process?.env ?? {};
    return { configured: Boolean(env.PROVIDER_ENCRYPTION_KEY?.trim()) };
  },
});

/**
 * Public view of a provider connection: NEVER includes credential material
 * in any form — neither the (legacy) plaintext `apiKey` nor the
 * `apiKeyCiphertext`. The frontend only learns whether a key is configured
 * (spec §5: write-only credentials, expose only `apiKeyConfigured`).
 */
export function toPublicProvider<T extends { apiKey?: string; apiKeyCiphertext?: string }>(
  doc: T
): Omit<T, "apiKey" | "apiKeyCiphertext"> & { apiKeyConfigured: boolean } {
  const { apiKey, apiKeyCiphertext, ...rest } = doc;
  return { ...rest, apiKeyConfigured: Boolean(apiKeyCiphertext || apiKey) };
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db.query("llmProviders").collect();
    return docs.map(toPublicProvider);
  },
});

export const get = query({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db.query("llmProviders").collect();
    return docs.filter((p) => p.isEnabled !== false).map(toPublicProvider);
  },
});

/**
 * Provider writes are admin operations: whoever controls baseUrl/apiKey
 * controls where the worker sends credentials (spec §9.3). They therefore
 * require the service token, exactly like the worker actions in worker.ts.
 * The web UI reaches them only through the server-side route
 * (apps/web/app/api/llm-providers), which holds the token on the server —
 * the browser never sees it. Read queries stay public and strip the key.
 *
 * Keys are encrypted at write time (AES-256-GCM, lib/llmCrypto.ts) and stored
 * ONLY as `apiKeyCiphertext`; plaintext is never persisted by new writes.
 */
export const create = mutation({
  args: {
    token: v.string(),
    name: v.string(),
    provider: v.string(),
    model: v.string(),
    baseUrl: v.string(),
    apiKeyEnv: v.string(),
    apiKey: v.optional(v.string()),
    /** Unset = after every existing connection (Settings orders models, not connections). */
    priority: v.optional(v.number()),
    weight: v.optional(v.number()),
    modelPatterns: v.optional(v.array(v.string())),
    isEnabled: v.optional(v.boolean()),
    presetId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertServiceToken(args.token);
    assertSafeApiKeyEnv(args.apiKeyEnv);
    const { token: _token, apiKey, ...fields } = args;
    const now = Date.now();
    const existingProviders = await ctx.db.query("llmProviders").collect();
    const priority =
      args.priority ??
      existingProviders.reduce((max, p) => Math.max(max, p.priority + 1), 0);
    const id = await ctx.db.insert("llmProviders", {
      ...fields,
      priority,
      weight: args.weight ?? 100,
      isEnabled: args.isEnabled ?? true,
      ...(apiKey ? { apiKeyCiphertext: await encryptApiKey(apiKey) } : {}),
      createdAt: now,
      updatedAt: now,
    });
    // Seed the registry with the connection's initial model (§4B); more
    // models are managed through llmModels mutations.
    const modelId = args.model.trim();
    if (modelId) {
      // Appended at the end of the one model list (lib/llmOrder.ts).
      await materializePositions(ctx);
      await ctx.db.insert("llmModels", {
        providerId: id,
        modelId,
        isAvailable: true,
        position: nextPosition(await ctx.db.query("llmModels").collect()),
        createdAt: now,
        updatedAt: now,
      });
    }
    // Field names only: `apiKey` appears as a name, never its value.
    await recordAudit(ctx, {
      action: "llmProvider.create",
      target: args.name,
      details: { fields: setFields({ ...fields, apiKey: apiKey ? "set" : undefined }) },
    });
    return id;
  },
});

export const updateProvider = mutation({
  args: {
    token: v.string(),
    id: v.id("llmProviders"),
    name: v.optional(v.string()),
    provider: v.optional(v.string()),
    model: v.optional(v.string()),
    baseUrl: v.optional(v.string()),
    apiKeyEnv: v.optional(v.string()),
    apiKey: v.optional(v.string()),
    priority: v.optional(v.number()),
    weight: v.optional(v.number()),
    modelPatterns: v.optional(v.array(v.string())),
    isEnabled: v.optional(v.boolean()),
    presetId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertServiceToken(args.token);
    if (args.apiKeyEnv !== undefined) assertSafeApiKeyEnv(args.apiKeyEnv);
    const { id, token: _token, apiKey, ...updates } = args;
    const before = await ctx.db.get(id);
    await ctx.db.patch(id, {
      ...updates,
      // Write-only credential update: a provided key replaces the stored
      // ciphertext; any legacy plaintext copy is cleared in the same write.
      ...(apiKey
        ? { apiKeyCiphertext: await encryptApiKey(apiKey), apiKey: undefined }
        : {}),
      updatedAt: Date.now(),
    });
    // Keep the registry in step when the connection's model changes:
    // register the model if this connection does not offer it yet.
    if (updates.model?.trim()) {
      const modelId = updates.model.trim();
      const existing = await ctx.db
        .query("llmModels")
        .withIndex("by_provider_and_model", (q) =>
          q.eq("providerId", id).eq("modelId", modelId)
        )
        .first();
      if (!existing) {
        const now = Date.now();
        await materializePositions(ctx);
        await ctx.db.insert("llmModels", {
          providerId: id,
          modelId,
          isAvailable: true,
          position: nextPosition(await ctx.db.query("llmModels").collect()),
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    const changed = changedFields(before as Record<string, unknown> | null, updates);
    if (apiKey) changed.push("apiKey");
    if (changed.length) {
      await recordAudit(ctx, {
        action: "llmProvider.update",
        target: updates.name ?? before?.name,
        details: { changed: changed.sort() },
      });
    }
  },
});

export const remove = mutation({
  args: { token: v.string(), id: v.id("llmProviders") },
  handler: async (ctx, args) => {
    assertServiceToken(args.token);
    const provider = await ctx.db.get(args.id);
    const models = await ctx.db
      .query("llmModels")
      .withIndex("by_provider", (q) => q.eq("providerId", args.id))
      .collect();
    for (const model of models) await ctx.db.delete(model._id);
    await ctx.db.delete(args.id);
    await recordAudit(ctx, {
      action: "llmProvider.remove",
      target: provider?.name,
      details: { removedModels: models.length },
    });
  },
});

/**
 * Server-side "test connection / list models" for the Settings UI. Runs on
 * the backend so the browser never sends a provider key directly to an
 * arbitrary baseUrl: the key either comes from the saved provider row
 * (providerId — decrypted here on the backend, never returned) or is
 * passed once by the caller (the Next server route) and is never stored.
 */
export const fetchModels = action({
  args: {
    token: v.string(),
    baseUrl: v.string(),
    providerId: v.optional(v.id("llmProviders")),
    apiKey: v.optional(v.string()),
    /** Wire format for an unsaved provider (decides the auth header). */
    provider: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<string[]> => {
    assertServiceToken(args.token);
    let base = args.baseUrl.trim().replace(/\/$/, "");
    let apiKey = args.apiKey?.trim() || undefined;
    let wire = args.provider?.trim() || "openai-compatible";
    if (args.providerId) {
      const pool: PoolConnectionPayload[] = await ctx.runQuery(
        internal.llmProviders.getForProject,
        {}
      );
      const connection = pool.find((p) => p._id === args.providerId);
      if (connection) {
        wire = connection.provider;
      }
      if (connection && !apiKey) {
        // A stored key only ever goes to the connection's STORED baseUrl
        // (release audit P0-3): the caller's baseUrl is ignored here, so a
        // request cannot redirect a saved credential to another host.
        base = connection.baseUrl.trim().replace(/\/$/, "");
        if (connection.apiKeyCiphertext) {
          apiKey = await decryptApiKey(connection.apiKeyCiphertext, connection.name);
        } else if (isSafeApiKeyEnv(connection.apiKeyEnv)) {
          const env: Record<string, string | undefined> =
            (globalThis as any).process?.env ?? {};
          apiKey = env[connection.apiKeyEnv]?.trim() || undefined;
        } else {
          // A legacy row naming a platform secret: never read it, never
          // call out without the key the row expects.
          throw new Error(
            "An API key is required (enter one, or fetch models for a saved provider)"
          );
        }
      }
    }
    // Otherwise a missing key is allowed: local servers (Ollama, LM
    // Studio) answer without one, and a vendor that needs one says so
    // with a 401 the caller shows as "the provider rejected the key".
    if (!base) throw new Error("Base URL is required");
    if (!/^https?:\/\//i.test(base)) throw new Error("Base URL must be http(s)");
    return await listProviderModels(base, wire, apiKey);
  },
});

/**
 * Internal pool for trusted callers (worker run context, chat): enabled
 * connections sorted by priority, each with its registered models and the
 * ENCRYPTED key. Plaintext keys are never returned anymore — the worker
 * decrypts on its side, the backend decrypts only for its own calls.
 */
export const getForProject = internalQuery({
  args: { projectId: v.optional(v.id("projects")) },
  handler: async (ctx) => {
    return await loadProviderPool(ctx);
  },
});


/**
 * Every connection, disabled ones included, in the pool payload shape (the
 * Settings Test button on a disabled row). Internal only: it carries the
 * encrypted key like getForProject.
 */
export const getAllForTest = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await loadProviderPool(ctx, { includeDisabled: true });
  },
});
