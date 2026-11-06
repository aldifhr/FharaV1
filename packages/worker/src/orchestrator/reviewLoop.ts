import type { ReviewFinding, ReviewResult } from "../utils/json";
import type { PlanSubtask } from "./types";

export function formatReviewFindings(findings: ReviewFinding[]): string {
  if (findings.length === 0) return "No concrete findings were provided.";
  return findings
    .map(
      (finding) =>
        `- [${finding.severity}] ${finding.filePath}: ${finding.description} (suggestion: ${finding.suggestion})`
    )
    .join("\n");
}

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

export function buildReviewFixSubtask(input: {
  iteration: number;
  findings: ReviewFinding[];
  capability: string;
  order: number;
}): PlanSubtask {
  return {
    key: `review_fix_${input.iteration}`,
    title: `Address review findings (iteration ${input.iteration})`,
    description: [
      "The reviewer requested changes to the prepared work.",
      "Address every finding below and return the full updated file content as JSON.",
      formatReviewFindings(input.findings),
    ].join("\n"),
    kind: "code_change",
    capability: input.capability,
    dependencies: [],
    order: input.order,
  };
}
