import { describe, expect, it } from "vitest";
import { buildReplanFeedback, completedSubtasksFor } from "@/services/runner/setup";

const plan = {
  subtasks: [
    { key: "a", kind: "code_change", capability: "frontend-development", description: "Add logout button" },
    { key: "b", kind: "review", capability: "code-review", description: "Review the logout change" },
  ],
} as any;

const emptyContext = { decisions: [], outstandingIssues: [] } as any;

describe("replan feedback lists completed work", () => {
  it("returns only subtasks of the plan that produced output", () => {
    const state = { priorOutputs: new Map([["a", "changed Navbar.tsx"]]) };
    expect(completedSubtasksFor(plan, state)).toEqual([
      { key: "a", kind: "code_change", capability: "frontend-development", description: "Add logout button" },
    ]);
  });

  it("skips stale keys instead of using their output as a description", () => {
    const state = { priorOutputs: new Map([["gone", "some long agent output"]]) };
    expect(completedSubtasksFor(plan, state)).toEqual([]);
  });

  it("puts the verbatim descriptions in the feedback", () => {
    const state = { priorOutputs: new Map([["a", "ok"]]) };
    const feedback = buildReplanFeedback("Verification failed: build", emptyContext, completedSubtasksFor(plan, state));
    expect(feedback).toContain("Already completed");
    expect(feedback).toContain("a: [code_change/frontend-development] Add logout button");
  });
});
