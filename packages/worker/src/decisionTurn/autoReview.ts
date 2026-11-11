/**
 * D7: auto review in Full access, worker side. An agent command that the
 * backend sends to review (commandApprovals.request → status "review") is
 * judged by the project's Reviewer in one G13 decision turn: the Reviewer's
 * agent, its model tier (llmResolver.handlesFor(agent, "decision")), the
 * budget gate, the deadline and the usage metering all come from
 * runDecisionTurn. The raw reply goes to commandApprovals.review, which
 * parses it strictly (lib/autoReview.ts), writes the audit row and either
 * approves the command or hands the card to the user. A turn that cannot
 * run (no Reviewer in this run, no model, budget, deadline) is reported as
 * such and the card goes to the user: nothing is allowed by default.
 */
import { autoReviewPrompt, type AutoReviewRequest } from "@/api/convex/lib/autoReview";
import type { CommandReviewFn } from "@/services/runner/commandApproval";
import type { RunContext } from "@/services/runner/types";
import { runDecisionTurn, type DecisionTurnSpec } from "./runDecisionTurn";

/** The Reviewer's turn. `parse` passes the raw text through: the backend is the one strict parser. */
export const AUTO_REVIEW_SPEC: DecisionTurnSpec<AutoReviewRequest> = {
  role: "reviewer",
  buildPrompt: autoReviewPrompt,
  parse: (text) => ({ verdict: "answer", answer: text, rationale: "Reviewer output (parsed by the backend)" }),
};

/** The review callback for waitForCommandApproval, or undefined when this worker has no decision-turn backend. */
export function commandReviewerFor(ctx: RunContext): CommandReviewFn | undefined {
  const port = ctx.deps.decisionTurns;
  const report = port?.reviewCommand;
  if (!port || !report) return undefined;
  return async (review, signal) => {
    const outcome = await runDecisionTurn(AUTO_REVIEW_SPEC, review.request, {
      agents: ctx.agents,
      llmResolver: ctx.input.llmResolver,
      llmConfig: ctx.input.llmConfig,
      assertBudgetForCall: ctx.input.assertBudgetForCall ?? (ctx.input.budget ? () => ctx.input.budget!.assertLlmCallAllowed() : undefined),
      onTokenUsage: ctx.input.onTokenUsage,
      llmTaskGate: ctx.input.llmTaskGate,
      signal: signal ?? ctx.input.taskAbort?.signal,
      deadline: review.expiresAt,
      ...(ctx.deps.decisionTurnAsk ? { ask: ctx.deps.decisionTurnAsk } : {}),
    });
    const result = await report.call(port, {
      turnId: review.turnId,
      workerId: ctx.deps.workerId,
      ...(outcome.verdict === "answer"
        ? { output: outcome.answer }
        : outcome.verdict === "escalate"
          ? { output: "" }
          : { failure: { kind: outcome.verdict, reason: outcome.reason.slice(0, 300) } }),
    });
    return { allowed: result.allowed, reason: result.reason };
  };
}
