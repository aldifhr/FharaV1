import { describe, expect, it } from "vitest";
import { routeCapability } from "./capabilities";

describe("routeCapability writer fallback (plan 040: opt-in only)", () => {
  const qa = { _id: "qa", name: "QA", role: "qa", capabilities: ["browser-testing"], supportedTools: ["read_file", "run_command"], priority: 9 };
  const backend = { _id: "be", name: "Backend", role: "backend", capabilities: ["backend-api"], supportedTools: ["read_file", "write_file", "run_command"], priority: 3 };
  it("unheld frontend work routes to nobody by default (BLOCKED, no guess)", () => {
    expect(routeCapability("frontend-development", [qa, backend])).toBeNull();
  });
  it("with the opt-in fallback, it goes to an agent that can write, not QA", () => {
    expect(routeCapability("frontend-development", [qa, backend], { allowFallback: true })?._id).toBe("be");
  });
  it("never to a role that may not write, even with the fallback", () => {
    expect(routeCapability("frontend-development", [qa], { allowFallback: true })).toBeNull();
  });
});
