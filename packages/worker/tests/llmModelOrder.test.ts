import { describe, expect, it } from "vitest";
import { resolveForAgent, type AgentLlmAssignment, type PoolConnection, type PoolModel } from "@/llm/resolver";
import { ProviderHealthRegistry } from "@/llm/health";
import { InMemoryRotationCursor } from "@/llm/roundRobin";
import { runLlmCallWithFallback, type FallbackHandle } from "@/effects/llmCall";
import type { LLMProvider } from "@/llm";
import {
  applySelectionMode,
  nextPosition,
  orderPoolPairs,
  positionsFromOrder,
  sortModelRows,
} from "@/api/convex/lib/llmOrder";
import {
  cooldownForFailure,
  isEmptyCompletion,
  rateLimitCooldownMs,
  rotateFrom,
  StickyRotationCursor,
} from "@/api/convex/lib/llmRotation";
import { orderedChatPairs } from "@/api/convex/lib/chat/llm";
import type { PoolConnectionPayload } from "@/api/convex/lib/llmResolver";

/**
 * The one model list (Settings → LLM & Models): its order is the fallback
 * order for chat AND tasks, round robin rotates its start (sticky), and
 * the backend chat resolver walks the same list as the worker.
 */

function model(modelId: string, position?: number, extra: Partial<PoolModel> = {}): PoolModel {
  return {
    _id: `row-${modelId}`,
    modelId,
    isAvailable: true,
    ...(position === undefined ? {} : { position }),
    ...extra,
  } as PoolModel;
}

function conn(partial: Partial<PoolConnection> & { _id: string; name: string }): PoolConnection {
  return {
    provider: "openai-compatible",
    baseUrl: `https://${partial._id}.example/v1`,
    apiKeyEnv: "",
    apiKey: "test-key",
    priority: 10,
    weight: 100,
    models: [model("m1")],
    ...partial,
  } as PoolConnection;
}

const health = () => new ProviderHealthRegistry();
const chainOf = (r: ReturnType<typeof resolveForAgent>) =>
  [r.primary, ...r.fallbackChain].map((e) => `${e.connectionId}/${e.model}`);

// Positions interleave the two connections: b/x, a/y, b/z, a/w.
const orderedPool = () => [
  conn({ _id: "a", name: "A", priority: 0, models: [model("y", 1), model("w", 3)] }),
  conn({ _id: "b", name: "B", priority: 5, models: [model("x", 0), model("z", 2)] }),
];

describe("orderPoolPairs", () => {
  it("orders by position across connections", () => {
    const pairs = orderPoolPairs(orderedPool());
    expect(pairs.map((p) => `${p.connection._id}/${p.model.modelId}`)).toEqual(["b/x", "a/y", "b/z", "a/w"]);
  });

  it("without positions keeps the legacy order: priority, then weight (heavier first)", () => {
    const pool = [
      conn({ _id: "light", name: "L", priority: 1, weight: 10, models: [model("l")] }),
      conn({ _id: "heavy", name: "H", priority: 1, weight: 90, models: [model("h")] }),
      conn({ _id: "first", name: "F", priority: 0, models: [model("f")] }),
    ];
    expect(orderPoolPairs(pool).map((p) => p.model.modelId)).toEqual(["f", "h", "l"]);
  });

  it("positioned models come before unpositioned ones; unavailable and pattern-excluded are dropped", () => {
    const pool = [
      conn({ _id: "a", name: "A", priority: 0, models: [model("old"), model("off", 0, { isAvailable: false })] }),
      conn({ _id: "b", name: "B", priority: 9, modelPatterns: ["gpt-*"], models: [model("gpt-4o", 1), model("claude", 2)] }),
    ];
    expect(orderPoolPairs(pool).map((p) => p.model.modelId)).toEqual(["gpt-4o", "old"]);
  });
});

describe("reorder helpers", () => {
  it("positionsFromOrder maps index → position and connection priority → first model's index", () => {
    const { positions, providerPriority } = positionsFromOrder(
      ["m3", "m1", "m2"],
      new Map([
        ["m1", "p1"],
        ["m2", "p2"],
        ["m3", "p2"],
      ])
    );
    expect([...positions]).toEqual([
      ["m3", 0],
      ["m1", 1],
      ["m2", 2],
    ]);
    expect(providerPriority.get("p2")).toBe(0);
    expect(providerPriority.get("p1")).toBe(1);
  });

  it("nextPosition appends after the highest position", () => {
    expect(nextPosition([])).toBe(0);
    expect(nextPosition([{ position: 4 }, {}, { position: 1 }])).toBe(5);
  });

  it("sortModelRows lists every row (unavailable included) in list order", () => {
    const providers = [
      { _id: "p1", priority: 0, weight: 1 },
      { _id: "p2", priority: 1, weight: 1 },
    ];
    const rows = [
      { _id: "r1", providerId: "p1", modelId: "a" },
      { _id: "r2", providerId: "p2", modelId: "b", position: 0 },
      { _id: "r3", providerId: "p2", modelId: "c" },
    ];
    expect(sortModelRows(rows, providers).map((r) => r._id)).toEqual(["r2", "r1", "r3"]);
  });
});

describe("sticky round robin (adapted from 9router)", () => {
  it("limit 1 rotates every call", () => {
    const cursor = new StickyRotationCursor(1);
    expect([0, 1, 2, 3].map(() => cursor.next(3))).toEqual([0, 1, 2, 0]);
  });

  it("limit N keeps each start for N calls", () => {
    const cursor = new StickyRotationCursor(2);
    expect([0, 1, 2, 3, 4, 5].map(() => cursor.next(3))).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it("an invalid limit falls back to 1; peek does not advance", () => {
    const cursor = new StickyRotationCursor(0);
    expect(cursor.peek(2)).toBe(0);
    expect(cursor.next(2)).toBe(0);
    expect(cursor.peek(2)).toBe(1);
  });

  it("rotateFrom keeps the rest of the list as the failover chain", () => {
    expect(rotateFrom(["a", "b", "c"], 1)).toEqual(["b", "c", "a"]);
    expect(rotateFrom(["a", "b", "c"], 5)).toEqual(["c", "a", "b"]);
  });

  it("applySelectionMode: fallback keeps the list, round robin rotates it", () => {
    const cursor = new StickyRotationCursor(1);
    expect(applySelectionMode(["a", "b"], "fallback", cursor)).toEqual(["a", "b"]);
    expect(applySelectionMode(["a", "b"], "round_robin", cursor)).toEqual(["a", "b"]);
    expect(applySelectionMode(["a", "b"], "round_robin", cursor)).toEqual(["b", "a"]);
  });
});

describe("empty responses and cooldowns (adapted from 9router)", () => {
  it("isEmptyCompletion", () => {
    expect(isEmptyCompletion({ content: "  " })).toBe(true);
    expect(isEmptyCompletion({ content: "", reasoning: "thinking" })).toBe(false);
    expect(isEmptyCompletion({ content: "", toolCalls: [{}] })).toBe(false);
    expect(isEmptyCompletion({ content: "ok" })).toBe(false);
  });

  it("429 backs off exponentially; auth 2 min; request 4xx none; 5xx 30 s", () => {
    const first = cooldownForFailure(Object.assign(new Error("x"), { status: 429 }));
    expect(first).toMatchObject({ kind: "rate_limit", backoffLevel: 1, cooldownMs: 2_000 });
    const second = cooldownForFailure(new Error("Too Many Requests"), first.backoffLevel);
    expect(second).toMatchObject({ kind: "rate_limit", backoffLevel: 2, cooldownMs: 4_000 });
    expect(rateLimitCooldownMs(20)).toBe(5 * 60_000);
    expect(cooldownForFailure(new Error("LLM request failed: 401 (x)"))).toMatchObject({ kind: "auth", cooldownMs: 120_000 });
    expect(cooldownForFailure(Object.assign(new Error("bad"), { status: 400 }))).toMatchObject({ kind: "request", cooldownMs: 0 });
    expect(cooldownForFailure(Object.assign(new Error("down"), { status: 503 }))).toMatchObject({ kind: "transient", cooldownMs: 30_000 });
  });

  it("the health registry opens the circuit at once on a rate limit", () => {
    let now = 1_000;
    const registry = new ProviderHealthRegistry({ now: () => now });
    registry.recordFailure("c", { transient: true, error: Object.assign(new Error("x"), { status: 429 }) });
    expect(registry.isAvailable("c")).toBe(false);
    now += 2_001;
    expect(registry.isAvailable("c")).toBe(true);
    // A plain 5xx still needs the threshold (3 in a row).
    registry.recordSuccess("c");
    registry.recordFailure("c", { transient: true, error: Object.assign(new Error("x"), { status: 502 }) });
    expect(registry.isAvailable("c")).toBe(true);
    expect(Object.keys(registry.snapshot("c"))).not.toContain("rateLimitLevel");
  });

  it("runLlmCallWithFallback moves on when a model answers with nothing", async () => {
    const provider = (content: string): LLMProvider => ({
      complete: async () => ({ content, inputTokens: 1, outputTokens: 1 }),
    });
    const handles: FallbackHandle[] = [
      { connectionId: "a", connectionName: "A", config: { provider: "openai", model: "a", baseUrl: "", apiKey: "" }, provider: provider("") },
      { connectionId: "b", connectionName: "B", config: { provider: "openai", model: "b", baseUrl: "", apiKey: "" }, provider: provider("hello") },
    ];
    const { result, servedBy } = await runLlmCallWithFallback(handles, [{ role: "user", content: "hi" }], { retries: 0 });
    expect(result.content).toBe("hello");
    expect(servedBy.connectionId).toBe("b");
  });
});

describe("worker resolver walks the list", () => {
  it("fallback: list order is the chain", () => {
    const r = resolveForAgent(undefined, {}, orderedPool(), health(), { globalMode: "fallback" });
    expect(chainOf(r)).toEqual(["b/x", "a/y", "b/z", "a/w"]);
    expect(r.routing.reason).toContain("model list order");
  });

  it("round robin rotates the start over models, the rest stays the chain", () => {
    const rotation = new InMemoryRotationCursor();
    const opts = { globalMode: "round_robin" as const, rotation };
    expect(chainOf(resolveForAgent(undefined, {}, orderedPool(), health(), opts))[0]).toBe("b/x");
    expect(chainOf(resolveForAgent(undefined, {}, orderedPool(), health(), opts))).toEqual(["a/y", "b/z", "a/w", "b/x"]);
  });

  it("L4: a retired agent assignment is ignored; the list order is the chain", () => {
    const r = resolveForAgent({ llmProviderId: "a", llmModelId: "row-w" } as AgentLlmAssignment, {}, orderedPool(), health());
    expect(chainOf(r)).toEqual(["b/x", "a/y", "b/z", "a/w"]);
  });

  it("L4: the role override's tier model goes first; the list follows in order", () => {
    const r = resolveForAgent({ role: "backend" }, {}, orderedPool(), health(), { tierModelRowId: "row-w" });
    expect(chainOf(r)).toEqual(["a/w", "b/x", "a/y", "b/z"]);
  });

  it("a circuit-open connection is skipped", () => {
    const registry = health();
    for (let i = 0; i < 3; i++) registry.recordFailure("b", { transient: true });
    const r = resolveForAgent(undefined, {}, orderedPool(), registry);
    expect(chainOf(r)).toEqual(["a/y", "a/w"]);
  });
});

describe("chat ↔ worker parity", () => {
  // Same pool as the worker sees, in the backend payload shape.
  const payload = (): PoolConnectionPayload[] =>
    orderedPool().map((c, index) => ({
      _id: c._id,
      name: c.name,
      provider: c.provider,
      model: c.models[0].modelId,
      baseUrl: c.baseUrl,
      apiKeyEnv: "",
      priority: c.priority,
      weight: c.weight,
      models: c.models.map((m) => ({ ...m })),
      selectionMode: index >= 0 ? "fallback" : undefined,
    })) as unknown as PoolConnectionPayload[];

  const chatChain = (pairs: ReturnType<typeof orderedChatPairs>) =>
    pairs.map((p) => `${p.connection._id}/${p.model.modelId}`);

  const agents: (AgentLlmAssignment | undefined)[] = [
    undefined,
    { llmProviderId: "a", llmModelId: "row-w" } as AgentLlmAssignment,
    { llmProviderId: "b", llmFallbackProviderId: "a", llmFallbackModelId: "row-y" } as AgentLlmAssignment,
    { llmProviderId: "a", llmModelId: "row-y", llmSelectionPolicy: "fixed" } as AgentLlmAssignment,
  ];

  const listChain = ["b/x", "a/y", "b/z", "a/w"];
  for (const [index, assignment] of agents.entries()) {
    it(`fallback mode, agent case ${index}: same chain, the global list (retired fields ignored)`, () => {
      const worker = chainOf(resolveForAgent(assignment, {}, orderedPool(), health(), { globalMode: "fallback" }));
      const chat = chatChain(orderedChatPairs(payload(), assignment as never, new StickyRotationCursor(1)));
      expect(chat).toEqual(worker);
      expect(worker).toEqual(listChain);
    });
  }

  it("a pool with no list positions: same chain (priority, then weight, no random draw)", () => {
    const unordered = () => [
      conn({ _id: "a", name: "A", priority: 5, weight: 1, models: [model("y")] }),
      conn({ _id: "b", name: "B", priority: 5, weight: 9, models: [model("x")] }),
      conn({ _id: "c", name: "C", priority: 1, models: [model("z")] }),
    ];
    const asPayload = unordered().map((c) => ({ ...c, model: c.models[0].modelId, selectionMode: "fallback" })) as unknown as PoolConnectionPayload[];
    const worker = chainOf(resolveForAgent(undefined, {}, unordered(), health(), { globalMode: "fallback" }));
    expect(worker).toEqual(["c/z", "b/x", "a/y"]);
    expect(chatChain(orderedChatPairs(asPayload, undefined, new StickyRotationCursor(1)))).toEqual(worker);
  });

  it("override on: chat (roleTiers on the pool) and the worker (tierModelRowId) put the same tier first", () => {
    const tiered = payload().map((c) => ({ ...c, roleTiers: { worker: "row-z", planner: "row-w" } }));
    for (const [role, callRole, row] of [["backend", "executor", "row-z"], ["cto", "planner", "row-w"], ["reviewer", "reviewer", undefined]] as const) {
      const worker = chainOf(resolveForAgent({ role }, { callRole }, orderedPool(), health(), { globalMode: "fallback", tierModelRowId: row }));
      const chat = chatChain(orderedChatPairs(tiered, { role, callRole }, new StickyRotationCursor(1)));
      expect(chat).toEqual(worker);
    }
    expect(chatChain(orderedChatPairs(tiered, { role: "backend" }, new StickyRotationCursor(1)))[0]).toBe("b/z");
  });

  it("round robin: same rotation sequence for agent-less calls", () => {
    const rrPayload = payload().map((c) => ({ ...c, selectionMode: "round_robin" as const }));
    const workerCursor = new StickyRotationCursor(1);
    const chatCursor = new StickyRotationCursor(1);
    for (let call = 0; call < 5; call++) {
      const worker = chainOf(
        resolveForAgent(undefined, {}, orderedPool(), health(), { globalMode: "round_robin", rotation: workerCursor })
      );
      const chat = chatChain(orderedChatPairs(rrPayload, undefined, chatCursor));
      expect(chat).toEqual(worker);
    }
  });
});
