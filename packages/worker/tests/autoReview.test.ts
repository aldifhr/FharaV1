import { describe, expect, it, vi } from "vitest";
import { waitForCommandApproval, type CommandApprovalApi } from "@/services/runner/commandApproval";
import { AUTO_REVIEW_SPEC, commandReviewerFor } from "@/decisionTurn/autoReview";
import { REVIEW_POLICY, type AutoReviewRequest } from "@/api/convex/lib/autoReview";
import type { RunContext } from "@/services/runner/types";

/** D7: the worker side of auto review in Full access (the Reviewer's decision turn and the wait). */

const request = { taskId: "t1", projectId: "p1", subtaskKey: "s1", command: "rm", args: ["-rf", "node_modules"] };
const reviewRequest: AutoReviewRequest = {
  environment: { workspaceRoot: "/ws/p", permissionMode: "full_access" },
  instructions: ["Reinstall the dependencies"],
  facts: ["Ran earlier in this task: npm ci"],
  pending: { command: "rm", args: ["-rf", "node_modules"], line: "rm -rf node_modules", danger: "Deletes files recursively or by force" },
};
const reviewStart = {
  status: "review",
  approvalId: "a1",
  reason: "The Reviewer checks this command first",
  offerAlways: false,
  review: { turnId: "turn1", expiresAt: Date.now() + 60_000, request: reviewRequest },
};
const pending = { status: "pending", decision: null, note: null, taskStatus: "running" };
const noSleep = async () => undefined;

function mockApi(rows: Array<Record<string, unknown> | null>, start: Record<string, unknown> = reviewStart) {
  let i = 0;
  const api = {
    requestCommandApproval: vi.fn(async () => start),
    getCommandApproval: vi.fn(async () => rows[Math.min(i++, rows.length - 1)]),
    cancelCommandApproval: vi.fn(async () => ({ applied: true })),
  };
  return api as unknown as CommandApprovalApi & typeof api;
}

describe("waitForCommandApproval with a review (D7)", () => {
  it("a Reviewer allow runs the command at once, with no card wait", async () => {
    const api = mockApi([]);
    const review = vi.fn(async () => ({ allowed: true, reason: "Reviewer: low risk, allowed" }));
    const onPending = vi.fn();
    const out = await waitForCommandApproval(api, request, { sleep: noSleep, review, onPending });
    expect(out).toMatchObject({ allowed: true, via: "auto", reason: "Reviewer: low risk, allowed" });
    expect(review).toHaveBeenCalledWith(reviewStart.review, undefined);
    expect(api.getCommandApproval).not.toHaveBeenCalled();
    expect(onPending).not.toHaveBeenCalled();
  });

  it("a deny (or unparsable output) leaves the card: the user decides", async () => {
    const api = mockApi([pending, { ...pending, status: "approved", decision: "allow" }]);
    const onPending = vi.fn();
    const out = await waitForCommandApproval(api, request, {
      sleep: noSleep,
      onPending,
      review: async () => ({ allowed: false, reason: "Reviewer: medium risk, denied" }),
    });
    expect(out).toMatchObject({ allowed: true, via: "allow" });
    expect(onPending).toHaveBeenCalledWith("a1");
  });

  it("a review that throws, or no review callback, falls back to the card", async () => {
    const thrown = mockApi([{ ...pending, status: "rejected", decision: "deny" }]);
    const out = await waitForCommandApproval(thrown, request, {
      sleep: noSleep,
      review: async () => {
        throw new Error("backend down");
      },
    });
    expect(out).toMatchObject({ allowed: false, via: "deny" });
    const none = mockApi([{ ...pending, status: "rejected", decision: "deny" }]);
    expect(await waitForCommandApproval(none, request, { sleep: noSleep })).toMatchObject({ allowed: false, via: "deny" });
  });
});

const reviewer = { _id: "ag-rev", name: "Reviewer", role: "reviewer", isEnabled: true };
const backend = { _id: "ag-be", name: "Backend", role: "backend", isEnabled: true };

function runContext(opts: { agents?: unknown[]; ask?: (prompt: string) => Promise<string>; withPort?: boolean }) {
  const reviewCommand = vi.fn(async (input: { output?: string; failure?: unknown }) => ({
    allowed: input.output === '{"risk":"low","decision":"allow"}',
    approvalId: "a1",
    reason: input.output ? "Reviewer: low risk, allowed" : "The Reviewer could not decide",
  }));
  const ctx = {
    agents: opts.agents ?? [reviewer, backend],
    input: { task: { _id: "t1" } },
    deps: {
      workerId: "w1",
      decisionTurns: opts.withPort === false ? undefined : { reviewCommand },
      ...(opts.ask ? { decisionTurnAsk: opts.ask } : {}),
    },
  } as unknown as RunContext;
  return { ctx, reviewCommand };
}

describe("commandReviewerFor (the Reviewer's decision turn)", () => {
  it("asks the Reviewer role with the rubric and reports its raw output for the backend to parse", async () => {
    const prompts: string[] = [];
    const { ctx, reviewCommand } = runContext({
      ask: async (prompt) => {
        prompts.push(prompt);
        return '{"risk":"low","decision":"allow"}';
      },
    });
    const review = commandReviewerFor(ctx)!;
    const out = await review(reviewStart.review);
    expect(out).toEqual({ allowed: true, reason: "Reviewer: low risk, allowed" });
    expect(prompts[0].startsWith(REVIEW_POLICY)).toBe(true);
    expect(prompts[0]).toContain('"line":"rm -rf node_modules"');
    expect(prompts[0]).toContain("Ran earlier in this task: npm ci");
    expect(reviewCommand).toHaveBeenCalledWith({ turnId: "turn1", workerId: "w1", output: '{"risk":"low","decision":"allow"}' });
  });

  it("unparsable text is passed through untouched (the backend turns it into a card)", async () => {
    const { ctx, reviewCommand } = runContext({ ask: async () => "Looks fine." });
    expect((await commandReviewerFor(ctx)!(reviewStart.review)).allowed).toBe(false);
    expect(reviewCommand).toHaveBeenCalledWith(expect.objectContaining({ output: "Looks fine." }));
    expect(AUTO_REVIEW_SPEC.parse("anything", reviewRequest)).toMatchObject({ verdict: "answer", answer: "anything" });
  });

  it("no Reviewer in this run's team, or a deadline already past → reported as a failure, never an allow", async () => {
    const { ctx, reviewCommand } = runContext({ agents: [backend], ask: async () => '{"risk":"low","decision":"allow"}' });
    expect((await commandReviewerFor(ctx)!(reviewStart.review)).allowed).toBe(false);
    expect(reviewCommand).toHaveBeenCalledWith(expect.objectContaining({ failure: expect.objectContaining({ kind: "unavailable" }) }));
    const late = runContext({ ask: async () => '{"risk":"low","decision":"allow"}' });
    await commandReviewerFor(late.ctx)!({ ...reviewStart.review, expiresAt: Date.now() - 1 });
    expect(late.reviewCommand).toHaveBeenCalledWith(expect.objectContaining({ failure: expect.objectContaining({ kind: "expired" }) }));
  });

  it("a worker without the decision-turn backend has no reviewer callback", () => {
    expect(commandReviewerFor(runContext({ withPort: false }).ctx)).toBeUndefined();
  });
});
