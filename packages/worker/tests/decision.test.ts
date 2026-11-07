import { describe, it, expect, vi } from "vitest";
import { loadPolicy, type ExecutionPolicy } from "@/orchestrator/policy";
import type { AgentDefinition } from "@/orchestrator/types";
import { CAPABILITY } from "@/orchestrator/types";
import {
  validateDecision,
  decide,
  evaluateObjective,
  nextDeterministicDecision,
  type DecisionContext,
  type DecisionObservation,
} from "@/orchestrator/decision";
import type { Classification } from "@/orchestrator/types";

const dev: AgentDefinition = {
  _id: "dev1",
  name: "Developer",
  role: "developer",
  capabilities: [CAPABILITY.FRONTEND, CAPABILITY.BACKEND, CAPABILITY.GENERAL],
};
const qa: AgentDefinition = {
  _id: "qa1",
  name: "QA",
  role: "qa",
  capabilities: [CAPABILITY.BROWSER_TESTING],
};
const agents = [dev, qa];

function policy(overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  return {
    ...loadPolicy(),
    maxSubtasks: 8,
    maxDelegationDepth: 2,
    maxDelegations: 10,
    maxAgentsPerTask: 3,
    decisionEngine: true,
    decisionLlmMode: "off",
    maxDecisionSteps: 20,
    ...overrides,
  };
}

function context(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return {
    taskId: "t1",
    objective: "Build the login page",
    classification: { kind: "code_change", strategy: "single", reasons: [], suggestedCapabilities: [] } as Classification,
    planVersion: 1,
    plan: {
      version: 1,
      goal: "Build the login page",
      strategy: "single",
      requiresApproval: false,
      maxConcurrency: 1,
      subtasks: [
        { key: "impl", title: "Impl", description: "d", kind: "code_change", capability: CAPABILITY.FRONTEND, dependencies: [], order: 0 },
      ],
    },
    results: [],
    openIssues: [],
    budget: {
      llmCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      agentCount: 1,
      agents: ["dev1"],
      delegationDepth: 0,
      retries: 0,
      elapsedMs: 0,
      maxLLMCalls: 12,
      maxTokenBudget: 50_000,
      maxAgents: 3,
    },
    policy: policy(),
    agents,
    completedKeys: new Set(["impl"]),
    step: 0,
    chainCapabilities: [CAPABILITY.FRONTEND],
    activeByAgent: new Map(),
    ...overrides,
  };
}

function observation(overrides: Partial<DecisionObservation> = {}): DecisionObservation {
  return {
    outcome: "completed",
    decision: "COMPLETE",
    nextAgent: null,
    nextCapability: null,
    reason: "objective met",
    ...overrides,
  };
}

const validDelegate = {
  action: "delegate",
  reasoning: "qa needed",
  target: { capability: CAPABILITY.BROWSER_TESTING },
  task: {
    key: "qa-run",
    title: "Run QA",
    description: "Validate the login page",
    kind: "qa",
    capability: CAPABILITY.BROWSER_TESTING,
  },
  expectedOutcome: "qa:passed",
};

describe("decision: validateDecision", () => {
  it("accepts a valid delegate decision", () => {
    const result = validateDecision(validDelegate, context(), { id: "d1", decidedBy: "deterministic" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision.action).toBe("delegate");
      expect(result.decision.decidedBy).toBe("deterministic");
      expect(result.decision.planVersion).toBe(1);
    }
  });

  it("rejects when the node budget is exceeded (policy)", () => {
    const full = context({
      plan: {
        version: 1,
        goal: "g",
        strategy: "single",
        requiresApproval: false,
        maxConcurrency: 1,
        subtasks: Array.from({ length: 8 }, (_, i) => ({
          key: `k${i}`,
          title: `t${i}`,
          description: "d",
          kind: "code_change" as const,
          capability: CAPABILITY.FRONTEND,
          dependencies: [],
          order: i,
        })),
      },
    });
    const result = validateDecision(validDelegate, full, { id: "d2", decidedBy: "llm" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violated).toBe("policy");
  });

  it("rejects an unknown capability (routing, allowFallback disabled)", () => {
    const result = validateDecision(
      {
        ...validDelegate,
        target: { capability: "does-not-exist" },
        task: { ...validDelegate.task, key: "x1", capability: "does-not-exist" },
      },
      context(),
      { id: "d3", decidedBy: "llm" }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violated).toBe("routing");
  });

  it("rejects a dependency cycle", () => {
    const result = validateDecision(
      {
        ...validDelegate,
        dependencies: ["qa-run"],
      },
      context(),
      { id: "d4", decidedBy: "llm" }
    );
    // qa-run depends on itself -> cycle
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("cycle");
  });

  it("rejects a duplicate key", () => {
    const result = validateDecision(
      { ...validDelegate, task: { ...validDelegate.task, key: "impl" } },
      context(),
      { id: "d5", decidedBy: "llm" }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("duplicate");
  });

  it("rejects complete without expectedOutcome", () => {
    const result = validateDecision(
      { action: "complete", reasoning: "done" },
      context(),
      { id: "d6", decidedBy: "deterministic" }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("expectedOutcome");
  });

  it("rejects ask_user without a question", () => {
    const result = validateDecision(
      { action: "ask_user", reasoning: "blocked" },
      context(),
      { id: "d7", decidedBy: "deterministic" }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("question");
  });

  it("accepts a valid parallel batch", () => {
    const result = validateDecision(
      {
        action: "parallel",
        reasoning: "two independent checks",
        tasks: [
          { key: "qa1", title: "QA", description: "d", kind: "qa", capability: CAPABILITY.BROWSER_TESTING },
          { key: "fe2", title: "Polish", description: "d", kind: "code_change", capability: CAPABILITY.FRONTEND },
        ],
        dependencies: ["impl"],
      },
      context(),
      { id: "d8", decidedBy: "llm" }
    );
    expect(result.ok).toBe(true);
  });
});

describe("decision: nextDeterministicDecision", () => {
  it("maps BLOCKED to complete (policy:budget)", () => {
    const det = nextDeterministicDecision(context(), observation({ decision: "BLOCKED" }));
    expect(det).not.toBe("ambiguous");
    if (det !== "ambiguous") {
      expect(det.action).toBe("complete");
      expect(det.expectedOutcome).toBe("policy:budget");
    }
  });

  it("maps APPROVE with a capability to delegate", () => {
    const det = nextDeterministicDecision(
      context(),
      observation({ decision: "APPROVE", nextCapability: CAPABILITY.BROWSER_TESTING, nextAgent: qa })
    );
    expect(det).not.toBe("ambiguous");
    if (det !== "ambiguous") {
      expect(det.action).toBe("delegate");
      expect(det.target?.capability).toBe(CAPABILITY.BROWSER_TESTING);
    }
  });

  it("maps REVISE with findings to an execute fix task", () => {
    const det = nextDeterministicDecision(
      context(),
      observation({
        decision: "REVISE",
        nextCapability: CAPABILITY.FRONTEND,
        findings: [{ severity: "high", filePath: "a.ts", description: "broken", suggestion: "fix it" }],
      })
    );
    expect(det).not.toBe("ambiguous");
    if (det !== "ambiguous") {
      expect(det.action).toBe("execute");
      expect(det.task?.kind).toBe("code_change");
    }
  });

  it("maps REJECT to complete (proposal:rejected)", () => {
    const det = nextDeterministicDecision(context(), observation({ decision: "REJECT" }));
    expect(det).not.toBe("ambiguous");
    if (det !== "ambiguous") expect(det.expectedOutcome).toBe("proposal:rejected");
  });

  it("maps COMPLETE to complete (objective:met)", () => {
    const det = nextDeterministicDecision(context(), observation({ decision: "COMPLETE" }));
    expect(det).not.toBe("ambiguous");
    if (det !== "ambiguous") expect(det.expectedOutcome).toBe("objective:met");
  });

  it("maps a transient failure to execute (retry)", () => {
    const det = nextDeterministicDecision(
      context(),
      observation({ outcome: "failed", decision: "REVISE", error: "429 rate limit", retryable: true })
    );
    expect(det).not.toBe("ambiguous");
    if (det !== "ambiguous") {
      expect(det.action).toBe("execute");
      expect(det.expectedOutcome).toBe("retry");
    }
  });

  it("maps a permanent failure to replan (recorded no-op in Phase 2)", () => {
    const det = nextDeterministicDecision(
      context(),
      observation({ outcome: "failed", decision: "REVISE", error: "unparseable output", retryable: false })
    );
    expect(det).not.toBe("ambiguous");
    if (det !== "ambiguous") expect(det.action).toBe("replan");
  });

  it("returns ambiguous for APPROVE without a capability", () => {
    expect(nextDeterministicDecision(context(), observation({ decision: "APPROVE" }))).toBe("ambiguous");
  });
});

describe("decision: decide() advisor + fallback", () => {
  it("mode off never consults the advisor", async () => {
    const ask = vi.fn(async () => JSON.stringify(validDelegate));
    const result = await decide(context(), observation({ decision: "APPROVE" }), {
      llmMode: "off",
      advise: ask,
    });
    expect(ask).not.toHaveBeenCalled();
    expect(result.decision.action).toBe("complete");
    expect(result.decision.expectedOutcome).toBe("ambiguous:no-op");
  });

  it("ambiguous + advisor: a valid advisor answer is used", async () => {
    const result = await decide(context(), observation({ decision: "APPROVE" }), {
      llmMode: "ambiguous",
      advise: async () => validDelegate,
    });
    expect(result.decision.action).toBe("delegate");
    expect(result.decision.decidedBy).toBe("llm");
    expect(result.fallback).toBeUndefined();
  });

  it("ambiguous + advisor: an invalid answer falls back to the deterministic no-op", async () => {
    const result = await decide(context(), observation({ decision: "APPROVE" }), {
      llmMode: "ambiguous",
      advise: async () => ({ action: "bogus" }),
    });
    expect(result.decision.action).toBe("complete");
    expect(result.fallback).toContain("validation failed");
  });

  it("advisor throws -> deterministic fallback", async () => {
    const result = await decide(context(), observation({ decision: "COMPLETE" }), {
      llmMode: "always",
      advise: async () => {
        throw new Error("provider down");
      },
    });
    expect(result.decision.action).toBe("complete");
    expect(result.decision.expectedOutcome).toBe("objective:met");
    expect(result.decision.decidedBy).toBe("deterministic");
    expect(result.fallback).toContain("provider down");
  });

  it("step limit returns a complete decision without consulting the advisor", async () => {
    const ask = vi.fn(async () => validDelegate);
    const result = await decide(context({ step: 20 }), observation(), {
      llmMode: "always",
      advise: ask,
    });
    expect(ask).not.toHaveBeenCalled();
    expect(result.decision.expectedOutcome).toBe("decision:step_limit");
  });

  it("ambiguous + advisor throws -> deterministic fallback + recorded reason (scenario H)", async () => {
    const ask = vi.fn(async () => {
      throw new Error("provider down");
    });
    const result = await decide(context(), observation({ decision: "APPROVE" }), {
      llmMode: "ambiguous",
      advise: ask,
    });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(result.decision.action).toBe("complete");
    expect(result.decision.expectedOutcome).toBe("ambiguous:no-op");
    expect(result.decision.decidedBy).toBe("deterministic");
    // The runner records this as orchestrator.decision_fallback.
    expect(result.fallback).toContain("provider down");
  });

  it("ambiguous + advisor returns unparseable JSON -> deterministic fallback", async () => {
    const result = await decide(context(), observation({ decision: "APPROVE" }), {
      llmMode: "ambiguous",
      advise: async () => "not json at all",
    });
    expect(result.decision.decidedBy).toBe("deterministic");
    expect(result.fallback).toContain("validation failed");
  });

  it("ambiguous + advisor proposes a capability no agent serves -> policy wins (routing)", async () => {
    const result = await decide(context(), observation({ decision: "APPROVE" }), {
      llmMode: "ambiguous",
      advise: async () => ({
        ...validDelegate,
        target: { capability: "does-not-exist" },
        task: { ...validDelegate.task, key: "x9", capability: "does-not-exist" },
      }),
    });
    expect(result.decision.decidedBy).toBe("deterministic");
    expect(result.fallback).toContain("no enabled agent serves");
  });
});

describe("decision: evaluateObjective (step 5.1)", () => {
  const satisfiedContext = (): DecisionContext =>
    context({
      objectiveEvidence: {
        appliedFiles: { impl: ["file-impl.txt"] },
        qaVerdicts: {},
        lastDecision: { action: "complete", expectedOutcome: "objective:met" },
      },
    });

  it("satisfied when every completed code_change has an applied file and the outcome is met", () => {
    const result = evaluateObjective(satisfiedContext());
    expect(result.satisfied).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.evidence.some((entry) => entry.includes("impl: 1 file change(s) applied"))).toBe(true);
  });

  it("not satisfied when a completed code_change has no applied file (complete without evidence)", () => {
    const result = evaluateObjective(
      context({
        objectiveEvidence: {
          appliedFiles: {},
          lastDecision: { action: "complete", expectedOutcome: "objective:met" },
        },
      })
    );
    expect(result.satisfied).toBe(false);
    expect(result.missing).toEqual([
      "impl: code_change completed with no applied file change",
    ]);
  });

  it("not satisfied when a QA node has no passing verdict", () => {
    const withQa = context({
      plan: {
        version: 1,
        goal: "g",
        strategy: "single",
        requiresApproval: false,
        maxConcurrency: 1,
        subtasks: [
          { key: "impl", title: "Impl", description: "d", kind: "code_change", capability: CAPABILITY.FRONTEND, dependencies: [], order: 0 },
          { key: "qa-1", title: "QA", description: "d", kind: "qa", capability: CAPABILITY.BROWSER_TESTING, dependencies: ["impl"], order: 1 },
        ],
      },
      objectiveEvidence: {
        appliedFiles: { impl: ["file-impl.txt"] },
        qaVerdicts: { "qa-1": "failed" },
        lastDecision: { action: "complete", expectedOutcome: "objective:met" },
      },
    });
    const result = evaluateObjective(withQa);
    expect(result.satisfied).toBe(false);
    expect(result.missing).toEqual(["qa-1: QA verdict is failed"]);
  });

  it("not satisfied when the last decision outcome is unmet (recovery)", () => {
    const result = evaluateObjective(
      context({
        objectiveEvidence: {
          appliedFiles: { impl: ["file-impl.txt"] },
          lastDecision: { action: "replan", expectedOutcome: "recovery" },
        },
      })
    );
    expect(result.satisfied).toBe(false);
    expect(result.missing).toEqual(['last decision outcome "recovery" is not met']);
  });

  it("not satisfied when static verification failed", () => {
    const result = evaluateObjective(
      context({
        objectiveEvidence: {
          appliedFiles: { impl: ["file-impl.txt"] },
          verification: { status: "failed", details: "tests: 2 failed" },
          lastDecision: { action: "complete", expectedOutcome: "objective:met" },
        },
      })
    );
    expect(result.satisfied).toBe(false);
    expect(result.missing).toEqual(["static verification failed: tests: 2 failed"]);
  });

  it("research/audit tasks are exempt from the file-change criterion", () => {
    const result = evaluateObjective(
      context({
        completedKeys: new Set(["impl"]),
        plan: {
          version: 1,
          goal: "g",
          strategy: "single",
          requiresApproval: false,
          maxConcurrency: 1,
          subtasks: [
            { key: "impl", title: "Research", description: "d", kind: "research", capability: CAPABILITY.RESEARCH, dependencies: [], order: 0 },
          ],
        },
        objectiveEvidence: {
          appliedFiles: {},
          lastDecision: { action: "complete", expectedOutcome: "objective:met" },
        },
      })
    );
    expect(result.satisfied).toBe(true);
    expect(result.missing).toEqual([]);
  });
});
