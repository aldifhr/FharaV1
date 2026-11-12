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
import { InMemoryRotationCursor } from "@/llm/roundRobin";
import { runLlmCallWithFallback, type FallbackHandle } from "@/effects/llmCall";
import type { LLMProvider } from "@/llm";
// Cross-workspace import of the backend's public projection, purely to pin
// the data-shape contract the Settings UI relies on (no backend test
// harness exists; this is a shape check, not a backend test suite).
import { toPublicProvider } from "@/api/convex/llmProviders";

/**
 * Provider Resolver scenarios (PLAN §C, L4): one global chain (per-agent
 * fields ignored), the role override, pool order, model patterns, health
 * exclusion, in-task fallback.
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

describe("resolveForAgent — L4: one global chain, no per-agent layers", () => {
  const pool = [
    conn({ _id: "conn-a", name: "Alpha", priority: 1 }),
    conn({ _id: "conn-b", name: "Beta", priority: 5 }),
  ];

  it("every agent resolves the same chain: the pool in list order", () => {
    const a = resolveForAgent(agent({ name: "A", role: "cto" }), {}, pool, freshHealth());
    const b = resolveForAgent(agent({ name: "B", role: "backend" }), {}, pool, freshHealth());
    expect(a.primary.connectionId).toBe("conn-a"); // lowest priority number
    expect(b.primary.connectionId).toBe("conn-a");
    expect(a.fallbackChain.map((f) => f.connectionId)).toEqual(["conn-b"]);
    expect(b.fallbackChain.map((f) => f.connectionId)).toEqual(["conn-b"]);
  });

  it("an agent with old per-agent fields set still resolves the global chain", () => {
    const legacy = agent({
      name: "Legacy",
      role: "backend",
      llmProviderId: "conn-b",
      llmModelId: "row-m1",
      llmFallbackProviderId: "conn-b",
      llmSelectionPolicy: "fixed",
      executionRuntime: "opencode",
      opencodeModel: "openrouter/x",
    });
    const res = resolveForAgent(legacy, {}, pool, freshHealth());
    expect(res.primary.connectionId).toBe("conn-a");
    expect(res.fallbackChain.map((f) => f.connectionId)).toEqual(["conn-b"]);
    expect(res.routing.reason).toContain("model list order");
  });

  it("a tier model goes first, then the global list (no repeats); an unserved tier is ignored", () => {
    const res = resolveForAgent(agent({ role: "backend" }), {}, pool, freshHealth(), { tierModelRowId: "row-m1" });
    // Both connections serve row-m1: the tier entries lead in list order.
    expect(res.primary.connectionId).toBe("conn-a");
    const shared = [conn({ _id: "conn-a", name: "Alpha", models: [model("fast"), model("deep")] })];
    const tiered = resolveForAgent(undefined, {}, shared, freshHealth(), { tierModelRowId: "row-deep" });
    expect([tiered.primary.model, ...tiered.fallbackChain.map((f) => f.model)]).toEqual(["deep", "fast"]);
    expect(tiered.routing.reason).toContain("role model");
    const gone = resolveForAgent(undefined, {}, shared, freshHealth(), { tierModelRowId: "row-gone" });
    expect(gone.primary.model).toBe("fast");
  });
});

describe("resolveForAgent — pool ordering", () => {
  it("equal priorities: heavier weight first, then pool order (deterministic, no random draw)", () => {
    const pool = [
      conn({ _id: "conn-a", name: "Alpha", priority: 10, weight: 1 }),
      conn({ _id: "conn-b", name: "Beta", priority: 10, weight: 100 }),
    ];
    const res = resolveForAgent(undefined, {}, pool, freshHealth());
    expect(res.primary.connectionId).toBe("conn-b");
    expect(res.fallbackChain.map((f) => f.connectionId)).toEqual(["conn-a"]);
  });

  it("unavailable models are never selected", () => {
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
  });
});

describe("resolveForAgent — global selection mode", () => {
  const pool = [
    conn({ _id: "conn-a", name: "Alpha", priority: 10 }),
    conn({ _id: "conn-b", name: "Beta", priority: 10 }),
    conn({ _id: "conn-c", name: "Gamma", priority: 10 }),
  ];

  it('mode "fallback" starts on the list head and keeps the failover chain', () => {
    const res = resolveForAgent(undefined, {}, pool, freshHealth(), { globalMode: "fallback" });
    expect(res.primary.connectionId).toBe("conn-a");
    expect(res.fallbackChain.map((f) => f.connectionId)).toEqual(["conn-b", "conn-c"]);
  });

  it('mode "round_robin" rotates the starting connection and keeps the chain armed', () => {
    const rotation = new InMemoryRotationCursor();
    const resolve = () => resolveForAgent(undefined, {}, pool, freshHealth(), { globalMode: "round_robin", rotation });
    const first = resolve();
    expect(first.fallbackChain.map((f) => f.connectionId)).toEqual(["conn-b", "conn-c"]);
    expect([first.primary.connectionId, resolve().primary.connectionId, resolve().primary.connectionId, resolve().primary.connectionId]).toEqual([
      "conn-a",
      "conn-b",
      "conn-c",
      "conn-a",
    ]);
  });

  it("an agent's retired policy no longer overrides the global mode", () => {
    const rotation = new InMemoryRotationCursor();
    const pick = () =>
      resolveForAgent(agent({ llmSelectionPolicy: "fixed", llmProviderId: "conn-b" }), {}, pool, freshHealth(), {
        globalMode: "round_robin",
        rotation,
      }).primary.connectionId;
    expect([pick(), pick()]).toEqual(["conn-a", "conn-b"]);
  });

  it("round robin with one candidate behaves like any other mode", () => {
    const single = [conn({ _id: "conn-a", name: "Alpha" })];
    const res = resolveForAgent(undefined, {}, single, freshHealth(), { globalMode: "round_robin", rotation: new InMemoryRotationCursor() });
    expect(res.primary.connectionId).toBe("conn-a");
    expect(res.fallbackChain).toEqual([]);
  });

  it("the Task Estimator does not consume a rotation", () => {
    const rotation = new InMemoryRotationCursor();
    const resolver = new TaskLlmResolver(pool, freshHealth(), { rotation, globalMode: "round_robin" });
    resolver.expectedModelFor(agent({ role: "backend" }));
    expect(resolver.resolutionFor(agent({ role: "backend" })).primary.connectionId).toBe("conn-a");
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
  const pool = [
    conn({ _id: "conn-a", name: "Alpha", priority: 1 }),
    conn({ _id: "conn-b", name: "Beta", priority: 5, models: [model("b-model")] }),
  ];
  const tiers = { planner: "row-b-model", reviewer: "row-b-model", worker: "row-b-model" };
  const chainOf = (resolver: TaskLlmResolver, a: AgentLlmAssignment | undefined, callRole: string) =>
    resolver.handlesFor(a, { callRole }).map((h) => `${h.connectionId}/${h.config.model}`);

  it("toggle off: planner, decision, executor, reviewer, memory and commit resolve the identical chain", () => {
    const resolver = new TaskLlmResolver(pool, freshHealth(), { tiers });
    const cto = agent({ name: "CTO", role: "cto", llmProviderId: "conn-b" });
    const be = agent({ name: "BE", role: "backend", llmModelId: "row-b-model" });
    const reviewer = agent({ name: "Rev", role: "reviewer" });
    const expected = ["conn-a/m1", "conn-b/b-model"];
    expect(resolver.defaultConfig().model).toBe("m1");
    for (const [a, role] of [[cto, "planner"], [cto, "decision"], [be, "executor"], [reviewer, "reviewer"], [be, "memory"], [be, "commit"]] as const) {
      expect(chainOf(resolver, a, role)).toEqual(expected);
    }
  });

  it("toggle on: the role's tier model first, then the global list as fallback", () => {
    const resolver = new TaskLlmResolver(pool, freshHealth(), { tiers: { planner: "row-b-model" }, roleOverride: true });
    const cto = agent({ name: "CTO", role: "cto" });
    expect(chainOf(resolver, cto, "planner")).toEqual(["conn-b/b-model", "conn-a/m1"]);
    // A team member serving the planner call still plans on the planner tier.
    expect(chainOf(resolver, agent({ role: "backend" }), "planner")).toEqual(["conn-b/b-model", "conn-a/m1"]);
    // No worker tier set: the executor walks the global list.
    expect(chainOf(resolver, agent({ role: "backend" }), "executor")).toEqual(["conn-a/m1", "conn-b/b-model"]);
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
