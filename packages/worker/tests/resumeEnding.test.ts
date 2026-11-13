import { describe, expect, it } from "vitest";
import { decideReplan } from "@/orchestrator/decisionEngine";
import { decideResumeEnding } from "@/services/runner/resumeEnding";

/**
 * Fixall: a resumed run's "replan" / "failed" ending is decideReplan's, so
 * it decides exactly like a fresh run with no replan left.
 */
const NOOP = "implement: No effective change: a.txt would be identical to the current content";
const state = (feedback: string[], extra: { staged?: number; terminalFailure?: string } = {}) => ({
  feedback,
  fileChanges: new Map(Array.from({ length: extra.staged ?? 0 }, (_, i) => [`f${i}`, {} as never])),
  ...(extra.terminalFailure ? { terminalFailure: extra.terminalFailure } : {}),
});

describe("decideResumeEnding", () => {
  it("matches decideReplan for a fresh run with no replan left", () => {
    const s = state(["implement: Permission denied: cannot write"]);
    const fresh = decideReplan({
      kind: "replan_trigger",
      trigger: "terminal_failure",
      facts: { replansLeft: 0, replans: 0, feedback: s.feedback, fileChanges: s.fileChanges, aborted: false },
    });
    expect(decideResumeEnding({ status: "failed", state: s, aborted: false })).toEqual(fresh);
  });

  it("objective unmet uses the fresh message prefix", () => {
    expect(decideResumeEnding({ status: "replan", replanFeedback: "a.txt missing", state: state([]), aborted: false })).toEqual({
      kind: "fail",
      message: "Objective not satisfied after 0 replan(s): a.txt missing",
      cause: "exhausted",
    });
  });

  it("objective unmet with only a no-op failure is already done", () => {
    expect(decideResumeEnding({ status: "replan", replanFeedback: "x", state: state([NOOP]), aborted: false })).toEqual({
      kind: "already_done",
      files: ["a.txt"],
    });
  });

  it("objective unmet behind a provider hold holds with the provider message", () => {
    const next = decideResumeEnding({
      status: "replan",
      replanFeedback: "x",
      state: state(["implement (attempt 1): LLM request failed (429) for model m: Too Many Requests"]),
      aborted: false,
    });
    expect(next).toEqual({ kind: "fail", message: "LLM request failed (429) for model m: Too Many Requests", cause: "provider_hold" });
  });

  it("a failure that is really a cancellation cancels", () => {
    expect(decideResumeEnding({ status: "failed", state: state(["implement: Execution cancelled"]), aborted: true })).toEqual({ kind: "cancel" });
  });

  it("a failed run behind a provider hold holds with the provider message", () => {
    expect(
      decideResumeEnding({ status: "failed", state: state(["implement: LLM request failed (429) for model m: Too Many Requests"]), aborted: false })
    ).toEqual({ kind: "fail", message: "LLM request failed (429) for model m: Too Many Requests", cause: "provider_hold" });
  });

  it("a failed run with no feedback uses the fresh no-detail summary", () => {
    expect(decideResumeEnding({ status: "failed", state: state([]), aborted: false })).toEqual({
      kind: "fail",
      message: "Execution failed without a detailed error. Check the task events for the failing subtask.",
      cause: "exhausted",
    });
  });

  it("a verify-fix loop's own terminal failure wins over the joined feedback", () => {
    expect(
      decideResumeEnding({ status: "failed", state: state(["v: tests failed"], { terminalFailure: "Verification could not change anything" }), aborted: false })
    ).toEqual({ kind: "fail", message: "Verification could not change anything", cause: "terminal_failure" });
  });

  it("a budget stop stays a budget stop, and a staged change is never a no-op", () => {
    expect(decideResumeEnding({ status: "failed", state: state(["s1: Budget exhausted: max LLM calls reached"]), aborted: false })).toEqual({
      kind: "budget_exhausted",
      reason: "max LLM calls reached",
    });
    expect(decideResumeEnding({ status: "failed", state: state([NOOP], { staged: 1 }), aborted: false })).toMatchObject({ kind: "fail" });
  });
});
