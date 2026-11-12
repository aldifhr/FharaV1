import { describe, expect, it } from "vitest";
import {
  canPauseForInput,
  directiveFor,
  firstReplanFeedback,
  isStepLimit,
  judgeObjective,
  resolveTargetAgent,
  reviewQaInFlight,
  shouldLatchBudgetHalt,
  shouldLatchComplete,
  vetoReplan,
  vetoSpawn,
  type OverrideState,
} from "@/orchestrator/decisionEngine";
import type { DecisionContext } from "@/orchestrator/decision";
import { loadPolicy } from "@/orchestrator/policy";
import type { AgentDefinition, ExecutionPlan, PlanSubtask } from "@/types";

/**
 * P1b phase 1: the runner's vetoes, now pure engine functions. These pin the
 * branches the golden event sequences (decisionEngine.golden.test.ts) do not
 * reach end to end: stage-loop and recovery replan deferral, the plan-has-QA
 * drop, the warn-mode budget halt, the first-pause-wins rule.
 */

const sub = (key: string, kind: PlanSubtask["kind"], capability: string, dependencies: string[] = []): PlanSubtask =>
  ({ key, title: key, description: key, kind, capability, dependencies, order: 0 }) as PlanSubtask;

const plan = (subtasks: PlanSubtask[]): ExecutionPlan =>
  ({ version: 1, goal: "g", strategy: "dag", requiresApproval: false, maxConcurrency: 1, subtasks }) as ExecutionPlan;

const state = (over: Partial<OverrideState> = {}): OverrideState => ({
  plan: plan([sub("a", "code_change", "frontend-development")]),
  nodeKey: "a",
  nodeKind: "code_change",
  completedKeys: new Set(["a"]),
  dynamicKeys: new Set(),
  executed: true,
  inStageLoop: false,
  plannedQaCount: 0,
  qaMode: "auto",
  budgetEnforced: true,
  budgetHalted: false,
  waitingForInput: false,
  ...over,
});

const agents = [
  { _id: "fe", name: "Frontend", role: "frontend", capabilities: ["frontend-development"], isEnabled: true },
  { _id: "be", name: "Backend", role: "backend", capabilities: ["backend-development"], isEnabled: true },
] as AgentDefinition[];

describe("decisionEngine.vetoSpawn", () => {
  it("never spawns an engine fix for a REVISE on a review node", () => {
    expect(vetoSpawn(state({ nodeKind: "review" }), "execute", [sub("fix", "code_change", "frontend-development")])).toEqual({
      kind: "suppressed_review_fix",
    });
  });

  it("defers dynamic QA to the QA stage, spawns the rest now", () => {
    const verdict = vetoSpawn(state(), "delegate", [sub("q", "analysis", "browser-testing"), sub("b", "code_change", "backend-development")]);
    expect(verdict).toMatchObject({ kind: "spawn", origin: "delegation", nodes: [{ key: "b" }] });
    if (verdict.kind !== "spawn") throw new Error("spawn expected");
    expect(verdict.qa).toMatchObject({ keys: ["q"], keep: true, reason: "dynamic QA runs in the post-apply QA stage" });
    expect(verdict.qa?.deferred.map((n) => n.kind)).toEqual(["qa"]);
  });

  it("drops dynamic QA when the plan has QA nodes, suppresses it under qaMode=never", () => {
    const planned = vetoSpawn(state({ plannedQaCount: 1 }), "delegate", [sub("q", "qa", "browser-testing")]);
    expect(planned).toMatchObject({ qa: { keep: false, reason: "plan already has QA nodes", deferred: [] } });
    const never = vetoSpawn(state({ qaMode: "never" }), "delegate", [sub("q", "qa", "browser-testing")]);
    expect(never).toMatchObject({ qa: { keep: false, reason: "qaMode=never" } });
  });

  it("an execute on a non-review node is a fix", () => {
    expect(vetoSpawn(state(), "execute", [sub("fix", "code_change", "frontend-development")])).toMatchObject({ origin: "fix", qa: null });
  });
});

describe("decisionEngine latches", () => {
  it("budget halt latches only in enforce mode, once", () => {
    expect(shouldLatchBudgetHalt(state())).toBe(true);
    expect(shouldLatchBudgetHalt(state({ budgetEnforced: false }))).toBe(false);
    expect(shouldLatchBudgetHalt(state({ budgetHalted: true }))).toBe(false);
  });

  it("complete latches for an executed node with nothing planned pending, outside stage loops", () => {
    expect(shouldLatchComplete(state(), "objective:met")).toBe(true);
    expect(shouldLatchComplete(state(), "delegation:declined")).toBe(false);
    expect(shouldLatchComplete(state({ executed: false }), "objective:met")).toBe(false);
    expect(shouldLatchComplete(state({ inStageLoop: true }), "objective:met")).toBe(false);
    const pending = state({ plan: plan([sub("a", "code_change", "x"), sub("b", "review", "code-review", ["a"])]) });
    expect(shouldLatchComplete(pending, "objective:met")).toBe(false);
  });

  it("replan defers for pending recovery, a stage loop, and a research angle", () => {
    expect(vetoReplan(state())).toBeNull();
    const recovery = state({ plan: plan([sub("a", "code_change", "x"), sub("fix", "code_change", "x")]), dynamicKeys: new Set(["fix"]) });
    expect(vetoReplan(recovery)).toBe("recovery_pending");
    expect(vetoReplan(state({ inStageLoop: true }))).toBe("stage_loop");
    const research = state({
      nodeKey: "ra-1",
      plan: plan([sub("ra-1", "research", "research"), sub("ra-2", "research", "research"), sub("synthesis", "research", "research", ["ra-1", "ra-2"])]),
    });
    expect(vetoReplan(research)).toBe("research_angle");
  });

  it("first replan feedback and first pause win", () => {
    expect(firstReplanFeedback(null, "b")).toBe("b");
    expect(firstReplanFeedback("a", "b")).toBe("a");
    expect(canPauseForInput(state())).toBe(true);
    expect(canPauseForInput(state({ waitingForInput: true }))).toBe(false);
  });

  it("flags the step bound", () => {
    expect(isStepLimit({ expectedOutcome: "decision:step_limit" })).toBe(true);
    expect(isStepLimit({ expectedOutcome: "objective:met" })).toBe(false);
  });
});

describe("decisionEngine.directiveFor", () => {
  it("folds each applied kind into one runner directive", () => {
    const execute = { action: "execute" as const };
    expect(directiveFor({ kind: "halt", reason: "r" }, execute, state({ budgetEnforced: false }), null)).toEqual({ kind: "none" });
    expect(directiveFor({ kind: "halt", reason: "r" }, execute, state(), null)).toEqual({ kind: "halt_budget", reason: "r" });
    expect(directiveFor({ kind: "complete", expectedOutcome: "objective:met" }, execute, state(), null)).toEqual({
      kind: "complete",
      expectedOutcome: "objective:met",
    });
    expect(directiveFor({ kind: "replan", reason: "late" }, execute, state(), "early")).toEqual({ kind: "replan", feedback: "early" });
    expect(directiveFor({ kind: "replan", reason: "r" }, execute, state({ inStageLoop: true }), null)).toEqual({ kind: "none" });
    expect(directiveFor({ kind: "ask_user", question: "q" }, execute, state({ waitingForInput: true }), null)).toEqual({ kind: "none" });
    expect(directiveFor({ kind: "call_agent", capability: "c", reasoning: "r" }, execute, state(), null)).toEqual({
      kind: "call_agent",
      capability: "c",
    });
  });
});

describe("decisionEngine.resolveTargetAgent", () => {
  it("delegate prefers the agent id, call_agent routes the capability", () => {
    expect(resolveTargetAgent({ action: "delegate", target: { agentId: "be", capability: "frontend-development" } }, agents, {})?._id).toBe("be");
    expect(resolveTargetAgent({ action: "call_agent", target: { agentId: "be", capability: "frontend-development" } }, agents, {})?._id).toBe("fe");
    expect(resolveTargetAgent({ action: "delegate", target: undefined }, agents, {})).toBeUndefined();
  });
});

describe("decisionEngine.judgeObjective", () => {
  const context = (p: ExecutionPlan, completed: string[]): DecisionContext =>
    ({
      taskId: "t",
      objective: "o",
      classification: { kind: "code_change", strategy: "single", reasons: [], suggestedCapabilities: [] },
      planVersion: 1,
      plan: p,
      results: [],
      openIssues: [],
      budget: {} as DecisionContext["budget"],
      policy: loadPolicy(),
      agents,
      completedKeys: new Set(completed),
      step: 0,
    }) as DecisionContext;
  const base = (p: ExecutionPlan, completed: string[], over: Record<string, unknown> = {}) => ({
    context: context(p, completed),
    nodeKey: "a",
    executed: true,
    inStageLoop: false,
    completed: true,
    dynamicKeys: new Set<string>(),
    appliedFilesBySubtask: new Map<string, string[]>(),
    qaVerdicts: {},
    ...over,
  });

  it("an executed empty code_change is unmet", () => {
    const j = judgeObjective(base(plan([sub("a", "code_change", "x")]), ["a"]));
    expect(j.source).toBe("empty_code_change");
    expect(j.state.met).toBe(false);
    expect(j.unmet?.missing).toEqual(["a: code_change completed with no applied file change"]);
  });

  it("defers for a skipped node, a stage-loop fix, and review/QA in flight", () => {
    const withReview = plan([sub("a", "code_change", "x"), sub("r", "review", "code-review", ["a"])]);
    const files = new Map([["a", ["f.ts"]]]);
    expect(judgeObjective(base(withReview, ["a"], { appliedFilesBySubtask: files })).source).toBe("deferred");
    expect(reviewQaInFlight(withReview, new Set(), new Set(["a"]))).toBe(true);
    expect(judgeObjective(base(plan([sub("a", "code_change", "x")]), ["a"], { executed: false })).source).toBe("deferred");
    expect(judgeObjective(base(plan([sub("a", "code_change", "x")]), ["a"], { inStageLoop: true })).state.met).toBe(true);
  });

  it("otherwise evaluates the objective", () => {
    const j = judgeObjective(base(plan([sub("a", "code_change", "x")]), ["a"], { appliedFilesBySubtask: new Map([["a", ["f.ts"]]]) }));
    expect(j).toMatchObject({ source: "evaluated", state: { met: true }, unmet: null });
  });
});
