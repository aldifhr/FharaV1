import type { ReviewFinding } from "@/utils/json";

/** Intro of the review loop's fix subtask. */
export const REVIEW_FIX_INTRO = "The reviewer requested changes to the prepared work.";
/** Intro of the QA loop's fix subtask. */
export const QA_FIX_INTRO = "QA reported failures on the prepared work.";
/** Intro of the verification loop's fix subtask. */
export const VERIFY_FIX_INTRO = "Static verification reported failures.";

export function formatReviewFindings(findings: ReviewFinding[]): string {
  if (findings.length === 0) return "No concrete findings were provided.";
  return findings
    .map(
      (finding) =>
        `- [${finding.severity}] ${finding.filePath}: ${finding.description} (suggestion: ${finding.suggestion})`
    )
    .join("\n");
}

/** Description of a generalized fix subtask (buildFixSubtask). */
export function fixSubtaskDescription(intro: string, findings: ReviewFinding[]): string {
  return [
    intro,
    "Address every finding below and return the full updated file content as JSON.",
    formatReviewFindings(findings),
  ].join("\n");
}

/** Description of the decision engine's "Address findings" fix node. */
export function engineFixDescription(
  findings: Array<Pick<ReviewFinding, "severity" | "description"> & { filePath?: string; suggestion?: string }>
): string {
  return [
    "Address the reported findings and return the updated file content.",
    ...findings.map(
      (finding) =>
        `- [${finding.severity}] ${finding.filePath ? `${finding.filePath}: ` : ""}${finding.description}${finding.suggestion ? ` — ${finding.suggestion}` : ""}`
    ),
  ].join("\n");
}
