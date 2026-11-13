import { decideReplan } from "@/orchestrator/decisionEngine";
import { blockRejected, runAcceptanceStage } from "../../acceptance";
import { recordCoverage, runCoverageCheck } from "../../coverage";
import { exit, next, type Phase } from "../pipeline";

/**
 * Final boundary before the acceptance gates (plan 013 step 3): a replan
 * requested anywhere earlier in this invocation still wins.
 */
export const finalBoundaryPhase: Phase = async () => next("check");

/**
 * Plan 022 acceptance stage: executor "done" was only "delivered"; the
 * contract's gates decide acceptance. A failed required gate is a fix
 * iteration (bounded replan) or, with none left, blocks the task. Replan
 * or block is the Decision Engine's call (decideReplan).
 */
export const acceptancePhase: Phase = async ({ ctx }) => {
  const facts = { replansLeft: ctx.input.replansLeft ?? 0 };
  const acceptance = await runAcceptanceStage(ctx);
  if (acceptance.rejected.length === 0) return next();
  const reason = `Acceptance gates failed: ${acceptance.rejected
    .map((entry) => `${entry.key}: ${entry.reason}`)
    .join("; ")}`.slice(0, 1500);
  const decision = decideReplan({ kind: "replan_trigger", trigger: "acceptance_rejected", reason, facts });
  if (decision.kind === "replan") return exit({ status: "replan", replanFeedback: decision.reason });
  await blockRejected(ctx, acceptance.rejected);
  ctx.state.feedback.push(reason);
  return exit({ status: "failed" });
};

/**
 * Plan 025 coverage check: every requirement from the request needs a
 * subtask and passing evidence before the task may be "done". A gap is a
 * bounded replan with the uncovered list; with no replan left the task
 * ends "completed with gaps" (status failed + coverage outcome).
 */
export const coveragePhase: Phase = async ({ ctx }) => {
  const facts = { replansLeft: ctx.input.replansLeft ?? 0 };
  const coverage = await runCoverageCheck(ctx);
  if (coverage.status === "gaps") {
    const decision = decideReplan({ kind: "replan_trigger", trigger: "coverage_gaps", reason: coverage.note, facts });
    await recordCoverage(ctx, coverage.report, decision.kind === "replan" ? "gaps" : "completed_with_gaps");
    if (decision.kind === "replan") return exit({ status: "replan", replanFeedback: decision.reason });
    if (decision.kind === "block") ctx.state.feedback.push(decision.message);
    return exit({ status: "failed" });
  }
  if (coverage.status === "covered") await recordCoverage(ctx, coverage.report, "covered");
  return next();
};
