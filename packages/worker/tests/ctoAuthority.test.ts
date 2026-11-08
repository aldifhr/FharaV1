import { describe, expect, it } from "vitest";
import { pickOrchestrator } from "@/orchestrator/planner";

const agent = (role: string, name = role) => ({
  _id: name,
  name,
  role,
  isEnabled: true,
});

describe("CTO planning authority", () => {
  it("prefers CTO over Lead", () => {
    expect(pickOrchestrator([agent("lead"), agent("cto")])?.role).toBe("cto");
  });

  it("falls back to Lead when CTO is unavailable", () => {
    expect(pickOrchestrator([agent("lead")])?.role).toBe("lead");
  });
});
