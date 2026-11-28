import { describe, expect, it } from "vitest";
import {
  capabilitiesOf,
  capabilityForRole,
  routeCapability,
  unroutedReason,
} from "@/orchestrator/capabilities";
import type { AgentDefinition } from "@/orchestrator/types";

const agents: AgentDefinition[] = [
  {
    _id: "a1",
    name: "Frontend Dev",
    role: "frontend",
    capabilities: ["frontend-development"],
    priority: 1,
  },
  {
    _id: "a2",
    name: "Backend Dev",
    role: "backend",
    capabilities: ["backend-development"],
    priority: 1,
  },
  {
    _id: "a3",
    name: "Reviewer",
    role: "cto",
    capabilities: ["code-review", "architecture"],
    priority: 5,
  },
  {
    _id: "a4",
    name: "Generalist",
    role: "assistant",
    capabilities: ["general"],
    priority: 0,
  },
  {
    _id: "a5",
    name: "Disabled",
    role: "frontend",
    capabilities: ["frontend-development"],
    isEnabled: false,
    priority: 100,
  },
];

describe("capability routing", () => {
  it("routes by exact capability and ignores disabled agents", () => {
    expect(routeCapability("frontend-development", agents)?._id).toBe("a1");
    expect(routeCapability("code-review", agents)?._id).toBe("a3");
  });

  it("infers capabilities from roles", () => {
    expect(capabilityForRole("QA Engineer")).toContain("browser-testing");
    expect(capabilityForRole("Security Auditor")).toContain("security-audit");
    expect(capabilityForRole("Support")).toContain("documentation-support");
  });

  it("uses declared capabilities over role inference", () => {
    expect(capabilitiesOf({ _id: "x", name: "X", role: "frontend", capabilities: ["backend-development"] })).toEqual([
      "backend-development",
    ]);
  });

  it("plan 040: no fallback by default; the opt-in fallback skips the CTO", () => {
    expect(routeCapability("database-tuning", agents)).toBeNull();
    // a3 is the CTO (highest priority): the opt-in fallback never picks it.
    expect(routeCapability("database-tuning", agents, { allowFallback: true })?._id).not.toBe("a3");
  });

  it("returns null when fallback is disabled", () => {
    expect(routeCapability("database-tuning", agents, { allowFallback: false })).toBeNull();
  });

  it("does not route browser QA to an unrelated backend agent", () => {
    expect(routeCapability("browser-testing", agents, { allowFallback: false })).toBeNull();
  });

  it("returns null with no enabled agents", () => {
    expect(
      routeCapability("frontend-development", [
        { _id: "x", name: "X", role: "frontend", isEnabled: false },
      ])
    ).toBeNull();
  });
});

describe("capability routing enforces the role's actual tools", () => {
  const cto = { _id: "c", name: "CTO", role: "cto", capabilities: ["shell-execution"], priority: 9 };
  const qa = { _id: "q", name: "QA", role: "qa", capabilities: ["shell-execution", "test-run"], supportedTools: ["run_command"], priority: 7 };
  const backend = { _id: "b", name: "Backend", role: "backend", capabilities: ["shell-execution"], supportedTools: ["run_command"], priority: 3 };

  it("a read-only agent that declares shell-execution is not an owner", () => {
    expect(routeCapability("shell-execution", [cto])).toBeNull();
  });

  it("a verify-only role may own test-run but not shell-execution", () => {
    expect(routeCapability("shell-execution", [qa])).toBeNull();
    expect(routeCapability("test-run", [qa])?._id).toBe("q");
  });

  it("an allowlisted shell role owns shell-execution", () => {
    expect(routeCapability("shell-execution", [cto, qa, backend])?._id).toBe("b");
  });

  it("the reason names the permission that is missing", () => {
    expect(unroutedReason("shell-execution", [cto])).toMatch(/may not run commands/);
  });
});
