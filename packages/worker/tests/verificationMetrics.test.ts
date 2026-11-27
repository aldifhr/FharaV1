import { describe, expect, it } from "vitest";
import { metricForCheck, verificationMetrics } from "@/services/runner/verificationMetrics";

describe("approval verification metrics", () => {
  it("reports each check by its own name", () => {
    expect(
      verificationMetrics([
        { name: "typecheck", status: "passed" },
        { name: "lint", status: "passed" },
        { name: "build", status: "passed" },
      ])
    ).toEqual({ build: "passed", tests: "not run" });
  });

  it("does not claim a test ran when only a blanket status exists", () => {
    expect(verificationMetrics(undefined)).toEqual({ build: "not run", tests: "not run" });
    expect(metricForCheck([{ name: "test", status: "failed" }], "test")).toBe("failed");
  });
});
