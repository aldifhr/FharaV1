import type { StageOrder } from "@/orchestrator/decisionEngine";
import { failingAs, type Phase } from "./pipeline";
import { implementationOutcomePhase, implementPhase } from "./phases/implement";
import { reviewPhase } from "./phases/review";
import { applyPhase, landPhase, preparePhase, stagePhase } from "./phases/apply";
import { pauseBoundaryPhase, qaPhase, reverifyPhase, verifyPhase } from "./phases/verify";
import { approvalPhase, legacyApprovalPhase } from "./phases/approval";
import { acceptancePhase, coveragePhase, finalBoundaryPhase } from "./phases/accept";

/**
 * The ordered phases of one executePlan invocation, per stage order
 * (decideStageOrder documents when each applies).
 *
 *   verified_first  implement → review → stage (task worktree) → verify →
 *                   QA → re-verify after a QA fix → acceptance → coverage →
 *                   approval (final, review-approved snapshot) → land (merge)
 *   legacy          implement → review → approval → apply → verify → QA →
 *                   acceptance → coverage → land
 *
 * Every verify / QA fix is re-reviewed inside its loop in both orders.
 */
// Item 7: what a failed exit of each phase means (an exit may name its own).
const review = failingAs(reviewPhase, "review_rejected");
const prepare = failingAs(preparePhase, "review_rejected");
const verify = failingAs(verifyPhase, "verify_failed");
const reverify = failingAs(reverifyPhase, "verify_failed");
const qa = failingAs(qaPhase, "qa_failed");
const acceptance = failingAs(acceptancePhase, "verify_failed");
const stage = failingAs(stagePhase, "apply_conflict");
const apply = failingAs(applyPhase, "apply_conflict");
const land = failingAs(landPhase, "apply_conflict");

const VERIFIED_FIRST: ReadonlyArray<Phase> = [
  implementPhase,
  implementationOutcomePhase,
  review,
  prepare,
  stage,
  verify,
  pauseBoundaryPhase,
  qa,
  reverify,
  finalBoundaryPhase,
  acceptance,
  coveragePhase,
  approvalPhase,
  land,
];

const LEGACY: ReadonlyArray<Phase> = [
  implementPhase,
  implementationOutcomePhase,
  review,
  prepare,
  legacyApprovalPhase,
  apply,
  verify,
  pauseBoundaryPhase,
  qa,
  finalBoundaryPhase,
  acceptance,
  coveragePhase,
  land,
];

export function phasesFor(order: StageOrder): ReadonlyArray<Phase> {
  return order === "verified_first" ? VERIFIED_FIRST : LEGACY;
}
