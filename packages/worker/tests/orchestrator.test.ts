import { describe, expect, it } from "vitest";
import { classifyCommand } from "@/orchestrator/classifier";
import { createOrchestratorPlan, evaluateAfterExecution } from "@/orchestrator/orchestrator";
import { BudgetTracker } from "@/orchestrator/budget";
import type { AgentDefinition } from "@/orchestrator/types";
import { loadPolicy } from "@/orchestrator/policy";
import { routePrimaryAgent, evaluateDelegation } from "@/orchestrator/delegation";

const policy = loadPolicy();

const developer: AgentDefinition = {
  _id: "dev1",
  name: "Developer",
  role: "developer",
  capabilities: ["frontend-development", "backend-development", "general"],
};
const qa: AgentDefinition = {
  _id: "qa1",
  name: "QA",
  role: "qa",
  capabilities: ["browser-testing"],
};
const architect: AgentDefinition = {
  _id: "arch1",
  name: "Architect",
  role: "architect",
  capabilities: ["architecture"],
};
const security: AgentDefinition = {
  _id: "sec1",
  name: "Security",
  role: "security",
  capabilities: ["security-audit"],
};

describe("routing", () => {
  it("A: simple task selects one appropriate agent", () => {
    const cmd = "Explain a programming concept";
    const cls = classifyCommand(cmd);
    const plan = createOrchestratorPlan({
      taskId: "t1",
      projectId: "p1",
      command: cmd,
      title: "Explain concept",
      agents: [developer, qa, architect],
      classification: cls,
    });
    expect(plan.primary).not.toBeNull();
    expect(plan.primary?.name).toBeTruthy();
  });

  it("B: feature implementation needs QA when capable agent exists", () => {
    const cmd = "Implement authentication with tests";
    const cls = classifyCommand(cmd);
    const plan = createOrchestratorPlan({
      taskId: "t2",
      projectId: "p1",
      command: cmd,
      title: "Auth",
      agents: [developer, qa],
      classification: cls,
    });
    // primary should be developer for code_change
    expect(plan.primary?.name).toBe("Developer");
  });

  it("F: unavailable agent handled gracefully", () => {
    const cmd = "Implement something";
    const plan = createOrchestratorPlan({
      taskId: "t3",
      projectId: "p1",
      command: cmd,
      title: "Test",
      agents: [
        { ...developer, isEnabled: false },
        { ...qa, isEnabled: false },
      ],
    });
    expect(plan.primary).toBeNull();
    expect(plan.budgetLimitations).toBeTypeOf("string");
  });
});

describe("delegation", () => {
  it("evaluates delegation approve when agent recommends", () => {
    const budget = new BudgetTracker(policy);
    const result: any = {
      agentName: "Developer",
      capability: "frontend-development",
      success: true,
      summary: "done",
      delegationRecommendation: { targetCapability: "browser-testing", reason: "Need QA validation" },
    };
    const evalRes = evaluateDelegation({
      result,
      classification: classifyCommand("implement feature"),
      agents: [developer, qa],
      budget,
      previousAgents: ["Developer"],
      delegationDepth: 0,
      alreadyDelegatedCapabilities: [],
    });
    expect(evalRes.decision).toBe("APPROVE");
    expect(evalRes.targetAgent?.name).toBe("QA");
  });

  it("rejects circular delegation", () => {
    const budget = new BudgetTracker(policy);
    const result: any = {
      agentName: "QA",
      capability: "browser-testing",
      success: true,
      summary: "tested",
      delegationRecommendation: { targetCapability: "browser-testing", reason: "loop" },
    };
    const evalRes = evaluateDelegation({
      result,
      classification: classifyCommand("test"),
      agents: [developer, qa],
      budget,
      previousAgents: ["QA"],
      delegationDepth: 0,
      alreadyDelegatedCapabilities: ["browser-testing"],
    });
    expect(evalRes.decision).toBe("REJECT");
  });

  it("revise back to developer when QA finds critical", () => {
    const budget = new BudgetTracker(policy);
    const result: any = {
      agentName: "QA",
      capability: "browser-testing",
      success: true,
      summary: "failed",
      findings: [
        {
          severity: "critical",
          filePath: "src/auth.ts",
          description: "invalid credentials accepted",
          suggestion: "Validate credentials before creating a session",
        },
      ],
    };
    const evalRes = evaluateDelegation({
      result,
      classification: classifyCommand("implement auth"),
      agents: [developer, qa],
      budget,
      previousAgents: ["Developer", "QA"],
      delegationDepth: 1,
      alreadyDelegatedCapabilities: [],
    });
    expect(evalRes.decision).toBe("REVISE");
  });

  it("does not revise on low-severity findings that merely mention failure", () => {
    const budget = new BudgetTracker(policy);
    const result: any = {
      agentName: "QA",
      capability: "browser-testing",
      success: true,
      summary: "checked",
      findings: [
        {
          severity: "low",
          filePath: "",
          description: "no failures found on the happy path",
          suggestion: "",
        },
      ],
    };
    const evalRes = evaluateDelegation({
      result,
      classification: classifyCommand("implement auth"),
      agents: [developer, qa],
      budget,
      previousAgents: ["Developer", "QA"],
      delegationDepth: 1,
      alreadyDelegatedCapabilities: [],
    });
    expect(evalRes.decision).toBe("COMPLETE");
  });
});

describe("shared context", () => {
  it("all agents use same task id and previous results available", () => {
    const cls = classifyCommand("Build authentication");
    const base = createOrchestratorPlan({
      taskId: "AUTH-001",
      projectId: "p1",
      command: "Build authentication",
      title: "Auth",
      agents: [developer, qa],
      classification: cls,
    });
    expect(base.sharedContext.taskId).toBe("AUTH-001");

    const budget = new BudgetTracker(policy);
    budget.recordAgent("dev1", "Developer");
    budget.recordLLMCall({ inputTokens: 100, outputTokens: 50, model: "gpt-4o", agentName: "Developer", agentId: "dev1" });

    const updated = evaluateAfterExecution({
      result: {
        agentName: "Developer",
        capability: "frontend-development",
        success: true,
        summary: "Implemented auth: login, session",
        findings: [],
      },
      classification: cls,
      agents: [developer, qa],
      budget,
      previousAgents: ["Developer"],
      delegationDepth: 0,
      alreadyDelegated: [],
      taskContext: base.sharedContext,
    });

    expect(updated.updatedContext.taskId).toBe("AUTH-001");
    expect(updated.updatedContext.agentExecutions).toHaveLength(1);
    expect(updated.updatedContext.agentExecutions[0].agentName).toBe("Developer");

    // Next agent should see previous result
    const nextEval = evaluateAfterExecution({
      result: {
        agentName: "QA",
        capability: "browser-testing",
        success: true,
        summary: "All tests passed",
      },
      classification: cls,
      agents: [developer, qa],
      budget,
      previousAgents: ["Developer", "QA"],
      delegationDepth: 1,
      alreadyDelegated: ["browser-testing"],
      taskContext: updated.updatedContext,
    });
    expect(nextEval.updatedContext.agentExecutions).toHaveLength(2);
  });
});

describe("budget", () => {
  it("enforces LLM call limits", () => {
    const tightPolicy = { ...policy, maxLLMCallsPerTask: 2, maxTokenBudgetPerTask: 500, maxAgentsPerTask: 3 };
    const budget = new BudgetTracker(tightPolicy);
    budget.recordLLMCall({ inputTokens: 100, outputTokens: 100, model: "m", agentName: "A" });
    budget.recordLLMCall({ inputTokens: 100, outputTokens: 100, model: "m", agentName: "A" });
    expect(budget.canCallLLM()).toBe(false);
    expect(budget.isBudgetExhausted().exhausted).toBe(true);
  });

  it("E: budget exhaustion returns blocked", () => {
    const tightPolicy = { ...policy, maxLLMCallsPerTask: 1 };
    const budget = new BudgetTracker(tightPolicy);
    budget.recordLLMCall({ inputTokens: 10, outputTokens: 10, model: "m", agentName: "A" });
    const cls = classifyCommand("Build feature");
    const base = createOrchestratorPlan({
      taskId: "t-budget",
      projectId: "p1",
      command: "Build feature",
      title: "feat",
      agents: [developer, qa],
      classification: cls,
      budget,
    });
    const result = evaluateAfterExecution({
      result: { agentName: "Developer", capability: "frontend-development", success: true, summary: "done" },
      classification: cls,
      agents: [developer, qa],
      budget,
      previousAgents: ["Developer"],
      delegationDepth: 0,
      alreadyDelegated: [],
      taskContext: base.sharedContext,
    });
    expect(result.decision).toBe("BLOCKED");
  });
});

describe("lifecycle", () => {
  it("failed execution does not falsely complete", () => {
    const cls = classifyCommand("Build feature");
    const base = createOrchestratorPlan({
      taskId: "t-fail",
      projectId: "p1",
      command: "Build feature",
      title: "feat",
      agents: [developer],
      classification: cls,
    });
    const budget = new BudgetTracker(policy);
    const evalRes = evaluateAfterExecution({
      result: { agentName: "Developer", capability: "frontend-development", success: false, summary: "failed" },
      classification: cls,
      agents: [developer],
      budget,
      previousAgents: ["Developer"],
      delegationDepth: 0,
      alreadyDelegated: [],
      taskContext: base.sharedContext,
    });
    expect(evalRes.decision).toBe("REVISE"); // not COMPLETE
  });
});
