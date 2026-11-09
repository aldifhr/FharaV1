import { action, internalQuery, query, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { assertServiceToken } from "./authz";
import { encryptApiKey, decryptApiKey } from "./llmCrypto";
import { getGlobalLLMConfig } from "./lib/llmConfig";
import { ENHANCEMENT_SYSTEM_PROMPT } from "./lib/prompts/enhance";
import { loadProviderPool, pickPrimaryConnection, resolveConnectionKey, type PoolConnectionPayload } from "./llmResolver";

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
 * Keys are encrypted at write time (AES-256-GCM, llmCrypto.ts) and stored
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
    priority: v.number(),
    weight: v.optional(v.number()),
    modelPatterns: v.optional(v.array(v.string())),
    isEnabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    assertServiceToken(args.token);
    const { token: _token, apiKey, ...fields } = args;
    const now = Date.now();
    const id = await ctx.db.insert("llmProviders", {
      ...fields,
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
      await ctx.db.insert("llmModels", {
        providerId: id,
        modelId,
        isAvailable: true,
        createdAt: now,
        updatedAt: now,
      });
    }
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
  },
  handler: async (ctx, args) => {
    assertServiceToken(args.token);
    const { id, token: _token, apiKey, ...updates } = args;
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
        await ctx.db.insert("llmModels", {
          providerId: id,
          modelId,
          isAvailable: true,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  },
});

export const remove = mutation({
  args: { token: v.string(), id: v.id("llmProviders") },
  handler: async (ctx, args) => {
    assertServiceToken(args.token);
    const models = await ctx.db
      .query("llmModels")
      .withIndex("by_provider", (q) => q.eq("providerId", args.id))
      .collect();
    for (const model of models) await ctx.db.delete(model._id);
    await ctx.db.delete(args.id);
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
  },
  handler: async (ctx, args): Promise<string[]> => {
    assertServiceToken(args.token);
    const base = args.baseUrl.trim().replace(/\/$/, "");
    if (!base) throw new Error("Base URL is required");
    let apiKey = args.apiKey?.trim() || undefined;
    if (!apiKey && args.providerId) {
      const pool: PoolConnectionPayload[] = await ctx.runQuery(
        internal.llmProviders.getForProject,
        {}
      );
      const connection = pool.find((p) => p._id === args.providerId);
      if (connection?.apiKeyCiphertext) {
        apiKey = await decryptApiKey(connection.apiKeyCiphertext, connection.name);
      } else if (connection) {
        const env: Record<string, string | undefined> =
          (globalThis as any).process?.env ?? {};
        apiKey = env[connection.apiKeyEnv]?.trim() || undefined;
      }
    }
    if (!apiKey) {
      throw new Error(
        "An API key is required (enter one, or fetch models for a saved provider)"
      );
    }
    const res = await fetch(`${base}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Provider returned HTTP ${res.status}`);
    const data: any = await res.json();
    const ids: string[] = (data.data ?? data.models ?? [])
      .map((m: any) => (typeof m === "string" ? m : m?.id))
      .filter(Boolean);
    return [...new Set(ids)].sort();
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
 * Extract the assistant text from an openai-compatible chat completion body.
 * Some gateways answer with `content-type: text/event-stream` and a plain
 * JSON body followed by an SSE sentinel (`data: [DONE]`), which breaks
 * `response.json()` ("Unexpected non-whitespace character after JSON").
 * Falls back to concatenating SSE `delta` chunks when the body is fully
 * chunked. Returns null when no assistant text can be recovered.
 */
function parseChatCompletionContent(raw: string): string | null {
  type Chunk = { choices?: Array<{ message?: { content?: string }; delta?: { content?: string } }> };
  const parse = (text: string): Chunk | null => {
    try {
      return JSON.parse(text) as Chunk;
    } catch {
      return null;
    }
  };
  const whole = parse(raw) ?? parse(raw.replace(/\s*data:\s*\[DONE\]\s*$/i, ""));
  if (whole) return whole.choices?.[0]?.message?.content?.trim() ?? null;
  const content = [...raw.matchAll(/^data:\s*(.+)$/gm)]
    .map((m) => parse(m[1]))
    .filter((chunk): chunk is Chunk => chunk !== null)
    .map((chunk) => chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content ?? "")
    .join("");
  return content.trim() || null;
}

/**
 * Enhance a short/vague prompt using the LLM.
 * Uses the provider pool if configured, otherwise falls back to global LLM config.
 */
export const enhancePrompt = action({
  args: { token: v.string(), prompt: v.string() },
  handler: async (ctx, args): Promise<string> => {
    assertServiceToken(args.token);

    // Load provider pool first
    const pool: PoolConnectionPayload[] = await ctx.runQuery(
      internal.llmProviders.getForProject,
      {}
    );

    let config = getGlobalLLMConfig();

    // Override with provider pool if available
    const primary = pickPrimaryConnection(pool);
    if (primary) {
      const key = await resolveConnectionKey(primary.connection);
      if (key) {
        config = {
          provider: primary.connection.provider.toLowerCase(),
          model: primary.model.modelId,
          baseUrl: primary.connection.baseUrl,
          apiKey: key,
        };
      }
    }

    if (!config.apiKey) {
      throw new Error("No LLM API key configured. Add a provider in Settings or set LLM_API_KEY.");
    }

    // Frame the input as text to rewrite (not a request to answer), so the
    // model rewrites the prompt instead of answering it.
    const userMessage = `Rewrite this prompt (do not answer it):\n"""${args.prompt}"""`;
    const messages = [
      { role: "system" as const, content: ENHANCEMENT_SYSTEM_PROMPT },
      { role: "user" as const, content: userMessage },
    ];

    if (config.provider === "openai" || config.provider === "openai-compatible") {
      const response = await fetch(
        `${config.baseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model,
            messages,
            max_tokens: 1024,
            stream: false,
          }),
        }
      );
      if (!response.ok) {
        throw new Error(`LLM request failed: ${response.status}`);
      }
      return parseChatCompletionContent(await response.text()) ?? args.prompt;
    } else {
      // Anthropic
      const response = await fetch(
        `${config.baseUrl.replace(/\/$/, "")}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": config.apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify({
            model: config.model,
            max_tokens: 1024,
            system: ENHANCEMENT_SYSTEM_PROMPT,
            messages: [{ role: "user" as const, content: userMessage }],
          }),
        }
      );
      if (!response.ok) {
        throw new Error(`LLM request failed: ${response.status}`);
      }
      const data = await response.json() as { content?: Array<{ type: string; text?: string }> };
      const textBlock = data.content?.find((c) => c.type === "text");
      return textBlock?.text?.trim() ?? args.prompt;
    }
  },
});
