import { describe, expect, it } from "vitest";
import { parseCtoDecision, validateCtoDecision } from "@/orchestrator/ctoDecision";
import type { AgentDefinition } from "@/orchestrator/types";

const agents: AgentDefinition[] = [
  { _id: "cto", name: "Carmen", role: "cto", capabilities: ["architecture", "research"], priority: 1 },
  { _id: "fe", name: "Eir", role: "frontend", capabilities: ["frontend-development"], priority: 1 },
  { _id: "be", name: "Johanne", role: "backend", capabilities: ["backend-development"], priority: 1 },
  { _id: "off", name: "Off", role: "frontend", capabilities: ["frontend-development"], priority: 1, isEnabled: false },
];

describe("CTO decision contract", () => {
  it("parses a strict decision object and a JSON string", () => {
    const decision = { role: "frontend", capability: "frontend-development", reason: "UI work" };
    expect(parseCtoDecision(decision)).toEqual(decision);
    expect(parseCtoDecision(JSON.stringify(decision))).toEqual(decision);
  });

  it("refuses malformed decisions", () => {
    expect(parseCtoDecision(null)).toBeNull();
    expect(parseCtoDecision("{not json")).toBeNull();
    expect(parseCtoDecision({ role: "", capability: "x", reason: "y" })).toBeNull();
    expect(parseCtoDecision({ role: "frontend", capability: "x", reason: "y", answerSelf: "yes" })).toBeNull();
  });

  it("uses the registry choice, not a deterministic fallback", () => {
    const decision = parseCtoDecision({ role: "frontend", capability: "frontend-development", reason: "UI" })!;
    const result = validateCtoDecision(decision, agents);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.agent._id).toBe("fe");
  });

  it("refuses an unknown role, an unavailable agent and a missing capability with a reason", () => {
    const unknown = validateCtoDecision(parseCtoDecision({ role: "wizard", capability: "magic", reason: "x" })!, agents);
    expect(unknown).toMatchObject({ ok: false, code: "unknown_role" });
    if (!unknown.ok) expect(unknown.reason).toContain("wizard");

    const unavailable = validateCtoDecision(parseCtoDecision({ role: "qa", capability: "browser-testing", reason: "x" })!, agents);
    expect(unavailable).toMatchObject({ ok: false, code: "unavailable_role" });

    const noCapability = validateCtoDecision(parseCtoDecision({ role: "frontend", capability: "backend-development", reason: "x" })!, agents);
    expect(noCapability).toMatchObject({ ok: false, code: "no_capability" });
    if (!noCapability.ok) expect(noCapability.reason).toContain("backend-development");
  });

  it("does not fall back to another enabled agent when the CTO pick is unusable", () => {
    const decision = parseCtoDecision({ role: "frontend", capability: "backend-development", reason: "x" })!;
    const result = validateCtoDecision(decision, agents);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("frontend");
  });

  it("routes an answer-self decision to the enabled CTO", () => {
    const decision = parseCtoDecision({ role: "cto", capability: "architecture", reason: "advice", answerSelf: true })!;
    const result = validateCtoDecision(decision, agents);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.agent._id).toBe("cto");
  });
});
