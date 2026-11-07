import { describe, expect, it, vi } from "vitest";
import {
  BudgetExhaustedError,
  BudgetTracker,
  isBudgetExhaustedError,
} from "@/orchestrator/budget";
import { loadPolicy, type ExecutionPolicy } from "@/orchestrator/policy";
import { classifyCommand } from "@/orchestrator/classifier";
import { evaluateDelegation } from "@/orchestrator/delegation";
import type { AgentDefinition } from "@/orchestrator/types";
import {
  estimateUsageCost,
  usageMetaFor,
  type FallbackHandle,
} from "@/effects/llmCall";
import {
  ProviderHealthRegistry,
  type ProviderHealthSnapshot,
} from "@/llm/health";

/**
 * Phase 5 budget enforcement units (PLAN §C): the pre-call gate, the
 * isBudgetExhausted logic-defect regressions, full seed/restore, usage
 * attribution, and the health registry listener.
 */

const policy = (overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy => ({
  ...loadPolicy(),
  ...overrides,
});

const call = (tracker: BudgetTracker) =>
  tracker.recordLLMCall({ inputTokens: 10, outputTokens: 5, model: "m", agentName: "A" });

describe("Phase 5 pre-call budget gate — call count", () => {
  it("rejects the 13th call pre-call in enforce mode with a typed error", () => {
    const tracker = new BudgetTracker(
      policy({ maxLLMCallsPerTask: 12, maxTokenBudgetPerTask: 1_000_000, budgetMode: "enforce" })
    );
    for (let i = 0; i < 12; i++) {
      expect(() => tracker.assertLlmCallAllowed()).not.toThrow();
      call(tracker);
    }
    let caught: unknown;
    try {
      tracker.assertLlmCallAllowed();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BudgetExhaustedError);
    expect(isBudgetExhaustedError(caught)).toBe(true);
    expect((caught as Error).message).toContain("LLM call budget exhausted (12/12)");
    // The gate is pre-call: the 13th call never happened.
    expect(tracker.llmCallCount).toBe(12);
  });

  it("warn mode lets the 13th call through but warns once per reason", () => {
    const onWarn = vi.fn();
    const tracker = new BudgetTracker(
      policy({ maxLLMCallsPerTask: 12, maxTokenBudgetPerTask: 1_000_000, budgetMode: "warn" })
    );
    for (let i = 0; i < 12; i++) call(tracker);
    expect(() => tracker.assertLlmCallAllowed(onWarn)).not.toThrow();
    expect(() => tracker.assertLlmCallAllowed(onWarn)).not.toThrow();
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0][0]).toContain("LLM call budget exhausted (12/12)");
  });

  it("default policy mode is warn", () => {
    expect(loadPolicy().budgetMode).toBe("warn");
  });
});

describe("Phase 5 pre-call budget gate — token budget", () => {
  it("throws in enforce mode once the token budget is spent", () => {
    const tracker = new BudgetTracker(
      policy({ maxLLMCallsPerTask: 100, maxTokenBudgetPerTask: 100, budgetMode: "enforce" })
    );
    tracker.recordLLMCall({ inputTokens: 60, outputTokens: 50, model: "m", agentName: "A" });
    expect(() => tracker.assertLlmCallAllowed()).toThrowError(BudgetExhaustedError);
    expect(() => tracker.assertLlmCallAllowed()).toThrowError(/Token budget exhausted \(110\/100\)/);
  });

  it("warns (does not throw) in warn mode when tokens are spent", () => {
    const onWarn = vi.fn();
    const tracker = new BudgetTracker(
      policy({ maxLLMCallsPerTask: 100, maxTokenBudgetPerTask: 100, budgetMode: "warn" })
    );
    tracker.recordLLMCall({ inputTokens: 60, outputTokens: 50, model: "m", agentName: "A" });
    expect(() => tracker.assertLlmCallAllowed(onWarn)).not.toThrow();
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0][0]).toContain("Token budget exhausted");
  });
});

describe("Phase 5 isBudgetExhausted boundary regressions (PLAN §7.2 defect)", () => {
  it("reports delegation-count exhaustion on its own (the original defect)", () => {
    // Old code folded the delegation check behind
    // `!canDelegate() && agents.size >= maxAgentsPerTask`, reducing it to
    // the agent condition: delegation exhaustion alone never surfaced.
    const tracker = new BudgetTracker(policy({ maxDelegations: 2, maxAgentsPerTask: 10 }));
    tracker.incrementDelegation();
    tracker.incrementDelegation();
    const state = tracker.isBudgetExhausted();
    expect(state.exhausted).toBe(true);
    expect(state.reason).toContain("Delegation budget exhausted (2/2)");
    expect(tracker.delegationCount).toBe(2);
  });

  it("reports agent-count exhaustion on its own", () => {
    const tracker = new BudgetTracker(policy({ maxDelegations: 10, maxAgentsPerTask: 2 }));
    tracker.recordAgent("a1");
    tracker.recordAgent("a2");
    const state = tracker.isBudgetExhausted();
    expect(state.exhausted).toBe(true);
    expect(state.reason).toContain("Agent budget exhausted (2/2)");
  });

  it("reports not-exhausted when every limit still has room", () => {
    const tracker = new BudgetTracker(policy({ maxDelegations: 2, maxAgentsPerTask: 2 }));
    tracker.incrementDelegation();
    tracker.recordAgent("a1");
    expect(tracker.isBudgetExhausted().exhausted).toBe(false);
  });

  it("LLM limits take precedence in the reason", () => {
    const tracker = new BudgetTracker(
      policy({ maxLLMCallsPerTask: 1, maxDelegations: 0, maxAgentsPerTask: 0 })
    );
    call(tracker);
    expect(tracker.isBudgetExhausted().reason).toContain("LLM call budget exhausted");
    expect(tracker.isLlmBudgetExhausted().exhausted).toBe(true);
  });

  it("isLlmBudgetExhausted ignores delegation/agent exhaustion (calls may still start)", () => {
    const tracker = new BudgetTracker(policy({ maxDelegations: 0, maxAgentsPerTask: 0 }));
    expect(tracker.isBudgetExhausted().exhausted).toBe(true);
    expect(tracker.isLlmBudgetExhausted().exhausted).toBe(false);
  });
});

describe("Phase 5 full seed / restore (resume does not reset the budget)", () => {
  it("seed restores agents, delegation count and retries alongside usage", () => {
    const tracker = new BudgetTracker(policy());
    tracker.seed({
      calls: 5,
      inputTokens: 100,
      outputTokens: 50,
      agents: ["agent-a", "agent-b"],
      delegationDepth: 3,
      retries: 2,
    });
    expect(tracker.llmCallCount).toBe(5);
    expect(tracker.totalTokens).toBe(150);
    expect(tracker.agentCount).toBe(2);
    expect(tracker.delegationCount).toBe(3);
    expect(tracker.retryCount).toBe(2);
  });

  it("snapshot → restoreExtras round-trips the non-usage state", () => {
    const source = new BudgetTracker(policy());
    source.recordLLMCall({ inputTokens: 10, outputTokens: 5, model: "m", agentName: "A", agentId: "agent-a" });
    source.recordAgent("agent-b");
    source.incrementDelegation();
    source.incrementRetry();
    const snap = source.snapshot();
    expect(snap.agents.sort()).toEqual(["agent-a", "agent-b"]);

    const restored = new BudgetTracker(policy());
    restored.restoreExtras(snap);
    expect(restored.agentCount).toBe(2);
    expect(restored.delegationCount).toBe(1);
    expect(restored.retryCount).toBe(1);
    // Usage totals come from the tokenUsage table, not from restoreExtras.
    expect(restored.llmCallCount).toBe(0);
  });

  it("a seeded tracker still enforces against the restored totals", () => {
    const tracker = new BudgetTracker(
      policy({ maxLLMCallsPerTask: 12, budgetMode: "enforce" })
    );
    tracker.seed({ calls: 12, inputTokens: 10, outputTokens: 5 });
    expect(() => tracker.assertLlmCallAllowed()).toThrowError(BudgetExhaustedError);
  });
});

describe("Phase 5 usage attribution (provider / model / estimated cost)", () => {
  const handle = (overrides: Partial<FallbackHandle> = {}): FallbackHandle =>
    ({
      connectionId: "conn-1",
      provider: {} as FallbackHandle["provider"],
      modelRowId: "model-row-1",
      inputPricePer1k: 0.002,
      outputPricePer1k: 0.008,
      ...overrides,
    }) as FallbackHandle;

  it("estimateUsageCost prices input and output per 1k tokens", () => {
    expect(estimateUsageCost(handle(), 1000, 500)).toBeCloseTo(0.006, 10);
  });

  it("estimateUsageCost is absent when either price is missing (never invented)", () => {
    expect(estimateUsageCost(handle({ inputPricePer1k: undefined }), 1000, 500)).toBeUndefined();
    expect(estimateUsageCost(handle({ outputPricePer1k: undefined }), 1000, 500)).toBeUndefined();
  });

  it("usageMetaFor carries providerId, modelRowId and estimatedCost", () => {
    const meta = usageMetaFor(handle(), 2000, 1000);
    expect(meta.providerId).toBe("conn-1");
    expect(meta.modelRowId).toBe("model-row-1");
    expect(meta.estimatedCost).toBeCloseTo(0.012, 10);
  });

  it("usageMetaFor omits providerId for the env fallback (empty connectionId)", () => {
    const meta = usageMetaFor(
      handle({ connectionId: "", modelRowId: undefined, inputPricePer1k: undefined, outputPricePer1k: undefined }),
      100,
      50
    );
    expect(meta.providerId).toBeUndefined();
    expect(meta.modelRowId).toBeUndefined();
    expect(meta.estimatedCost).toBeUndefined();
  });
});

describe("Phase 5 maxDelegations enforcement (spec §7 vocabulary is live)", () => {
  const developer: AgentDefinition = {
    _id: "dev1",
    name: "Developer",
    role: "developer",
    capabilities: ["frontend-development", "backend-development", "general"],
  };
  const security: AgentDefinition = {
    _id: "sec1",
    name: "Security",
    role: "security",
    capabilities: ["security-audit"],
  };
  const agents = [developer, security];

  const evaluate = (budget: BudgetTracker) =>
    evaluateDelegation({
      result: {
        agentName: "Agent",
        capability: "frontend-development",
        success: true,
        summary: "done",
        delegationRecommendation: { targetCapability: "security-audit", reason: "needs a specialist" },
      } as never,
      classification: classifyCommand("implement feature"),
      agents,
      budget,
      previousAgents: [],
      delegationDepth: 0,
      alreadyDelegatedCapabilities: [],
    });

  it("REJECTs a recommended delegation once maxDelegations is spent", () => {
    const budget = new BudgetTracker(policy({ maxDelegations: 2 }));
    budget.incrementDelegation();
    budget.incrementDelegation();
    const result = evaluate(budget);
    expect(result.decision).toBe("REJECT");
    expect(result.reason).toContain("Delegation budget exhausted (2/2)");
  });

  it("allows the delegation while the count has room", () => {
    const budget = new BudgetTracker(policy({ maxDelegations: 2 }));
    budget.incrementDelegation();
    const result = evaluate(budget);
    expect(result.decision).not.toBe("REJECT");
  });
});

describe("Phase 5 provider health registry observability", () => {
  it("notifies the change listener on success and transient failure", () => {
    const seen: Array<[string, ProviderHealthSnapshot]> = [];
    const registry = new ProviderHealthRegistry({ failureThreshold: 2, cooldownMs: 60_000 });
    registry.setChangeListener((connectionId, snapshot) => {
      seen.push([connectionId, snapshot]);
    });
    registry.recordSuccess("conn-1");
    registry.recordFailure("conn-1", { transient: true });
    expect(seen.map(([id]) => id)).toEqual(["conn-1", "conn-1"]);
    expect(seen[0][1].totalSuccesses).toBe(1);
    expect(seen[1][1].totalTransientFailures).toBe(1);
    expect(seen[1][1].consecutiveTransientFailures).toBe(1);
  });

  it("a throwing listener never breaks the call path", () => {
    const registry = new ProviderHealthRegistry();
    registry.setChangeListener(() => {
      throw new Error("observer broken");
    });
    expect(() => registry.recordSuccess("conn-1")).not.toThrow();
    expect(() => registry.recordFailure("conn-1", { transient: true })).not.toThrow();
  });

  it("snapshots() exposes every tracked connection for the Settings panel", () => {
    const registry = new ProviderHealthRegistry({ failureThreshold: 1, cooldownMs: 60_000 });
    registry.recordSuccess("conn-1");
    registry.recordFailure("conn-2", { transient: true });
    const all = registry.snapshots();
    expect([...all.keys()].sort()).toEqual(["conn-1", "conn-2"]);
    expect(all.get("conn-1")?.totalSuccesses).toBe(1);
    expect(all.get("conn-2")?.circuitOpenUntil).not.toBeNull();
    expect(registry.isCircuitOpen("conn-2")).toBe(true);
  });

  it("connection names registered from the pool resolve for the backend mirror", () => {
    const registry = new ProviderHealthRegistry();
    expect(registry.connectionName("conn-1")).toBeUndefined();
    registry.registerConnectionName("conn-1", "Primary OpenAI");
    expect(registry.connectionName("conn-1")).toBe("Primary OpenAI");
    // A renamed connection updates in place; unknown ids stay unknown
    // (the reporter skips them — no backend row to mirror to).
    registry.registerConnectionName("conn-1", "Primary (renamed)");
    expect(registry.connectionName("conn-1")).toBe("Primary (renamed)");
    expect(registry.connectionName("env-fallback")).toBeUndefined();
  });
});
