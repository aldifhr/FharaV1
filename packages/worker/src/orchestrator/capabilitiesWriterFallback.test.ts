import { describe, expect, it } from "vitest";
import { routeCapability } from "./capabilities";

describe("routeCapability writer fallback", () => {
  const qa = { _id: "qa", name: "QA", role: "qa", capabilities: ["browser-testing"], supportedTools: ["read_file", "run_command"], priority: 9 };
  const backend = { _id: "be", name: "Backend", role: "backend", capabilities: ["backend-api"], supportedTools: ["read_file", "write_file", "run_command"], priority: 3 };
  it("routes unheld frontend work to an agent that can write, not QA", () => {
    expect(routeCapability("frontend-development", [qa, backend])?._id).toBe("be");
  });
  it("keeps priority fallback when nobody can write", () => {
    expect(routeCapability("frontend-development", [qa])?._id).toBe("qa");
  });
});
