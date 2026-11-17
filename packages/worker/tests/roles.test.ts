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
import { ROLES, ROLE_KEYS } from "@/api/convex/lib/roles";

const dev: AgentDefinition = { _id: "d1", name: "Dev", role: "frontend", capabilities: ["frontend-development", "backend-development"], isEnabled: true } as any;
const qa: AgentDefinition = { _id: "q1", name: "QA", role: "qa", capabilities: ["browser-testing"], isEnabled: true } as any;
const rev: AgentDefinition = { _id: "r1", name: "QA 2", role: "qa", capabilities: ["code-review"], isEnabled: true } as any;
const be: AgentDefinition = { _id: "s1", name: "BE", role: "backend", capabilities: ["backend-development", "research"], isEnabled: true } as any;
const cto: AgentDefinition = { _id: "c1", name: "CTO", role: "cto", capabilities: ["architecture"], isEnabled: true } as any;
const sec: AgentDefinition = { _id: "sec", name: "Sec", role: "security", capabilities: ["security-audit"], isEnabled: true } as any;
const disabled: AgentDefinition = { _id: "x1", name: "Off", role: "frontend", capabilities: ["frontend-development"], isEnabled: false } as any;

describe("roles: normalization + lookup", () => {
  it("orchestrator aliases map to cto; architect (legacy) maps to cto (not a second orchestrator)", () => {
    expect(normalizeRole("orchestrator")).toBe("cto");
    expect(normalizeRole("CTO")).toBe("cto");
    expect(normalizeRole("architect")).toBe("cto");
  });
  it("every current role has capabilities and tools", () => {
    for (const role of ROLE_KEYS) {
      expect(ROLE_DEFINITIONS[role].defaultCapabilities.length).toBeGreaterThan(0);
      expect(ROLE_DEFINITIONS[role].defaultTools.length).toBeGreaterThan(0);
    }
  });
  it("cto/qa cannot write by default; frontend/backend can", () => {
    expect(defaultToolsForRole("cto")).not.toContain("write_file");
    expect(defaultToolsForRole("qa")).not.toContain("write_file");
    expect(defaultToolsForRole("frontend")).toContain("write_file");
    expect(defaultToolsForRole("backend")).toContain("write_file");
  });
  it("roleForAgent reads normalized role; legacy developer → frontend", () => {
    expect(roleForAgent(dev)).toBe("frontend");
    expect(roleForAgent(cto)).toBe("cto");
  });
  it("derives every role from the shared registry (apps/api/convex/lib/roles.ts)", () => {
    expect(Object.keys(ROLE_DEFINITIONS).sort()).toEqual([...ROLE_KEYS].sort());
    for (const key of ROLE_KEYS) {
      expect(ROLE_DEFINITIONS[key].systemPromptHint).toBe(ROLES[key].hint);
      expect(ROLE_DEFINITIONS[key].defaultTools).toEqual([...ROLES[key].defaultTools]);
      expect(ROLE_DEFINITIONS[key].defaultCapabilities).toEqual([...ROLES[key].capabilities]);
    }
  });
  it("keeps the free-text aliases (titles, retired roles)", () => {
    expect(normalizeRole("Frontend Developer")).toBe("frontend");
    expect(normalizeRole("UI/UX")).toBe("designer");
    expect(normalizeRole("UI/UX Designer")).toBe("designer");
    expect(normalizeRole("product analyst")).toBe("cto");
    expect(normalizeRole("Security Engineer")).toBe("backend");
    expect(normalizeRole("technical-writer")).toBe("backend");
    expect(normalizeRole("DevOps Engineer")).toBe("backend");
    expect(normalizeRole("Reviewer")).toBe("qa");
    expect(normalizeRole("")).toBeNull();
  });
  it("plan 040: an unknown role is unrouted (null), never frontend", () => {
    expect(normalizeRole("something-weird")).toBeNull();
  });
  it("plan 040: a custom role resolves by its declared capabilities, else null", () => {
    const custom = { _id: "x", name: "X", role: "custom-x", capabilities: ["frontend-development"], isEnabled: true } as any;
    expect(roleForAgent(custom)).toBe("frontend");
    const bare = { _id: "y", name: "Y", role: "custom-y", capabilities: ["juggling"], isEnabled: true } as any;
    expect(roleForAgent(bare)).toBeNull();
  });
});

describe("roles: capability-based selection", () => {
  it("simple UI task → Developer only (1 agent)", () => {
    const picked = selectAgentsForTask({ agents: [dev, qa, rev], requiredCapabilities: ["frontend-development"], taskComplexity: "simple" });
    expect(picked.map((a) => a._id)).toEqual(["d1"]);
  });
  it("implement authentication → Developer + QA (2 agents, complex)", () => {
    const picked = selectAgentsForTask({
      agents: [dev, qa, rev, be],
      requiredCapabilities: ["backend-development", "browser-testing"],
      taskComplexity: "complex",
    });
    expect(picked.length).toBe(2);
    expect(picked.map((a) => a._id)).toContain("d1");
    expect(picked.map((a) => a._id)).toContain("q1");
  });
  it("audit code quality → QA only", () => {
    const picked = selectAgentsForTask({ agents: [dev, rev], requiredCapabilities: ["code-review"] });
    expect(picked.map((a) => a._id)).toEqual(["r1"]);
  });
  it("research framework → Backend (retired Researcher capability)", () => {
    const picked = selectAgentsForTask({ agents: [dev, be], requiredCapabilities: ["research"] });
    expect(picked.map((a) => a._id)).toEqual(["s1"]);
  });
  it("security audit → backend (mapped, not a separate role)", () => {
    const picked = selectAgentsForTask({ agents: [dev, sec, be], requiredCapabilities: ["security-audit"] });
    // sec agent role normalizes to backend; capability matching still finds it
    expect(picked.map((a) => a._id)).toContain("sec");
  });
  it("disabled agents cannot be selected", () => {
    const picked = selectAgentsForTask({ agents: [disabled], requiredCapabilities: ["frontend-development"] });
    expect(picked).toEqual([]);
  });
  it("canSelect enforces capability ownership", () => {
    expect(canSelect("frontend", ["frontend-development"])).toBe(true);
    expect(canSelect("qa", ["frontend-development"])).toBe(false);
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
