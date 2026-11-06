import { describe, expect, it } from "vitest";
import {
  capabilitiesOf,
  capabilityForRole,
  routeCapability,
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
  });

  it("uses declared capabilities over role inference", () => {
    expect(capabilitiesOf({ _id: "x", name: "X", role: "frontend", capabilities: ["backend-development"] })).toEqual([
      "backend-development",
    ]);
  });

  it("falls back to the highest priority agent when nothing matches", () => {
    expect(routeCapability("database-tuning", agents)?._id).toBe("a3");
  });

  it("returns null when fallback is disabled", () => {
    expect(routeCapability("database-tuning", agents, { allowFallback: false })).toBeNull();
  });

  it("returns null with no enabled agents", () => {
    expect(
      routeCapability("frontend-development", [
        { _id: "x", name: "X", role: "frontend", isEnabled: false },
      ])
    ).toBeNull();
  });
});
