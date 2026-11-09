import { describe, expect, it } from "vitest";
import { isPermanentSubtaskError } from "./dagScheduler";

describe("QA failure is not blindly retried", () => {
  it("treats a failed QA verdict as permanent", () => {
    expect(isPermanentSubtaskError("QA failed: structural check: Framework error overlay is visible")).toBe(true);
  });
  it("keeps inconclusive QA retryable", () => {
    expect(isPermanentSubtaskError("QA inconclusive: timeout")).toBe(false);
  });
});
