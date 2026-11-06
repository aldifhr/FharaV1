import { describe, expect, it, vi } from "vitest";
import {
  materializePool,
  resolveForAgent,
  TaskLlmResolver,
  type AgentLlmAssignment,
  type PoolConnection,
  type PoolConnectionRow,
  type PoolModel,
} from "@/llm/resolver";
import { ProviderHealthRegistry } from "@/llm/health";
import { runLlmCallWithFallback, type FallbackHandle } from "@/effects/llmCall";
import type { LLMProvider } from "@/llm";
// Cross-workspace import of the backend's public projection, purely to pin
// the data-shape contract the Settings UI relies on (no backend test
// harness exists; this is a shape check, not a backend test suite).
// @ts-ignore - backend module outside the worker tsconfig project
import { toPublicProvider } from "../../apps/api/convex/llmProviders";

/**
 * Provider Resolver scenarios (PLAN §C): per-agent assignment, pool
 * priority/weight, model patterns, health exclusion, in-task fallback.
 */

function model(modelId: string, extra: Partial<PoolModel> = {}): PoolModel {
  return { _id: `row-${modelId}`, modelId, isAvailable: true, ...extra } as PoolModel;
}

function conn(partial: Partial<PoolConnection> & { _id: string; name: string }): PoolConnection {
  return {
    provider: "openai-compatible",
    baseUrl: "https://llm.example/v1",
    apiKeyEnv: "",
    apiKey: "test-key",
    priority: 10,
    weight: 100,
    models: [model("m1")],
    ...partial,
  } as PoolConnection;
}

function agent(partial: Record<string, unknown>): AgentLlmAssignment {
  return partial as AgentLlmAssignment;
}

const freshHealth = () => new ProviderHealthRegistry();

describe("resolveForAgent — assignment", () => {
  const pool = [
    conn({ _id: "conn-a", name: "Alpha", priority: 1 }),
    conn({ _id: "conn-b", name: "Beta", priority: 5 }),
  ];

  it("different agents resolve to different providers via assignment", () => {
    const a = resolveForAgent(agent({ name: "A", llmProviderId: "conn-a" }), {}, pool, freshHealth());
    const b = resolveForAgent(agent({ name: "B", llmProviderId: "conn-b" }), {}, pool, freshHealth());
    expect(a.primary.connectionId).toBe("conn-a");
    expect(b.primary.connectionId).toBe("conn-b");
  });

  it("different agents resolve to different models on one connection", () => {
    const shared = conn({
      _id: "conn-a",
      name: "Alpha",
      models: [model("fast"), model("deep", { supportsReasoning: true })],
    });
    const a = resolveForAgent(agent({ llmProviderId: "conn-a", llmModelId: "row-fast" }), {}, [shared], freshHealth());
    const b = resolveForAgent(agent({ llmProviderId: "conn-a", llmModelId: "row-deep" }), {}, [shared], freshHealth());
    expect(a.primary.model).toBe("fast");
    expect(b.primary.model).toBe("deep");
    expect(a.primary.connectionId).toBe(b.primary.connectionId);
  });

  it("two unassigned agents share the pool's primary connection", () => {
    const a = resolveForAgent(agent({ name: "A" }), {}, pool, freshHealth());
    const b = resolveForAgent(agent({ name: "B" }), {}, pool, freshHealth());
    expect(a.primary.connectionId).toBe("conn-a"); // lowest priority number
    expect(b.primary.connectionId).toBe("conn-a");
  });

  it("fallback assignment comes first in the fallback chain", () => {
    const res = resolveForAgent(
      agent({ llmProviderId: "conn-a", llmFallbackProviderId: "conn-b" }),
      {},
      pool,
      freshHealth()
    );
    expect(res.primary.connectionId).toBe("conn-a");
    expect(res.fallbackChain.map((f) => f.connectionId)).toEqual(["conn-b"]);
  });

  it('policy "fixed" never falls through to pool candidates', () => {
    expect(() =>
      resolveForAgent(
        agent({ llmProviderId: "conn-missing", llmSelectionPolicy: "fixed" }),
        {},
        pool,
        freshHealth()
      )
    ).toThrow(/No LLM provider can serve/);
  });
});

describe("resolveForAgent — pool ordering", () => {
  it("weighted pick among equal priorities is deterministic with injected random", () => {
    const pool = [
      conn({ _id: "conn-a", name: "Alpha", priority: 10, weight: 100 }),
      conn({ _id: "conn-b", name: "Beta", priority: 10, weight: 100 }),
    ];
    const first = resolveForAgent(undefined, {}, pool, freshHealth(), { random: () => 0 });
    const second = resolveForAgent(undefined, {}, pool, freshHealth(), { random: () => 0.99 });
    expect(first.primary.connectionId).toBe("conn-a");
    expect(second.primary.connectionId).toBe("conn-b");
  });

  it('policy "priority" ignores weights entirely', () => {
    const pool = [
      conn({ _id: "conn-a", name: "Alpha", priority: 10, weight: 1 }),
      conn({ _id: "conn-b", name: "Beta", priority: 10, weight: 100 }),
    ];
    const res = resolveForAgent(agent({ llmSelectionPolicy: "priority" }), {}, pool, freshHealth(), {
      random: () => 0.99,
    });
    expect(res.primary.connectionId).toBe("conn-a");
  });

  it("unavailable models are never selected; tool/reasoning needs filter candidates", () => {
    // Need semantics: an explicit supportsTools/supportsReasoning = false
    // excludes a model; an unset flag means "unknown" and stays eligible
    // (legacy/unmarked registry rows must remain usable).
    const pool = [
      conn({
        _id: "conn-a",
        name: "Alpha",
        models: [
          model("gone", { isAvailable: false }),
          model("plain", { supportsTools: false, supportsReasoning: false }),
          model("tooled", { supportsTools: true }),
        ],
      }),
    ];
    expect(resolveForAgent(undefined, {}, pool, freshHealth()).primary.model).toBe("plain");
    expect(resolveForAgent(undefined, { requireTools: true }, pool, freshHealth()).primary.model).toBe("tooled");
    // "tooled" leaves supportsReasoning unset → still eligible for a
    // reasoning need; only an explicit false on EVERY model exhausts it.
    expect(resolveForAgent(undefined, { requireReasoning: true }, pool, freshHealth()).primary.model).toBe("tooled");
    const noReasoning = [
      conn({ _id: "conn-n", name: "NoReason", models: [model("basic", { supportsReasoning: false })] }),
    ];
    expect(() => resolveForAgent(undefined, { requireReasoning: true }, noReasoning, freshHealth())).toThrow(
      /No LLM provider can serve/
    );
    const unmarked = [conn({ _id: "conn-u", name: "Unmarked", models: [model("legacy")] })];
    expect(resolveForAgent(undefined, { requireTools: true }, unmarked, freshHealth()).primary.model).toBe("legacy");
  });
});

describe("resolveForAgent — model patterns", () => {
  it("modelPatterns restrict which models a connection may serve", () => {
    const pool = [
      conn({
        _id: "conn-a",
        name: "Alpha",
        modelPatterns: ["gpt-*"],
        models: [model("gpt-4o"), model("claude-x")],
      }),
    ];
    expect(resolveForAgent(undefined, {}, pool, freshHealth()).primary.model).toBe("gpt-4o");
    expect(() => resolveForAgent(undefined, { modelId: "claude-x" }, pool, freshHealth())).toThrow(
      /"Alpha"/
    );
  });
});

describe("resolveForAgent — health filter", () => {
  it("a connection whose circuit is open (3 transient failures) is excluded", () => {
    const health = freshHealth();
    const pool = [
      conn({ _id: "conn-a", name: "Alpha", priority: 1 }),
      conn({ _id: "conn-b", name: "Beta", priority: 5 }),
    ];
    for (let i = 0; i < 3; i++) health.recordFailure("conn-a", { transient: true });
    const res = resolveForAgent(undefined, {}, pool, health);
    expect(res.primary.connectionId).toBe("conn-b");
    expect(res.fallbackChain.map((f) => f.connectionId)).not.toContain("conn-a");
  });

  it("all candidates circuit-open → explicit error naming the candidates", () => {
    const health = freshHealth();
    const pool = [conn({ _id: "conn-a", name: "Alpha" })];
    for (let i = 0; i < 3; i++) health.recordFailure("conn-a", { transient: true });
    expect(() => resolveForAgent(undefined, {}, pool, health)).toThrow(/circuit breaker/);
    expect(() => resolveForAgent(undefined, {}, pool, health)).toThrow(/"Alpha"/);
  });

  it("no matching model at all → explicit error naming candidate providers", () => {
    const pool = [conn({ _id: "conn-a", name: "Alpha" }), conn({ _id: "conn-b", name: "Beta" })];
    expect(() => resolveForAgent(undefined, { modelId: "nope" }, pool, freshHealth())).toThrow(
      /No LLM provider can serve/
    );
    expect(() => resolveForAgent(undefined, { modelId: "nope" }, pool, freshHealth())).toThrow(
      /"Alpha", "Beta"/
    );
  });
});

describe("materializePool", () => {
  it("excludes disabled connections and synthesizes the legacy model", async () => {
    const rows: PoolConnectionRow[] = [
      {
        _id: "conn-off",
        name: "Off",
        provider: "openai-compatible",
        model: "m-off",
        baseUrl: "https://off.example",
        apiKeyEnv: "KEY_OFF",
        priority: 1,
        weight: 100,
        isEnabled: false,
      } as PoolConnectionRow,
      {
        _id: "conn-on",
        name: "On",
        provider: "openai-compatible",
        model: "legacy-model",
        baseUrl: "https://on.example",
        apiKeyEnv: "KEY_ON",
        priority: 2,
        weight: 100,
        isEnabled: true,
      } as PoolConnectionRow,
    ];
    const pool = await materializePool(rows, { KEY_ON: "env-key", KEY_OFF: "off-key" });
    expect(pool.map((c) => c._id)).toEqual(["conn-on"]);
    expect(pool[0].apiKey).toBe("env-key");
    expect(pool[0].models).toEqual([
      expect.objectContaining({ modelId: "legacy-model", isAvailable: true, legacy: true }),
    ]);
  });

  it("an empty/undefined pool stays empty (env fallback happens at resolve time)", async () => {
    expect(await materializePool(undefined)).toEqual([]);
    expect(await materializePool([])).toEqual([]);
  });
});

describe("TaskLlmResolver", () => {
  it("configFor follows the agent assignment; defaultConfig uses the pool primary", () => {
    const pool = [
      conn({ _id: "conn-a", name: "Alpha", priority: 1 }),
      conn({ _id: "conn-b", name: "Beta", priority: 5, models: [model("b-model")] }),
    ];
    const resolver = new TaskLlmResolver(pool, freshHealth(), { random: () => 0 });
    expect(resolver.defaultConfig().model).toBe("m1");
    expect(resolver.configFor(agent({ llmProviderId: "conn-b" })).model).toBe("b-model");
    const handles = resolver.handlesFor(agent({ llmProviderId: "conn-b" }));
    expect(handles[0].connectionId).toBe("conn-b");
    expect(handles.map((h) => h.connectionId)).toContain("conn-a");
  });
});

describe("runLlmCallWithFallback — in-task fallback", () => {
  const config = { provider: "openai-compatible", model: "m", baseUrl: "https://x", apiKey: "k" };
  const messages = [{ role: "user" as const, content: "hi" }];

  function handle(id: string, complete: LLMProvider["complete"]): FallbackHandle {
    return { connectionId: id, connectionName: id, config, provider: { complete } };
  }
  const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

  it("primary transient failure (503) → next handle serves within the same call", async () => {
    const health = freshHealth();
    const failing = handle("conn-a", vi.fn(async () => { throw httpError(503); }));
    const serving = handle("conn-b", vi.fn(async () => ({ content: "from-b" })));
    const { result, servedBy } = await runLlmCallWithFallback([failing, serving], messages, {
      health,
      retries: 0,
    });
    expect(result.content).toBe("from-b");
    expect(servedBy.connectionId).toBe("conn-b");
    expect(health.snapshot("conn-a").consecutiveTransientFailures).toBe(1);
    expect(health.snapshot("conn-b").totalSuccesses).toBe(1);
  });

  it("permanent error (400) → throws immediately, next handle is NOT called, health untouched", async () => {
    const health = freshHealth();
    const failing = handle("conn-a", vi.fn(async () => { throw httpError(400); }));
    const servingComplete = vi.fn(async () => ({ content: "from-b" }));
    const serving = handle("conn-b", servingComplete);
    await expect(
      runLlmCallWithFallback([failing, serving], messages, { health, retries: 0 })
    ).rejects.toThrow(/HTTP 400/);
    expect(servingComplete).not.toHaveBeenCalled();
    expect(health.snapshot("conn-a").consecutiveTransientFailures).toBe(0);
  });

  it("all handles transient-fail → the last error surfaces", async () => {
    const health = freshHealth();
    const a = handle("conn-a", vi.fn(async () => { throw httpError(503); }));
    const b = handle("conn-b", vi.fn(async () => { throw httpError(502); }));
    await expect(runLlmCallWithFallback([a, b], messages, { health, retries: 0 })).rejects.toThrow(
      /HTTP 502/
    );
    expect(health.snapshot("conn-a").totalTransientFailures).toBe(1);
    expect(health.snapshot("conn-b").totalTransientFailures).toBe(1);
  });
});

describe("public provider shape contract", () => {
  it("list/get rows never expose apiKey or apiKeyCiphertext, only apiKeyConfigured", () => {
    const withCipher = toPublicProvider({
      _id: "p1",
      name: "X",
      apiKey: "legacy-plaintext",
      apiKeyCiphertext: "v1:iv:tag:cipher",
    } as never);
    expect("apiKey" in withCipher).toBe(false);
    expect("apiKeyCiphertext" in withCipher).toBe(false);
    expect(withCipher.apiKeyConfigured).toBe(true);

    const noKey = toPublicProvider({ _id: "p2", name: "Y" } as never);
    expect(noKey.apiKeyConfigured).toBe(false);
    expect(JSON.stringify(noKey)).not.toContain("apiKeyCiphertext");
  });
});
