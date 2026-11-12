import { describe, expect, it } from "vitest";
import { decideReplan, type ReplanFacts, type ReplanTrigger } from "@/orchestrator/decisionEngine";

/**
 * P1b phase 2 (one replan owner): decideReplan answers every replan
 * trigger the runner used to decide inline (taskRunner's three sites and
 * executePlan's acceptance / coverage gates). The processTask-level
 * sequences are pinned by tests/decisionEngine.golden.test.ts (replan-*);
 * these cover each branch, including the ones a golden cannot reach cheaply
 * (coverage gaps, a verify-fix terminal failure, cancellation).
 */

const NOOP = "implement: No effective change: a.txt would be identical to the current content";
const HOLD = "implement: LLM request failed (429) for model m: Too Many Requests";
const decide = (trigger: ReplanTrigger, facts: Partial<ReplanFacts>, reason?: string) =>
  decideReplan({ kind: "replan_trigger", trigger, reason, facts: { replansLeft: 1, ...facts } });

describe("decideReplan: objective_unmet (executePlan returned status replan)", () => {
  it("replans with the objective prefix, or the gate's own reason", () => {
    expect(decide("objective_unmet", {}, "x missing")).toEqual({ kind: "replan", reason: "Objective not satisfied: x missing" });
    expect(decide("objective_unmet", {})).toEqual({ kind: "replan", reason: "Objective not satisfied: objective not satisfied" });
    for (const own of ["Escalation from subtask a: b", "Acceptance gates failed: a", "Requirements not covered: r1", "Architecture decision: revise x"]) {
      expect(decide("objective_unmet", {}, own)).toEqual({ kind: "replan", reason: own });
    }
  });
  it("a provider hold (in the reason or the feedback) wins over a replan", () => {
    expect(decide("objective_unmet", { feedback: [HOLD] }, "x")).toEqual({
      kind: "fail",
      message: "LLM request failed (429) for model m: Too Many Requests",
      cause: "provider_hold",
    });
  });
  it("a no-op ends as already done, never a replan", () => {
    expect(decide("objective_unmet", { feedback: [NOOP], fileChanges: { size: 0 } }, "x")).toEqual({ kind: "already_done", files: ["a.txt"] });
    // A staged change is not a no-op.
    expect(decide("objective_unmet", { feedback: [NOOP], fileChanges: { size: 1 } }, "x").kind).toBe("replan");
  });
  it("with no replan left it fails with the missing list and the replan count", () => {
    expect(decide("objective_unmet", { replansLeft: 0, replans: 2 }, "x missing")).toEqual({
      kind: "fail",
      message: "Objective not satisfied after 2 replan(s): x missing",
      cause: "exhausted",
    });
  });
});

describe("decideReplan: terminal_failure (executePlan returned status failed)", () => {
  it("cancellation wins over everything", () => {
    expect(decide("terminal_failure", { aborted: true, feedback: ["s1: Budget exhausted: calls"] })).toEqual({ kind: "cancel" });
  });
  it("a budget stop is terminal, then a hold, then a no-op, then a verify-fix terminal failure", () => {
    expect(decide("terminal_failure", { feedback: ["s1 (attempt 1): Budget exhausted: max calls", HOLD] })).toEqual({
      kind: "budget_exhausted",
      reason: "max calls",
    });
    expect(decide("terminal_failure", { feedback: [HOLD, NOOP] }).kind).toBe("fail");
    expect(decide("terminal_failure", { feedback: [NOOP] })).toEqual({ kind: "already_done", files: ["a.txt"] });
    expect(decide("terminal_failure", { feedback: [NOOP], terminalFailure: "Verification fix changed nothing" })).toEqual({
      kind: "fail",
      message: "Verification fix changed nothing",
      cause: "terminal_failure",
    });
  });
  it("otherwise replans on the failure summary, or fails with it", () => {
    expect(decide("terminal_failure", { feedback: ["a: boom", "", "b: bang"] })).toEqual({
      kind: "replan",
      reason: "a: boom; b: bang",
      eventFeedback: "a: boom; b: bang",
      timedOutFrom: "a: boom; b: bang",
    });
    expect(decide("terminal_failure", { replansLeft: 0, feedback: [] })).toEqual({
      kind: "fail",
      message: "Execution failed without a detailed error. Check the task events for the failing subtask.",
      cause: "exhausted",
    });
  });
});

describe("decideReplan: verify_failed (finalize verdict failed)", () => {
  it("replans with the failed checks, cancels when aborted, proceeds with none left", () => {
    expect(decide("verify_failed", {}, "Verification failed: tests: 1 failed")).toEqual({ kind: "replan", reason: "Verification failed: tests: 1 failed" });
    expect(decide("verify_failed", { aborted: true }, "v")).toEqual({ kind: "cancel" });
    // No replan left: the completion path runs (an aborted run included, as before).
    expect(decide("verify_failed", { replansLeft: 0, aborted: true }, "v")).toEqual({ kind: "proceed" });
  });
});

describe("decideReplan: executePlan gates", () => {
  it("acceptance_rejected: hand a replan back, or block with the reason", () => {
    expect(decide("acceptance_rejected", {}, "Acceptance gates failed: a: b")).toEqual({ kind: "replan", reason: "Acceptance gates failed: a: b" });
    expect(decide("acceptance_rejected", { replansLeft: 0 }, "Acceptance gates failed: a: b")).toEqual({ kind: "block", message: "Acceptance gates failed: a: b" });
  });
  it("coverage_gaps: hand a replan back, or complete with gaps", () => {
    expect(decide("coverage_gaps", {}, "Requirements not covered: r1")).toEqual({ kind: "replan", reason: "Requirements not covered: r1" });
    expect(decide("coverage_gaps", { replansLeft: 0 }, "Requirements not covered: r1")).toEqual({
      kind: "block",
      message: "Completed with gaps. Requirements not covered: r1",
    });
  });
});
