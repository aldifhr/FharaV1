import { describe, expect, it } from "vitest";
import type { ExecutionPlan, PlanSubtask } from "@/types";
import {
  buildReplanScope,
  checkReplanQuality,
  computeImpact,
  diffPlans,
  frozenNodesFor,
  normalizeText,
  preserveFrozen,
  resolveFailedKeys,
  stripReplanAnnotations,
} from "@/orchestrator/replanIntelligence";
import { validatePlan } from "@/orchestrator/planValidator";

const node = (key: string, deps: string[] = [], extra: Partial<PlanSubtask> = {}): PlanSubtask => ({
  key,
  title: `Title ${key}`,
  description: `Do ${key}`,
  kind: "code_change",
  capability: "frontend-development",
  dependencies: deps,
  order: 0,
  ...extra,
});

const plan = (subtasks: PlanSubtask[]): ExecutionPlan => ({
  version: 1,
  goal: "g",
  strategy: "dag",
  requiresApproval: false,
  maxConcurrency: 1,
  subtasks: subtasks.map((subtask, order) => ({ ...subtask, order })),
});

// a → b → d, a → c, e (independent)
const base = plan([
  node("a"),
  node("b", ["a"]),
  node("c", ["a"]),
  node("d", ["b"]),
  node("e"),
  node("qa", ["d"], { kind: "qa", capability: "qa-testing" }),
]);

describe("Dependency Impact", () => {
  it("computes the transitive downstream set of the failed node(s), in plan order", () => {
    expect(computeImpact(base.subtasks, ["b"])).toEqual(["d", "qa"]);
    expect(computeImpact(base.subtasks, ["a"])).toEqual(["b", "c", "d", "qa"]);
    expect(computeImpact(base.subtasks, ["e"])).toEqual([]);
    // Two failures: union, failed ones excluded.
    expect(computeImpact(base.subtasks, ["b", "c"])).toEqual(["d", "qa"]);
  });

  it("resolves failed keys from the runner's failure facts, ignoring nodes that were only blocked", () => {
    const facts = [
      'b: Subtask timed out after 300000ms',
      'd: Dependency deadlock: waits on "b" (failed)',
    ];
    expect(resolveFailedKeys(base, facts)).toEqual(["b"]);
    expect(resolveFailedKeys(base, ["Acceptance gates failed: c: typecheck failed; e: tests failed"])).toEqual(["c", "e"]);
    expect(resolveFailedKeys(base, ["Escalation from subtask d: schema change"])).toEqual(["d"]);
    expect(resolveFailedKeys(base, ["Verification failed: typecheck: 3 errors"])).toEqual([]);
    expect(resolveFailedKeys(base, ["anything"], ["c", "zzz"])).toEqual(["c"]);
    expect(resolveFailedKeys(base, ["c (attempt 2): LLM request failed (503)"])).toEqual(["c"]);
  });

  it("frozen = valid completed nodes outside the failure, never QA / dynamic / rejected reviews", () => {
    const withReview = plan([...base.subtasks, node("rev", ["a"], { kind: "review", capability: "code-review" }), node("fix", ["a"], { origin: "dynamic" })]);
    const frozen = frozenNodesFor({
      plan: withReview,
      completed: ["a", "c", "e", "qa", "rev", "fix", "b"],
      failedKeys: ["b"],
      impactKeys: ["d", "qa"],
      reviewVerdicts: { rev: { verdict: "changes_requested" } },
    });
    expect(frozen).toEqual(["a", "c", "e"]);
  });
});

describe("Preservation Guard", () => {
  it("restores a frozen node the planner rewrote, verbatim, and reports it", () => {
    const next = plan([
      node("a", [], { description: "Do a but differently" }),
      node("b2", ["a"], { description: "New approach for b", replanReasoning: "b failed on timeout; split scope" }),
      node("c", ["a"]),
      node("e"),
    ]);
    const guarded = preserveFrozen(base, next, ["a", "c", "e"]);
    expect(guarded.restored).toEqual(["a"]);
    const a = guarded.plan.subtasks.find((subtask) => subtask.key === "a")!;
    expect(a.description).toBe("Do a");
    expect(guarded.plan.subtasks.find((subtask) => subtask.key === "b2")?.description).toBe("New approach for b");
  });
});

describe("Replan Quality Check", () => {
  const good = plan([
    node("a"),
    node("b2", ["a"], { description: "Split b: only the header component", replanReasoning: "b timed out; narrower scope" }),
    node("c", ["a"]),
    node("d", ["b2"], { replanReasoning: "now depends on the split node" }),
    node("e"),
  ]);

  it("accepts a plan that changes the failed strategy and keeps every frozen node", () => {
    const quality = checkReplanQuality({ previous: base, next: good, failedKeys: ["b"], frozenKeys: ["a", "c", "e"] });
    expect(quality.hard).toEqual([]);
    expect(quality.ok).toBe(true);
  });

  it("rejects a repeated failed node (same objective, agent, approach after normalization), even under a new key", () => {
    const repeat = plan([
      node("a"),
      // Same text modulo case / punctuation / whitespace: no meaningful change.
      node("b_retry", ["a"], { title: "TITLE  b!", description: "do   B.", replanReasoning: "retry" }),
      node("c", ["a"]),
      node("e"),
    ]);
    const quality = checkReplanQuality({ previous: base, next: repeat, failedKeys: ["b"], frozenKeys: ["a", "c", "e"] });
    expect(quality.ok).toBe(false);
    expect(quality.hard.map((violation) => violation.code)).toEqual(["repeated_failed_strategy"]);
    expect(quality.hard[0].key).toBe("b_retry");
    // A different agent (capability) is a meaningful change.
    const otherAgent = plan([node("a"), node("b", ["a"], { capability: "backend-development", replanReasoning: "backend owns it" }), node("c", ["a"]), node("e")]);
    expect(checkReplanQuality({ previous: base, next: otherAgent, failedKeys: ["b"], frozenKeys: ["a", "c", "e"] }).hard).toEqual([]);
  });

  it("rejects a plan that drops a frozen node", () => {
    const dropped = plan([node("a"), node("b2", ["a"], { description: "x", replanReasoning: "r" }), node("e")]);
    const quality = checkReplanQuality({ previous: base, next: dropped, failedKeys: ["b"], frozenKeys: ["a", "c", "e"] });
    expect(quality.ok).toBe(false);
    expect(quality.hard.map((violation) => [violation.code, violation.key])).toEqual([["dropped_frozen_node", "c"]]);
  });

  it("rejects a plan with a cycle (and a dangling dependency)", () => {
    const cyclic = plan([
      node("a"),
      node("x", ["y"], { replanReasoning: "r" }),
      node("y", ["x"], { replanReasoning: "r" }),
      node("c", ["a"]),
      node("e"),
      node("z", ["gone"], { replanReasoning: "r" }),
    ]);
    const quality = checkReplanQuality({ previous: base, next: cyclic, failedKeys: ["b"], frozenKeys: ["a", "c", "e"] });
    const codes = quality.hard.map((violation) => violation.code);
    expect(codes).toContain("dependency_cycle");
    expect(codes).toContain("dangling_dependency");
    expect(quality.hard.find((violation) => violation.code === "dependency_cycle")?.message).toMatch(/x -> y -> x|y -> x -> y/);
  });

  it("flags a changed node without replanReasoning as soft (retry, never a reject on its own)", () => {
    const noReason = plan([node("a"), node("b2", ["a"], { description: "new" }), node("c", ["a"]), node("e")]);
    const quality = checkReplanQuality({ previous: base, next: noReason, failedKeys: ["b"], frozenKeys: ["a", "c", "e"] });
    expect(quality.ok).toBe(false);
    expect(quality.hard).toEqual([]);
    expect(quality.violations).toEqual([expect.objectContaining({ code: "missing_reasoning", key: "b2", soft: true })]);
  });

  it("normalizes text for comparison", () => {
    expect(normalizeText("  Fix: the HEADER,  now! ")).toBe("fix the header now");
  });
});

describe("Replan Diff", () => {
  it("classifies added / removed / modified / preserved with reasoning and scope", () => {
    const next = plan([
      node("a"),
      node("b2", ["a"], { description: "Split b", replanReasoning: "b timed out" }),
      node("c", ["a"]),
      node("d", ["b2"], { replanReasoning: "re-pointed at b2" }),
      node("e", [], { description: "Do e better", replanReasoning: "while here" }),
    ]);
    const diff = diffPlans({
      previous: base,
      next,
      frozenKeys: ["a", "c"],
      restoredKeys: ["a"],
      failedKeys: ["b"],
      impactKeys: ["d", "qa"],
      removals: [{ key: "b", reasoning: "replaced by b2" }],
    });
    expect(diff.added).toEqual([expect.objectContaining({ key: "b2", reasoning: "b timed out" })]);
    expect(diff.removed.map((entry) => [entry.key, entry.reasoning])).toEqual([
      ["b", "replaced by b2"],
      ["qa", undefined],
    ]);
    expect(diff.modified).toEqual([
      expect.objectContaining({ key: "d", fields: ["dependencies"], reasoning: "re-pointed at b2" }),
      expect.objectContaining({ key: "e", fields: ["description"], outsideImpact: true }),
    ]);
    expect(diff.preserved).toEqual([
      expect.objectContaining({ key: "a", frozen: true, restored: true }),
      expect.objectContaining({ key: "c", frozen: true }),
    ]);
  });

  it("planner output keeps replanReasoning / replanRemovals through validation; strip removes them before persist", () => {
    const validated = validatePlan(
      {
        goal: "g",
        subtasks: [{ key: "x", title: "X", description: "d", kind: "analysis", capability: "general", dependencies: [], replanReasoning: " because " }],
        replanRemovals: [{ key: "Y", reasoning: "gone" }, { key: 1 }],
      },
      8
    );
    expect(validated.ok).toBe(true);
    expect(validated.plan?.subtasks[0].replanReasoning).toBe("because");
    expect(validated.plan?.replanRemovals).toEqual([{ key: "y", reasoning: "gone" }]);
    const stripped = stripReplanAnnotations(validated.plan as ExecutionPlan);
    expect(stripped.subtasks[0]).not.toHaveProperty("replanReasoning");
    expect(stripped).not.toHaveProperty("replanRemovals");
  });

  it("scope block names failed, impact and frozen nodes and asks for reasoning", () => {
    const text = buildReplanScope({ plan: base, failedKeys: ["b"], impactKeys: ["d", "qa"], frozenKeys: ["a", "c", "e"], facts: ["b: boom"] });
    expect(text).toContain("REPLAN SCOPE");
    expect(text).toContain("- b [code_change/frontend-development]");
    expect(text).toContain("Affected downstream (re-plan these as needed): d, qa");
    expect(text).toContain("FROZEN completed nodes");
    expect(text).toContain("- e [code_change/frontend-development]");
    expect(text).toContain('"replanReasoning"');
  });
});
