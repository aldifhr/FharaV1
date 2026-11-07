import { describe, expect, it } from "vitest";
import {
  ROLE_DEFINITIONS,
  canSelect,
  defaultToolsForRole,
  normalizeRole,
  roleForAgent,
  selectAgentsForTask,
} from "@/orchestrator/roles";
import type { AgentDefinition } from "@/orchestrator/types";

const dev: AgentDefinition = { _id: "d1", name: "Dev", role: "developer", capabilities: ["frontend-development", "backend-development"], isEnabled: true } as any;
const qa: AgentDefinition = { _id: "q1", name: "QA", role: "qa", capabilities: ["browser-testing"], isEnabled: true } as any;
const rev: AgentDefinition = { _id: "r1", name: "Rev", role: "reviewer", capabilities: ["code-review"], isEnabled: true } as any;
const res: AgentDefinition = { _id: "s1", name: "Res", role: "researcher", capabilities: ["research"], isEnabled: true } as any;
const cto: AgentDefinition = { _id: "c1", name: "CTO", role: "cto", capabilities: ["architecture"], isEnabled: true } as any;
const sec: AgentDefinition = { _id: "sec", name: "Sec", role: "security", capabilities: ["security-audit"], isEnabled: true } as any;
const disabled: AgentDefinition = { _id: "x1", name: "Off", role: "developer", capabilities: ["frontend-development"], isEnabled: false } as any;

describe("roles: normalization + lookup", () => {
  it("orchestrator aliases map to cto; architect stays architect (not second orchestrator)", () => {
    expect(normalizeRole("orchestrator")).toBe("cto");
    expect(normalizeRole("CTO")).toBe("cto");
    expect(normalizeRole("architect")).toBe("architect");
  });
  it("every core + specialist role has capabilities and tools", () => {
    for (const role of ["cto", "developer", "qa", "reviewer", "researcher", "technical-writer", "architect", "devops", "security", "database", "ui-ux", "product-analyst"] as const) {
      expect(ROLE_DEFINITIONS[role].defaultCapabilities.length).toBeGreaterThan(0);
      expect(ROLE_DEFINITIONS[role].defaultTools.length).toBeGreaterThan(0);
    }
  });
  it("researcher/technical-writer/architect cannot write by default", () => {
    expect(defaultToolsForRole("researcher")).not.toContain("write_file");
    expect(defaultToolsForRole("technical-writer")).not.toContain("write_file");
    expect(defaultToolsForRole("reviewer")).not.toContain("write_file");
    expect(defaultToolsForRole("developer")).toContain("write_file");
  });
  it("roleForAgent reads normalized role", () => {
    expect(roleForAgent(dev)).toBe("developer");
    expect(roleForAgent(cto)).toBe("cto");
  });
  it("unknown role falls back to general without throwing", () => {
    expect(normalizeRole("something-weird")).toBe("general");
  });
});

describe("roles: capability-based selection", () => {
  it("simple UI task → Developer only (1 agent)", () => {
    const picked = selectAgentsForTask({ agents: [dev, qa, rev], requiredCapabilities: ["frontend-development"], taskComplexity: "simple" });
    expect(picked.map((a) => a._id)).toEqual(["d1"]);
  });
  it("implement authentication → Developer + QA (2 agents, complex)", () => {
    const picked = selectAgentsForTask({
      agents: [dev, qa, rev, res],
      requiredCapabilities: ["backend-development", "browser-testing"],
      taskComplexity: "complex",
    });
    expect(picked.length).toBe(2);
    expect(picked.map((a) => a._id)).toContain("d1");
    expect(picked.map((a) => a._id)).toContain("q1");
  });
  it("audit code quality → Reviewer only", () => {
    const picked = selectAgentsForTask({ agents: [dev, rev], requiredCapabilities: ["code-review"] });
    expect(picked.map((a) => a._id)).toEqual(["r1"]);
  });
  it("research framework → Researcher only", () => {
    const picked = selectAgentsForTask({ agents: [dev, res], requiredCapabilities: ["research"] });
    expect(picked.map((a) => a._id)).toEqual(["s1"]);
  });
  it("security review → Security (not blindly all)", () => {
    const picked = selectAgentsForTask({ agents: [dev, sec, res], requiredCapabilities: ["security-audit"] });
    expect(picked.map((a) => a._id)).toEqual(["sec"]);
  });
  it("disabled agents cannot be selected", () => {
    const picked = selectAgentsForTask({ agents: [disabled], requiredCapabilities: ["frontend-development"] });
    expect(picked).toEqual([]);
  });
  it("canSelect enforces capability ownership", () => {
    expect(canSelect("developer", ["frontend-development"])).toBe(true);
    expect(canSelect("researcher", ["frontend-development"])).toBe(false);
  });
  it("complex security+review picks both (security, reviewer)", () => {
    const picked = selectAgentsForTask({
      agents: [dev, sec, rev],
      requiredCapabilities: ["security-audit", "code-review"],
      taskComplexity: "complex",
    });
    expect(picked.map((a) => a._id).sort()).toEqual(["r1", "sec"]);
  });
  it("empty agent pool → empty, no throw", () => {
    expect(selectAgentsForTask({ agents: [], requiredCapabilities: ["frontend-development"] })).toEqual([]);
  });
});
