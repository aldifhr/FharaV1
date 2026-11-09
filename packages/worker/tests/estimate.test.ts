import { describe, expect, it } from "vitest";
import {
  criticalPath,
  DEFAULT_DURATION_MS,
  DEFAULT_TOKENS,
  estimatePlan,
  formatEstimateLine,
  median,
  quantile,
  samplesFromUsage,
  type EstimateSample,
} from "@/api/convex/lib/estimate";
import { buildPlanEstimate } from "@/services/runner/planReview";
import type { AgentDefinition, ExecutionPlan } from "@/types";

/**
 * Task Estimator math (apps/api/convex/lib/estimate.ts): deterministic,
 * median per kind+role with kind and default fallbacks, priced cost,
 * critical-path duration range.
 */

const sample = (kind: string, role: string, inputTokens: number, outputTokens: number, durationMs?: number): EstimateSample => ({
  kind,
  role,
  inputTokens,
  outputTokens,
  durationMs,
});

const HISTORY: EstimateSample[] = [
  // frontend code_change: 3 samples → role tier
  sample("code_change", "frontend", 10_000, 2_000, 60_000),
  sample("code_change", "frontend", 20_000, 4_000, 120_000),
  sample("code_change", "frontend", 40_000, 6_000, 300_000),
  // backend code_change: only 1 sample → falls back to the kind tier (4 code_change samples)
  sample("code_change", "backend", 30_000, 3_000, 90_000),
  // reviews: 2 samples → below MIN_SAMPLES for both tiers → defaults
  sample("review", "reviewer", 5_000, 500),
  sample("review", "reviewer", 7_000, 700),
];

const SUBTASKS = [
  { key: "api", kind: "code_change", role: "backend", dependencies: [] },
  { key: "ui", kind: "code_change", role: "frontend", dependencies: ["api"] },
  { key: "docs", kind: "code_change", role: "frontend", dependencies: [] },
  { key: "review", kind: "review", role: "reviewer", dependencies: ["ui", "docs"] },
];

describe("estimator helpers", () => {
  it("quantile / median interpolate on a sorted copy", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(quantile([0, 100], 0.25)).toBe(25);
    expect(quantile([], 0.5)).toBe(0);
  });

  it("criticalPath takes the longest dependency chain", () => {
    const weights: Record<string, number> = { api: 5, ui: 3, docs: 1, review: 2 };
    expect(criticalPath(SUBTASKS, (k) => weights[k])).toBe(10); // api → ui → review
  });

  it("samplesFromUsage sums rows per (task, subtask) and skips unknown kind/role", () => {
    const samples = samplesFromUsage([
      { taskId: "t1", subtaskKey: "a", kind: "code_change", role: "frontend", inputTokens: 100, outputTokens: 10, durationMs: 5 },
      { taskId: "t1", subtaskKey: "a", kind: "code_change", role: "frontend", inputTokens: 50, outputTokens: 5, durationMs: 9 },
      { taskId: "t2", subtaskKey: "a", kind: "code_change", role: "frontend", inputTokens: 1, outputTokens: 1 },
      { taskId: "t3", subtaskKey: "x", kind: null, role: "frontend", inputTokens: 999, outputTokens: 999 },
    ]);
    expect(samples).toEqual([
      { kind: "code_change", role: "frontend", inputTokens: 150, outputTokens: 15, durationMs: 9 },
      { kind: "code_change", role: "frontend", inputTokens: 1, outputTokens: 1, durationMs: null },
    ]);
  });
});

describe("estimatePlan", () => {
  const models = {
    frontend: { model: "fast-model", inputPricePer1k: 0.001, outputPricePer1k: 0.002 },
    backend: { model: "big-model", inputPricePer1k: 0.003, outputPricePer1k: 0.015 },
    reviewer: { model: "unpriced-model" },
  };
  const estimate = estimatePlan({ subtasks: SUBTASKS, samples: HISTORY, models, maxConcurrency: 2, now: 42 });
  const by = Object.fromEntries(estimate.perSubtask.map((s) => [s.key, s]));

  it("uses role medians, then kind medians, then defaults", () => {
    expect(by.ui).toMatchObject({ source: "role", inputTokens: 20_000, outputTokens: 4_000 });
    // kind tier over the 4 code_change samples: median(10k,20k,30k,40k)=25k; out median(2k,3k,4k,6k)=3.5k
    expect(by.api).toMatchObject({ source: "kind", inputTokens: 25_000, outputTokens: 3_500 });
    expect(by.review).toMatchObject({
      source: "default",
      inputTokens: DEFAULT_TOKENS.review.input,
      outputTokens: DEFAULT_TOKENS.review.output,
    });
    expect(estimate.basis).toEqual({ fromRole: 2, fromKind: 1, fromDefault: 1, samples: HISTORY.length });
  });

  it("sums tokens and prices only what has pricing", () => {
    const total =
      by.api.inputTokens + by.api.outputTokens + by.ui.inputTokens + by.ui.outputTokens +
      by.docs.inputTokens + by.docs.outputTokens + by.review.inputTokens + by.review.outputTokens;
    expect(estimate.tokens.total).toBe(total);
    expect(by.ui.cost).toBeCloseTo(20 * 0.001 + 4 * 0.002, 10); // 0.028
    expect(by.api.cost).toBeCloseTo(25 * 0.003 + 3.5 * 0.015, 10); // 0.1275
    expect(by.review.cost).toBeNull();
    expect(estimate.cost).toBeCloseTo(0.028 * 2 + 0.1275, 10);
    expect(estimate.costPartial).toBe(true);
  });

  it("duration range: critical path of p25 (low) to max(critical path of p75, serial/concurrency) (high)", () => {
    // role tier durations for frontend: [60k,120k,300k] → p25 90k, p50 120k, p75 210k
    expect(by.ui.durationMs).toEqual({ low: 90_000, mid: 120_000, high: 210_000 });
    // kind tier durations: [60k,90k,120k,300k] → p25 82.5k, p75 165k
    expect(by.api.durationMs).toEqual({ low: 82_500, mid: 105_000, high: 165_000 });
    const reviewDefault = DEFAULT_DURATION_MS.review;
    expect(by.review.durationMs).toEqual({ low: reviewDefault * 0.6, mid: reviewDefault, high: reviewDefault * 1.6 });
    expect(estimate.durationMs.low).toBe(82_500 + 90_000 + reviewDefault * 0.6);
    const highPath = 165_000 + 210_000 + reviewDefault * 1.6;
    const serial = (165_000 + 210_000 + 210_000 + reviewDefault * 1.6) / 2;
    expect(estimate.durationMs.high).toBe(Math.max(highPath, Math.round(serial)));
  });

  it("is deterministic and counts agents by role", () => {
    expect(estimatePlan({ subtasks: SUBTASKS, samples: HISTORY, models, maxConcurrency: 2, now: 42 })).toEqual(estimate);
    expect(estimate.agentCount).toBe(3);
    expect(estimate.subtaskCount).toBe(4);
    expect(estimate.roles.find((r) => r.role === "frontend")).toEqual({ role: "frontend", model: "fast-model", subtasks: 2 });
  });

  it("formats the one-line label", () => {
    expect(
      formatEstimateLine({ tokens: { input: 100_000, output: 20_000, total: 120_000 }, cost: 0.4249, costPartial: false, durationMs: { low: 240_000, high: 540_000 } })
    ).toBe("Est. ~120k tokens · ~$0.42 · ~4–9m");
    expect(
      formatEstimateLine({ tokens: { input: 1, output: 1, total: 2 }, cost: null, costPartial: false, durationMs: { low: 60_000, high: 60_000 } })
    ).toBe("Est. ~2 tokens · ~1m");
  });
});

describe("buildPlanEstimate (worker wiring)", () => {
  it("routes subtasks like the scheduler and uses the resolver's expected model per role", () => {
    const plan = {
      version: 1,
      goal: "g",
      strategy: "dag",
      requiresApproval: true,
      maxConcurrency: 1,
      subtasks: [
        { key: "a", title: "A", description: "", kind: "code_change", capability: "frontend-development", dependencies: [], order: 0 },
        { key: "b", title: "B", description: "", kind: "review", capability: "code-review", dependencies: ["a"], order: 1 },
      ],
    } as ExecutionPlan;
    const agents = [
      { _id: "1", name: "Frontend", role: "frontend", capabilities: ["frontend-development"], isEnabled: true, llmModelId: "m-fe" },
      { _id: "2", name: "Reviewer", role: "reviewer", capabilities: ["code-review"], isEnabled: true },
    ] as AgentDefinition[];
    const estimate = buildPlanEstimate({
      plan,
      agents,
      samples: [],
      expectedModel: (agent) => (agent.llmModelId ? { model: agent.llmModelId, inputPricePer1k: 0.01, outputPricePer1k: 0.01 } : null),
      now: 1,
    });
    expect(estimate.perSubtask.map((s) => [s.key, s.role, s.model])).toEqual([
      ["a", "frontend", "m-fe"],
      ["b", "reviewer", null],
    ]);
    // maxConcurrency 1: the high end is at least the serial sum.
    const serial = estimate.perSubtask.reduce((sum, s) => sum + s.durationMs.high, 0);
    expect(estimate.durationMs.high).toBe(serial);

    // Decision Outcome Calibration: the project's per-role × complexity
    // multiplier reaches the routed role only.
    const calibrated = buildPlanEstimate({
      plan,
      agents,
      samples: [],
      expectedModel: () => null,
      now: 1,
      multipliers: [{ role: "frontend", complexity: "high", tokens: 2 }],
      complexity: "high",
    });
    const plain = buildPlanEstimate({ plan, agents, samples: [], expectedModel: () => null, now: 1 });
    expect(calibrated.perSubtask[0].inputTokens).toBe(plain.perSubtask[0].inputTokens * 2);
    expect(calibrated.perSubtask[1].inputTokens).toBe(plain.perSubtask[1].inputTokens);
    expect(calibrated.calibrated).toBe(true);
  });
});
