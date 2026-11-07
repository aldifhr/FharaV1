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

const dev: AgentDefinition = { _id: "d1", name: "Dev", role: "frontend", capabilities: ["frontend-development", "backend-development"], isEnabled: true } as any;
const qa: AgentDefinition = { _id: "q1", name: "QA", role: "qa", capabilities: ["browser-testing"], isEnabled: true } as any;
const rev: AgentDefinition = { _id: "r1", name: "Rev", role: "reviewer", capabilities: ["code-review"], isEnabled: true } as any;
const res: AgentDefinition = { _id: "s1", name: "Res", role: "researcher", capabilities: ["research"], isEnabled: true } as any;
const cto: AgentDefinition = { _id: "c1", name: "CTO", role: "cto", capabilities: ["architecture"], isEnabled: true } as any;
const sec: AgentDefinition = { _id: "sec", name: "Sec", role: "security", capabilities: ["security-audit"], isEnabled: true } as any;
const disabled: AgentDefinition = { _id: "x1", name: "Off", role: "frontend", capabilities: ["frontend-development"], isEnabled: false } as any;

describe("roles: normalization + lookup", () => {
  it("orchestrator aliases map to cto; architect (legacy) maps to cto (not a second orchestrator)", () => {
    expect(normalizeRole("orchestrator")).toBe("cto");
    expect(normalizeRole("CTO")).toBe("cto");
    expect(normalizeRole("architect")).toBe("cto");
  });
  it("every org role (spec §2) has capabilities and tools", () => {
    for (const role of ["cto", "frontend", "backend", "devops", "qa", "reviewer", "researcher", "product-analyst", "ui-ux"] as const) {
      expect(ROLE_DEFINITIONS[role].defaultCapabilities.length).toBeGreaterThan(0);
      expect(ROLE_DEFINITIONS[role].defaultTools.length).toBeGreaterThan(0);
    }
  });
  it("researcher/reviewer cannot write by default; frontend/backend can", () => {
    expect(defaultToolsForRole("researcher")).not.toContain("write_file");
    expect(defaultToolsForRole("reviewer")).not.toContain("write_file");
    expect(defaultToolsForRole("frontend")).toContain("write_file");
    expect(defaultToolsForRole("backend")).toContain("write_file");
  });
  it("roleForAgent reads normalized role; legacy developer → frontend", () => {
    expect(roleForAgent(dev)).toBe("frontend");
    expect(roleForAgent(cto)).toBe("cto");
  });
  it("unknown role falls back to frontend without throwing", () => {
    expect(normalizeRole("something-weird")).toBe("frontend");
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
  it("security audit → backend (mapped, not a separate role)", () => {
    const picked = selectAgentsForTask({ agents: [dev, sec, res], requiredCapabilities: ["security-audit"] });
    // sec agent role normalizes to backend; capability matching still finds it
    expect(picked.map((a) => a._id)).toContain("sec");
  });
  it("disabled agents cannot be selected", () => {
    const picked = selectAgentsForTask({ agents: [disabled], requiredCapabilities: ["frontend-development"] });
    expect(picked).toEqual([]);
  });
  it("canSelect enforces capability ownership", () => {
    expect(canSelect("frontend", ["frontend-development"])).toBe(true);
    expect(canSelect("researcher", ["frontend-development"])).toBe(false);
  });
  it("complex backend+review picks both", () => {
    const be: AgentDefinition = { _id: "be", name: "BE", role: "backend", capabilities: ["backend-development"], isEnabled: true } as any;
    const picked = selectAgentsForTask({
      agents: [dev, be, rev],
      requiredCapabilities: ["backend-development", "code-review"],
      taskComplexity: "complex",
    });
    expect(picked.map((a) => a._id)).toContain("r1");
    expect(picked.length).toBe(2);
  });
  it("empty agent pool → empty, no throw", () => {
    expect(selectAgentsForTask({ agents: [], requiredCapabilities: ["frontend-development"] })).toEqual([]);
  });
});
