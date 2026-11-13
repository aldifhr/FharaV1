import { describe, expect, it } from "vitest";
import {
  FAILURE_KINDS,
  decideApprovalGate,
  decideStageOrder,
  failureKindForEnding,
  failureKindForExit,
  isFailureKind,
  reviewFixRoundsSpent,
} from "@/orchestrator/decisionEngine";
import { failTaskWithError, failStepLimit, finishCancelledTask } from "@/services/runner/terminal";
import { createFakeApi, createRunnerDeps, testPolicy, testTask } from "./helpers";

describe("decideStageOrder", () => {
  it("verified_first only when the writes land in the task worktree", () => {
    expect(decideStageOrder({ workspacePath: "/w/wt", worktreePath: "/w/wt/" })).toEqual({ order: "verified_first", reason: "isolated_worktree" });
    expect(decideStageOrder({ workspacePath: "/w/repo" })).toEqual({ order: "legacy", reason: "no_worktree" });
    expect(decideStageOrder({ workspacePath: "/w/repo", worktreePath: "/w/wt" })).toEqual({ order: "legacy", reason: "worktree_not_workspace" });
  });
});

describe("decideApprovalGate", () => {
  const base = { reviewRequired: true, snapshotId: "s2", reviewBySnapshot: { s1: "approved", s2: "approved" } as const, approvalResolved: false, approvedSnapshotId: "s1" };
  it("asks only for a snapshot whose latest review verdict is approve", () => {
    expect(decideApprovalGate(base)).toEqual({ kind: "ask" });
    expect(decideApprovalGate({ ...base, reviewBySnapshot: { s1: "approved" } })).toEqual({ kind: "block", reason: "unreviewed" });
    expect(decideApprovalGate({ ...base, reviewBySnapshot: { s2: "changes_requested" } })).toEqual({ kind: "block", reason: "review_rejected" });
    expect(decideApprovalGate({ ...base, reviewRequired: false, reviewBySnapshot: {} })).toEqual({ kind: "ask" });
  });
  it("a resumed approval covers only the snapshot it was given for", () => {
    expect(decideApprovalGate({ ...base, approvalResolved: true, approvedSnapshotId: "s2" })).toEqual({ kind: "covered" });
    expect(decideApprovalGate({ ...base, approvalResolved: true, approvedSnapshotId: "s1" })).toEqual({ kind: "ask" });
  });
  it("review fix rounds already spent continue the one budget", () => {
    expect(reviewFixRoundsSpent([{ key: "api" }, { key: "review_fix_1" }, { key: "review_fix_2" }, { key: "fix_qa_1" }])).toBe(2);
  });
});

describe("failureKindForExit / failureKindForEnding", () => {
  it("cancel and the step bound win; explicit kinds, budget halts and the phase follow", () => {
    expect(failureKindForExit({ status: "cancelled", explicit: "no_change" })).toBe("cancelled");
    expect(failureKindForExit({ status: "step_limit" })).toBe("budget_exhausted");
    expect(failureKindForExit({ status: "completed", phaseKind: "qa_failed" })).toBeUndefined();
    expect(failureKindForExit({ status: "waiting_approval" })).toBeUndefined();
    expect(failureKindForExit({ status: "failed", explicit: "no_change", phaseKind: "review_rejected" })).toBe("no_change");
    expect(failureKindForExit({ status: "failed", budgetHalt: true, phaseKind: "qa_failed" })).toBe("budget_exhausted");
    expect(failureKindForExit({ status: "failed", phaseKind: "qa_failed" })).toBe("qa_failed");
    expect(failureKindForExit({ status: "failed" })).toBe("error");
  });
  it("a re-review rejection inside verify / QA reports review_rejected", () => {
    expect(failureKindForExit({ status: "failed", phaseKind: "qa_failed", snapshotReview: "changes_requested" })).toBe("review_rejected");
    expect(failureKindForExit({ status: "failed", phaseKind: "verify_failed", snapshotReview: "changes_requested" })).toBe("review_rejected");
    expect(failureKindForExit({ status: "failed", phaseKind: "apply_conflict", snapshotReview: "changes_requested" })).toBe("apply_conflict");
  });
  it("the run ending keeps executePlan's kind; a failing finalize verification is verify_failed", () => {
    expect(failureKindForEnding({ trigger: "terminal_failure", executeKind: "qa_failed" })).toBe("qa_failed");
    expect(failureKindForEnding({ trigger: "verify_failed", executeKind: undefined })).toBe("verify_failed");
    expect(failureKindForEnding({ trigger: "objective_unmet" })).toBe("error");
  });
  it("the vocabulary is the one the UI labels", () => {
    expect([...FAILURE_KINDS]).toEqual([
      "review_rejected", "verify_failed", "qa_failed", "budget_exhausted", "approval_rejected",
      "apply_conflict", "provider_hold", "no_change", "cancelled", "error",
    ]);
    expect(isFailureKind("qa_failed")).toBe(true);
    expect(isFailureKind("failed")).toBe(false);
  });
});

describe("terminal events carry the failure kind; status values are unchanged", () => {
  const setup = () => {
    const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const { api, completions } = createFakeApi({ logEvent: async (input: { type: string; payload?: Record<string, unknown> }) => void events.push(input) });
    const deps = createRunnerDeps({ api, policy: testPolicy({}), workspaceRoot: "/tmp" });
    return { events, completions, deps };
  };
  it("task.error carries the given kind (default error); status stays failed", async () => {
    const { events, completions, deps } = setup();
    await failTaskWithError({ deps, taskId: "t", projectId: "p", message: "QA still failing", failureKind: "qa_failed" });
    await failTaskWithError({ deps, taskId: "t", projectId: "p", message: "boom" });
    expect(events.map((event) => event.payload?.failureKind)).toEqual(["qa_failed", "error"]);
    expect(completions.map((completion) => completion.status)).toEqual(["failed", "failed"]);
  });
  it("a provider failure is a provider_hold", async () => {
    const { events, deps } = setup();
    await failTaskWithError({ deps, taskId: "t", projectId: "p", message: "LLM request failed (429) for model m: Too Many Requests" });
    expect(events[0]).toMatchObject({ type: "llm.provider_hold", payload: { failureKind: "provider_hold" } });
  });
  it("step limit is budget_exhausted; a user stop is cancelled", async () => {
    const { events, deps } = setup();
    await failStepLimit({ deps, taskId: "t", projectId: "p" });
    const abort = new AbortController();
    abort.abort(new Error("Cancelled by user"));
    await finishCancelledTask({ deps, task: testTask({ command: "x" }), project: { _id: "p" } as never, signal: abort.signal });
    expect(events.map((event) => [event.type, event.payload?.failureKind])).toEqual([
      ["orchestrator.step_limit", "budget_exhausted"],
      ["task.cancelled", "cancelled"],
    ]);
  });
});
