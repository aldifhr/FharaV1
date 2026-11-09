import { describe, expect, it } from "vitest";
import { pickOrchestrator } from "@/orchestrator/planner";

const agent = (role: string, name = role) => ({
  _id: name,
  name,
  role,
  isEnabled: true,
});

describe("CTO planning authority", () => {
  it("picks the CTO from the team", () => {
    expect(pickOrchestrator([agent("frontend"), agent("cto")])?.role).toBe("cto");
  });

  it("has no Lead fallback: the retired Lead role is never the orchestrator", () => {
    expect(pickOrchestrator([agent("lead")])).toBeNull();
  });

  it("falls back to an explicit orchestrator role when no CTO exists", () => {
    expect(pickOrchestrator([agent("frontend"), agent("orchestrator")])?.role).toBe("orchestrator");
  });
});
