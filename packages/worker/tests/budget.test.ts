import { describe, expect, it } from "vitest";
import { BudgetTracker } from "@/orchestrator/budget";
import { loadPolicy } from "@/orchestrator/policy";

describe("budget", () => {
  it("tracks calls and tokens", () => {
    const p = loadPolicy();
    const b = new BudgetTracker(p);
    b.recordLLMCall({ inputTokens: 100, outputTokens: 50, model: "m", agentName: "A" });
    expect(b.llmCallCount).toBe(1);
    expect(b.totalTokens).toBe(150);
  });
});
