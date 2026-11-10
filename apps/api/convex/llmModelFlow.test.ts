/// <reference types="vite/client" />
/**
 * Settings → LLM & Models flow: presets, model discovery with the right
 * auth per wire format (Anthropic x-api-key), the one ordered model list
 * (reorder, append), the per-model Test action, and chat failover through
 * the ordered list (lib/chat/llm completeWithAgent + fallbacks).
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { listProviderModels } from "./lib/llmModelList";
import { findPreset, guessPreset, LLM_PROVIDER_PRESETS, modelListHeaders, parseModelList } from "./lib/llmPresets";
import { isSafeApiKeyEnv } from "./lib/apiKeyEnv";
import { completeWithAgent, resetChatRouting } from "./lib/chat/llm";

const modules = import.meta.glob("./**/*.ts");
const TOKEN = "svc-token-llm-flow";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const chatOk = (content: string) => json({ choices: [{ message: { content } }] });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  process.env.CONVEX_SERVICE_TOKEN = TOKEN;
  resetChatRouting();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.CONVEX_SERVICE_TOKEN;
  delete process.env.FLOW_KEY;
});

describe("presets", () => {
  test("every preset has a safe env name and a valid wire format", () => {
    expect(LLM_PROVIDER_PRESETS.map((p) => p.id)).toEqual([
      "anthropic", "openai", "openrouter", "gemini", "deepseek", "groq", "mistral", "together", "ollama", "lmstudio", "custom",
    ]);
    for (const preset of LLM_PROVIDER_PRESETS) {
      expect(isSafeApiKeyEnv(preset.apiKeyEnv), preset.id).toBe(true);
      expect(["anthropic", "openai", "openai-compatible"]).toContain(preset.provider);
      if (preset.needsKey) expect(preset.apiKeyUrl, preset.id).toMatch(/^https:\/\//);
    }
    expect(findPreset("groq")?.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(guessPreset({ provider: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1/" }).id).toBe("openrouter");
    expect(guessPreset({ provider: "anthropic", baseUrl: "https://proxy.example" }).id).toBe("anthropic");
    expect(guessPreset({ provider: "openai-compatible", baseUrl: "http://10.0.0.1" }).id).toBe("custom");
  });

  test("parseModelList reads OpenAI data[] and Gemini/Ollama models[]", () => {
    expect(parseModelList({ data: [{ id: "b" }, { id: "a" }, { id: "a" }] })).toEqual(["a", "b"]);
    expect(parseModelList({ models: [{ name: "models/gemini-2.5-flash" }, "llama3"] })).toEqual(["gemini-2.5-flash", "llama3"]);
    expect(parseModelList(null)).toEqual([]);
  });
});

describe("model discovery auth", () => {
  test("Anthropic uses x-api-key + anthropic-version, never Bearer", async () => {
    expect(modelListHeaders("anthropic", "sk-ant")).toEqual({ "anthropic-version": "2023-06-01", "x-api-key": "sk-ant" });
    const seen: Record<string, string>[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return json({ data: [{ id: "claude-sonnet-4-5" }] });
    }) as unknown as typeof fetch;
    const ids = await listProviderModels("https://api.anthropic.com/v1", "anthropic", "sk-ant", fetchImpl);
    expect(ids).toEqual(["claude-sonnet-4-5"]);
    expect(seen[0]["x-api-key"]).toBe("sk-ant");
    expect(seen[0]["anthropic-version"]).toBe("2023-06-01");
    expect(seen[0].authorization).toBeUndefined();
  });

  test("OpenAI-compatible uses Bearer; a keyless local server gets no auth header", () => {
    expect(modelListHeaders("openai-compatible", "sk-x")).toEqual({ authorization: "Bearer sk-x" });
    expect(modelListHeaders("openai-compatible", undefined)).toEqual({});
  });

  test("a 404 on the bare path retries with /v1; a 401 says the key was rejected", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(String(url));
      return String(url).endsWith("/v1/models") ? json({ data: [{ id: "m" }] }) : new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;
    expect(await listProviderModels("http://10.0.0.5:8080", "openai-compatible", "k", fetchImpl)).toEqual(["m"]);
    expect(urls).toEqual(["http://10.0.0.5:8080/models", "http://10.0.0.5:8080/v1/models"]);
    const denied = vi.fn(async () => new Response('{"error":"invalid x-api-key"}', { status: 401 })) as unknown as typeof fetch;
    await expect(listProviderModels("https://api.anthropic.com/v1", "anthropic", "bad", denied)).rejects.toThrow(
      /rejected the key \(HTTP 401\)/
    );
  });

  test("fetchModels for a saved Anthropic connection sends x-api-key to the stored URL", async () => {
    process.env.FLOW_KEY = "sk-ant-stored";
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), headers: init?.headers as Record<string, string> });
      return json({ data: [{ id: "claude-haiku-4-5" }] });
    });
    const t = convexTest(schema, modules);
    const providerId = await t.run((ctx) =>
      ctx.db.insert("llmProviders", {
        name: "Anthropic", provider: "anthropic", model: "", baseUrl: "https://api.anthropic.com/v1",
        apiKeyEnv: "FLOW_KEY", priority: 0, weight: 100, isEnabled: true, createdAt: 1,
      })
    );
    const ids = await t.action(api.llmProviders.fetchModels, { token: TOKEN, baseUrl: "https://ignored.example", providerId });
    expect(ids).toEqual(["claude-haiku-4-5"]);
    expect(seen[0].url).toBe("https://api.anthropic.com/v1/models");
    expect(seen[0].headers["x-api-key"]).toBe("sk-ant-stored");
    expect(seen[0].headers.authorization).toBeUndefined();
  });

  test("encryptionStatus reports only whether the key is set", async () => {
    const t = convexTest(schema, modules);
    const before = process.env.PROVIDER_ENCRYPTION_KEY;
    delete process.env.PROVIDER_ENCRYPTION_KEY;
    expect(await t.query(api.llmProviders.encryptionStatus, {})).toEqual({ configured: false });
    process.env.PROVIDER_ENCRYPTION_KEY = "x";
    expect(await t.query(api.llmProviders.encryptionStatus, {})).toEqual({ configured: true });
    if (before === undefined) delete process.env.PROVIDER_ENCRYPTION_KEY;
    else process.env.PROVIDER_ENCRYPTION_KEY = before;
  });
});

async function twoProviders() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const a = await ctx.db.insert("llmProviders", {
      name: "A", provider: "openai-compatible", model: "", baseUrl: "http://a.example/v1",
      apiKeyEnv: "FLOW_KEY", priority: 0, weight: 100, isEnabled: true, createdAt: now,
    });
    const b = await ctx.db.insert("llmProviders", {
      name: "B", provider: "openai-compatible", model: "", baseUrl: "http://b.example/v1",
      apiKeyEnv: "FLOW_KEY", priority: 1, weight: 100, isEnabled: true, createdAt: now,
    });
    // Legacy rows: no position yet.
    const a1 = await ctx.db.insert("llmModels", { providerId: a, modelId: "a1", isAvailable: true, createdAt: now, updatedAt: now });
    const b1 = await ctx.db.insert("llmModels", { providerId: b, modelId: "b1", isAvailable: true, createdAt: now, updatedAt: now });
    return { a, b, a1, b1 };
  });
  return { t, ...ids };
}

describe("the ordered model list", () => {
  test("list starts in the legacy order; a new model is appended at the end", async () => {
    const { t, a } = await twoProviders();
    expect((await t.query(api.llmModels.list, {})).map((m) => m.modelId)).toEqual(["a1", "b1"]);
    await t.mutation(api.llmModels.create, { token: TOKEN, providerId: a, modelId: "a2" });
    const rows = await t.query(api.llmModels.list, {});
    expect(rows.map((m) => [m.modelId, m.position])).toEqual([
      ["a1", 0],
      ["b1", 1],
      ["a2", 2],
    ]);
  });

  test("reorder sets every position at once and connection priority follows", async () => {
    const { t, a, b, a1, b1 } = await twoProviders();
    await t.mutation(api.llmModels.reorder, { token: TOKEN, orderedIds: [b1, a1] });
    expect((await t.query(api.llmModels.list, {})).map((m) => m.modelId)).toEqual(["b1", "a1"]);
    const providers = await t.run(async (ctx) => [await ctx.db.get(a), await ctx.db.get(b)]);
    expect(providers.map((p) => p?.priority)).toEqual([1, 0]);
    // The pool payload carries position + the global mode for chat.
    await t.mutation(api.llmSelection.set, { mode: "round_robin" });
    const pool = await t.query(internal.llmProviders.getForProject, {});
    expect(pool.every((c) => c.selectionMode === "round_robin")).toBe(true);
    expect(pool.flatMap((c) => c.models.map((m) => [m.modelId, m.position]))).toEqual(
      expect.arrayContaining([
        ["b1", 0],
        ["a1", 1],
      ])
    );
  });

  test("a provider created without a priority goes after the existing ones", async () => {
    const { t } = await twoProviders();
    const id = await t.mutation(api.llmProviders.create, {
      token: TOKEN, name: "C", provider: "anthropic", model: "", baseUrl: "https://api.anthropic.com/v1",
      apiKeyEnv: "ANTHROPIC_API_KEY", presetId: "anthropic",
    });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.priority).toBe(2);
    expect(row?.presetId).toBe("anthropic");
    // No model id given: nothing seeded into the list.
    expect((await t.query(api.llmModels.list, {})).map((m) => m.modelId)).toEqual(["a1", "b1"]);
  });

  test("reorder refuses a stale or duplicated list and needs the service token", async () => {
    const { t, a1, b1 } = await twoProviders();
    await expect(t.mutation(api.llmModels.reorder, { token: TOKEN, orderedIds: [a1] })).rejects.toThrow(/out of date/);
    await expect(t.mutation(api.llmModels.reorder, { token: TOKEN, orderedIds: [a1, a1] })).rejects.toThrow(/twice/);
    await expect(t.mutation(api.llmModels.reorder, { token: "wrong", orderedIds: [b1, a1] })).rejects.toThrow();
  });
});

describe("Test action", () => {
  test("tests one model with a tiny completion and reports model + latency", async () => {
    process.env.FLOW_KEY = "k";
    const { t, b, b1 } = await twoProviders();
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return chatOk("OK");
    }));
    const result = await t.action(api.llmProvidersNode.testModel, { token: TOKEN, providerId: b, modelRowId: b1 });
    expect(result).toMatchObject({ ok: true, connection: "B", model: "b1", detail: "OK" });
    expect(typeof result.latencyMs).toBe("number");
    expect(bodies[0].model).toBe("b1");
  });

  test("a failing model reports the error, not the key", async () => {
    process.env.FLOW_KEY = "sk-secret-value-123456";
    const { t, a } = await twoProviders();
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"bad key sk-secret-value-123456"}', { status: 401 })));
    const result = await t.action(api.llmProvidersNode.testModel, { token: TOKEN, providerId: a });
    expect(result.ok).toBe(false);
    expect(result.model).toBe("a1");
    expect(result.detail).toContain("401");
    expect(result.detail).not.toContain("sk-secret-value-123456");
  });
});

describe("chat failover through the ordered list", () => {
  const cfg = (host: string) => ({ provider: "openai-compatible", model: host, baseUrl: `http://${host}.example/v1`, apiKey: "k", connectionId: host });

  test("a 5xx moves on to the next model in the list", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).startsWith("http://one.") ? new Response("down", { status: 503 }) : chatOk("from two")
    ));
    const result = await completeWithAgent("sys", [{ role: "user", content: "hi" }], { ...cfg("one"), fallbacks: [cfg("two")] });
    expect(result.content).toBe("from two");
  });

  test("an empty answer moves on too", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url).startsWith("http://one.") ? chatOk("") : chatOk("filled"))));
    const result = await completeWithAgent("sys", [{ role: "user", content: "hi" }], { ...cfg("one"), fallbacks: [cfg("two")] });
    expect(result.content).toBe("filled");
  });

  test("a request-scoped 400 does not fail over", async () => {
    const fetchSpy = vi.fn(async (_url: string) => new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      completeWithAgent("sys", [{ role: "user", content: "hi" }], { ...cfg("one"), fallbacks: [cfg("two")] })
    ).rejects.toThrow(/400/);
    expect(fetchSpy.mock.calls.every(([url]) => String(url).startsWith("http://one."))).toBe(true);
  });

  test("a rate-limited connection is tried last on the next call", async () => {
    const hosts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      hosts.push(new URL(String(url)).hostname);
      return String(url).startsWith("http://one.") ? new Response("slow down", { status: 429 }) : chatOk("two");
    }));
    const config = { ...cfg("one"), fallbacks: [cfg("two")] };
    await completeWithAgent("sys", [{ role: "user", content: "hi" }], config);
    hosts.length = 0;
    await completeWithAgent("sys", [{ role: "user", content: "hi" }], config);
    expect(hosts[0]).toBe("two.example");
  });
});
