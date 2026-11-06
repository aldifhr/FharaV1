import { describe, expect, it } from "vitest";
import { BudgetTracker, resolveModelConfig, shouldUseLLMEvaluation } from "../src/orchestrator/budget";
import { loadPolicy } from "../src/orchestrator/policy";

describe("budget", () => {
  it("tracks calls and tokens", () => {
    const p = loadPolicy();
    const b = new BudgetTracker(p);
    b.recordLLMCall({ inputTokens: 100, outputTokens: 50, model: "m", agentName: "A" });
    expect(b.llmCallCount).toBe(1);
    expect(b.totalTokens).toBe(150);
  });

  it("resolveModelConfig precedence", () => {
    const r1 = resolveModelConfig({ llmModel: "custom-model", llmProvider: "anthropic" });
    expect(r1.model).toBe("custom-model");
    const r2 = resolveModelConfig({});
    expect(r2.provider).toBe("anthropic");
  });

  it("shouldUseLLMEvaluation only when deterministic inconclusive", () => {
    expect(shouldUseLLMEvaluation({ verdict: "passed", pendingItems: 0 }, 100, 5)).toBe(false);
    expect(shouldUseLLMEvaluation({ verdict: "failed", pendingItems: 1 }, 100, 5)).toBe(false);
    expect(shouldUseLLMEvaluation({ verdict: "inconclusive", pendingItems: 0 }, 100, 5)).toBe(true);
    expect(shouldUseLLMEvaluation({ verdict: "inconclusive", pendingItems: 0 }, 0, 0)).toBe(false);
  });
});
