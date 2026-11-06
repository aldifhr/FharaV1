import { describe, expect, it } from "vitest";
import {
  buildReviewFixSubtask,
  collectRequestedChanges,
  formatReviewFindings,
} from "../src/orchestrator/reviewLoop";
import type { ReviewResult } from "../src/utils/json";

const finding = {
  severity: "high" as const,
  filePath: "src/app.ts",
  description: "Missing error handling",
  suggestion: "Wrap the call in try/catch",
};

describe("review loop helpers", () => {
  it("collects findings only from reviewers that requested changes", () => {
    const verdicts: Record<string, ReviewResult> = {
      review_a: { verdict: "changes_requested", findings: [finding] },
      review_b: { verdict: "approved", findings: [] },
    };
    expect(collectRequestedChanges(verdicts, ["review_a", "review_b"])).toEqual([finding]);
    expect(collectRequestedChanges(verdicts, ["review_b"])).toEqual([]);
  });

  it("builds a fix subtask carrying the findings", () => {
    const subtask = buildReviewFixSubtask({
      iteration: 2,
      findings: [finding],
      capability: "frontend-development",
      order: 9,
    });
    expect(subtask).toMatchObject({
      key: "review_fix_2",
      kind: "code_change",
      capability: "frontend-development",
      dependencies: [],
      order: 9,
    });
    expect(subtask.description).toContain("Missing error handling");
    expect(subtask.description).toContain("Wrap the call in try/catch");
  });

  it("formats an empty finding list explicitly", () => {
    expect(formatReviewFindings([])).toBe("No concrete findings were provided.");
  });
});
