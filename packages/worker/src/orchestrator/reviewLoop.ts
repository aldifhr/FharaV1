import type { ReviewFinding, ReviewResult } from "@/utils/json";
import type { PlanSubtask } from "@/types";
import { fixSubtaskDescription, REVIEW_FIX_INTRO } from "@/prompts/fix";

// Prompt text lives in `@/prompts/fix`; re-exported for existing importers.
export { formatReviewFindings } from "@/prompts/fix";


export function collectRequestedChanges(
  verdicts: Record<string, ReviewResult>,
  keys: string[]
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const key of keys) {
    const review = verdicts[key];
    if (review?.verdict === "changes_requested") findings.push(...review.findings);
  }
  return findings;
}

/**
 * Generalized fix-subtask builder (Phase 3): any orchestrator REVISE
 * decision that carries structured findings — a review verdict, a QA
 * failure, an audit's critical findings — becomes the same shape of
 * code_change subtask: address every finding and return full updated
 * file contents. `buildReviewFixSubtask` below is the review loop's
 * specialization of this builder; the taskRunner's dynamic REVISE path
 * uses this one directly.
 */
export function buildFixSubtask(input: {
  key: string;
  title: string;
  intro: string;
  findings: ReviewFinding[];
  capability: string;
  order: number;
  dependencies?: string[];
}): PlanSubtask {
  return {
    key: input.key,
    title: input.title,
    description: fixSubtaskDescription(input.intro, input.findings),
    kind: "code_change",
    capability: input.capability,
    dependencies: input.dependencies ?? [],
    order: input.order,
  };
}

export function buildReviewFixSubtask(input: {
  iteration: number;
  findings: ReviewFinding[];
  capability: string;
  order: number;
}): PlanSubtask {
  return buildFixSubtask({
    key: `review_fix_${input.iteration}`,
    title: `Address review findings (iteration ${input.iteration})`,
    intro: REVIEW_FIX_INTRO,
    findings: input.findings,
    capability: input.capability,
    order: input.order,
  });
}
