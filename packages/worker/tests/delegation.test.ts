import { describe, expect, it } from "vitest";
import { parseDelegation } from "@/utils/json";

describe("parseDelegation", () => {
  it("parses delegation recommendation", () => {
    const content = JSON.stringify({
      files: [],
      delegationRecommendation: { targetCapability: "browser-testing", reason: "Need QA", priority: "high" },
      findings: ["Issue 1"],
    });
    const result = parseDelegation(content);
    expect(result?.delegationRecommendation?.targetCapability).toBe("browser-testing");
    expect(result?.findings).toEqual(["Issue 1"]);
  });

  it("returns null when no delegation", () => {
    expect(parseDelegation(JSON.stringify({ files: [] }))).toBeNull();
  });
});
