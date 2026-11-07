import { describe, expect, it } from "vitest";
import { parseDelegation } from "@/utils/json";
import { BudgetTracker } from "@/orchestrator/budget";
import { loadPolicy } from "@/orchestrator/policy";
import { classifyCommand } from "@/orchestrator/classifier";
import {
  evaluateDelegation,
  preventCircularDelegation,
} from "@/orchestrator/delegation";
import type { AgentDefinition } from "@/orchestrator/types";

describe("parseDelegation", () => {
  it("parses delegation recommendation", () => {
    const content = JSON.stringify({
      files: [],
      delegationRecommendation: { targetCapability: "browser-testing", reason: "Need QA", priority: "high" },
      findings: ["Issue 1"],
    });
    const result = parseDelegation(content);
    expect(result?.delegationRecommendation?.targetCapability).toBe("browser-testing");
    expect(result?.findings).toEqual(["Issue 1"]);
  });

  it("returns null when no delegation", () => {
    expect(parseDelegation(JSON.stringify({ files: [] }))).toBeNull();
  });
});

describe("evaluateDelegation branch chains (Phase 3)", () => {
  const developer: AgentDefinition = {
    _id: "dev1",
    name: "Developer",
    role: "developer",
    capabilities: ["frontend-development", "backend-development", "general"],
  };
  const security: AgentDefinition = {
    _id: "sec1",
    name: "Security",
    role: "security",
    capabilities: ["security-audit"],
  };
  const agents = [developer, security];

  const recommending = (capability: string, targetCapability: string) =>
    ({
      agentName: "Agent",
      capability,
      success: true,
      summary: "done",
      delegationRecommendation: {
        targetCapability,
        reason: "needs a specialist",
      },
    }) as any;

  const evaluate = (overrides: Record<string, unknown>) =>
    evaluateDelegation({
      result: recommending("frontend-development", "security-audit"),
      classification: classifyCommand("implement feature"),
      agents,
      budget: new BudgetTracker(loadPolicy()),
      previousAgents: [],
      delegationDepth: 0,
      alreadyDelegatedCapabilities: [],
      ...overrides,
    } as any);

  it("rejects an A→B→A cycle through the living branch chain", () => {
    const evalRes = evaluate({
      result: recommending("security-audit", "frontend-development"),
      chainCapabilities: ["frontend-development", "security-audit"],
    });
    expect(evalRes.decision).toBe("REJECT");
  });

  it("lets a sibling branch reuse a capability another branch already used", () => {
    // security-audit was delegated elsewhere in the task, but THIS
    // branch's chain does not contain it — the branch chain, not the
    // global already-delegated list, decides circularity.
    const evalRes = evaluate({
      chainCapabilities: ["backend-development"],
      alreadyDelegatedCapabilities: ["security-audit"],
    });
    expect(evalRes.decision).toBe("APPROVE");
    expect(evalRes.targetAgent?._id).toBe("sec1");
  });

  it("measures depth from the branch chain, not a global counter", () => {
    const evalRes = evaluate({
      result: recommending("code-review", "backend-development"),
      chainCapabilities: [
        "frontend-development",
        "security-audit",
        "code-review",
      ],
      // A shallow global counter must NOT rescue a deep branch.
      delegationDepth: 0,
    });
    expect(evalRes.decision).toBe("REJECT");
  });

  it("rejects delegation to an agent already at its concurrency limit", () => {
    const evalRes = evaluate({
      chainCapabilities: ["frontend-development"],
      activeByAgent: new Map([["sec1", 1]]),
    });
    expect(evalRes.decision).toBe("REJECT");
  });

  it("approves when the target agent is below its concurrency limit", () => {
    const evalRes = evaluate({
      chainCapabilities: ["frontend-development"],
      activeByAgent: new Map([["sec1", 0]]),
    });
    expect(evalRes.decision).toBe("APPROVE");
  });

  it("blocks (not loose-fallback) an unservable capability when allowFallback is off", () => {
    const noFallbackBudget = new BudgetTracker({
      ...loadPolicy(),
      allowFallback: false,
    });
    const blocked = evaluate({
      result: recommending("frontend-development", "github"),
      budget: noFallbackBudget,
      chainCapabilities: ["frontend-development"],
    });
    expect(blocked.decision).toBe("BLOCKED");

    const withFallback = evaluate({
      result: recommending("frontend-development", "github"),
      chainCapabilities: ["frontend-development"],
    });
    expect(withFallback.decision).toBe("APPROVE");
  });

  it("preventCircularDelegation reads the branch chain directly", () => {
    expect(
      preventCircularDelegation(
        ["frontend-development", "security-audit"],
        "frontend-development"
      )
    ).toBe(true);
    expect(
      preventCircularDelegation(["frontend-development"], "security-audit")
    ).toBe(false);
    expect(preventCircularDelegation([], "security-audit")).toBe(false);
  });
});

describe("evaluateDelegation selfServe (Phase 4 Step 4.1 — scenario E)", () => {
  const developer: AgentDefinition = {
    _id: "dev1",
    name: "Developer",
    role: "developer",
    capabilities: ["frontend-development", "backend-development"],
  };
  const security: AgentDefinition = {
    _id: "sec1",
    name: "Security",
    role: "security",
    capabilities: ["security-audit"],
  };
  const agents = [developer, security];

  const recommender = (capability: string, targetCapability: string, proposer: AgentDefinition) =>
    evaluateDelegation({
      result: {
        agentName: proposer.name,
        capability,
        success: true,
        summary: "done",
        delegationRecommendation: { targetCapability, reason: "another agent should do this" },
      } as any,
      classification: classifyCommand("implement feature"),
      agents,
      budget: new BudgetTracker(loadPolicy()),
      previousAgents: [],
      delegationDepth: 0,
      alreadyDelegatedCapabilities: [],
      chainCapabilities: [capability],
      proposer,
    });

  it("REJECTs a proposal the proposer can serve itself (scenario E)", () => {
    // The developer proposes delegating backend work — but the developer
    // already has backend-development among its own capabilities.
    const res = recommender("frontend-development", "backend-development", developer);
    expect(res.decision).toBe("REJECT");
    expect(res.reason).toContain("proposing agent can serve this capability");
  });

  it("matches after normalization (case/whitespace variants)", () => {
    const res = recommender("frontend-development", "Backend-Development ", developer);
    expect(res.decision).toBe("REJECT");
  });

  it("approves when the proposer cannot serve the proposed capability", () => {
    const res = recommender("frontend-development", "security-audit", developer);
    expect(res.decision).toBe("APPROVE");
    expect(res.targetAgent?._id).toBe("sec1");
  });

  it("without a proposer the legacy behaviour is kept (no selfServe REJECT)", () => {
    const res = evaluateDelegation({
      result: {
        agentName: "Developer",
        capability: "frontend-development",
        success: true,
        summary: "done",
        delegationRecommendation: { targetCapability: "backend-development", reason: "another agent" },
      } as any,
      classification: classifyCommand("implement feature"),
      agents,
      budget: new BudgetTracker(loadPolicy()),
      previousAgents: [],
      delegationDepth: 0,
      alreadyDelegatedCapabilities: [],
    });
    expect(res.decision).toBe("APPROVE");
  });
});
