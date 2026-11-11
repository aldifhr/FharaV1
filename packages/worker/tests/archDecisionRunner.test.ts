import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkerAgent, WorkerTask } from "@/workerApi";

/**
 * O1 end to end through processTask: the CTO's architecture decision node
 * gates the dependent work. go → the work runs; revise → one replan with
 * the CTO's text as planner feedback, the decision node frozen (not asked
 * again); stop → the task fails with the CTO's reason, never replanned; no
 * Decision line → go with a visible note.
 */
const mock = vi.hoisted(() => ({
  plannerCalls: [] as Array<{ feedback?: string }>,
  executed: [] as string[],
  ctoAnswer: "",
}));

vi.mock("../src/orchestrator/planner", () => {
  const decision = {
    key: "arch-decision",
    title: "Architecture decision: order status model",
    description: "Decide. End with Decision: go | revise | stop.",
    kind: "analysis",
    capability: "architecture",
    dependencies: [],
    order: 0,
  };
  const architecture = { needed: true, reasons: ["schema_change"], question: "order status model", gatedKeys: ["implement"], source: "planner" };
  const first = {
    version: 1,
    goal: "Status pesanan multi-tahap",
    strategy: "dag",
    requiresApproval: false,
    maxConcurrency: 1,
    architecture,
    subtasks: [
      decision,
      { key: "implement", title: "Implement", description: "Write it", kind: "analysis", capability: "frontend-development", dependencies: ["arch-decision"], order: 1 },
    ],
  };
  const second = {
    ...first,
    subtasks: [
      decision,
      {
        key: "implement_revised",
        title: "Implement (revised)",
        description: "Write it the CTO's way",
        kind: "analysis",
        capability: "frontend-development",
        dependencies: ["arch-decision"],
        order: 1,
        replanReasoning: "the CTO asked for a state machine",
      },
    ],
    replanRemovals: [{ key: "implement", reasoning: "replaced per the CTO's revise" }],
  };
  return {
    createPlan: async (input: { feedback?: string }) => {
      mock.plannerCalls.push({ feedback: input.feedback });
      return { plan: structuredClone(mock.plannerCalls.length === 1 ? first : second), createdBy: "orchestrator", notes: [] };
    },
    heuristicPlan: () => first,
  };
});

vi.mock("../src/execution/agentExecutor", () => ({
  executeSubtask: async (input: { subtask: { key: string } }) => {
    mock.executed.push(input.subtask.key);
    if (input.subtask.key === "arch-decision") return { status: "completed", output: mock.ctoAnswer };
    return { status: "completed", output: `${input.subtask.key} done` };
  },
}));

import { processTask } from "@/services/taskRunner";
import { createFakeApi, createRunnerDeps, testPolicy, testTask } from "./helpers";

const CTO = { _id: "agent-cto", name: "CTO", role: "cto", capabilities: ["architecture"], isEnabled: true, priority: 9 } as WorkerAgent;
const IMPLEMENTER = { _id: "agent-fe", name: "Frontend", role: "frontend", capabilities: ["frontend-development"], isEnabled: true, priority: 5 } as WorkerAgent;

let workspace: string;
beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-arch-"));
  mock.plannerCalls = [];
  mock.executed = [];
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

async function run(ctoAnswer: string) {
  mock.ctoAnswer = ctoAnswer;
  const task = testTask({ command: "Status pesanan multi-tahap" });
  const project = { _id: "project-1", name: "Fixture", workspacePath: workspace, approvalMode: "auto" as const };
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  let saves = 0;
  const { api, completions } = createFakeApi({
    getContext: async () => ({ task, project, agents: [CTO, IMPLEMENTER], plan: null, subtasks: [], approvalMode: "auto" as const }),
    savePlan: async () => ++saves,
    logEvent: async (event: { type: string; payload?: Record<string, unknown> }) => {
      events.push(event);
    },
  });
  const policy = testPolicy({
    maxConcurrency: 1,
    maxReplans: 1,
    maxPlanningIterations: 1,
    maxReviewIterations: 1,
    maxConcurrentLLMCalls: 1,
    subtaskRetries: 0,
    orchestratorAuthoritative: false,
    decisionLlmMode: "off",
  });
  await processTask(task as unknown as WorkerTask, createRunnerDeps({ api, policy, workspaceRoot: workspace }));
  const decisionEvents = events.filter((event) => event.type === "architecture.decision").map((event) => event.payload);
  return { completions, decisionEvents };
}

describe("O1: CTO architecture decision node in the runner", () => {
  it("go → the gated work runs and the task is not failed", async () => {
    const { completions, decisionEvents } = await run("Use a status enum with a transitions table.\nDecision: go");
    expect(mock.plannerCalls).toHaveLength(1);
    expect(mock.executed).toEqual(["arch-decision", "implement"]);
    expect(decisionEvents).toEqual([expect.objectContaining({ verdict: "go", parsed: true })]);
    expect(completions.at(-1)?.status).not.toBe("failed");
  });

  it("revise → one replan with the CTO's text; the decision node is not asked again", async () => {
    const { completions, decisionEvents } = await run("A flat status string will not hold up. Use a state machine.\nDecision: revise");
    expect(mock.plannerCalls).toHaveLength(2);
    expect(mock.plannerCalls[1].feedback).toContain("Architecture decision: revise");
    expect(mock.plannerCalls[1].feedback).toContain("Use a state machine.");
    expect(mock.executed).toEqual(["arch-decision", "implement_revised"]);
    expect(decisionEvents).toEqual([expect.objectContaining({ verdict: "revise" })]);
    expect(completions.at(-1)?.status).not.toBe("failed");
  });

  it("stop → the task fails with the CTO's reason and is never replanned", async () => {
    const { completions } = await run("This duplicates the billing service's order model.\nDecision: stop");
    expect(mock.plannerCalls).toHaveLength(1);
    expect(mock.executed).toEqual(["arch-decision"]);
    const last = completions.at(-1) as { status?: string; error?: string } | undefined;
    expect(last?.status).toBe("failed");
    expect(JSON.stringify(last)).toContain("Architecture decision: stop");
    expect(JSON.stringify(last)).toContain("duplicates the billing service");
  });

  it("no Decision line → go, with a note on the event", async () => {
    const { decisionEvents } = await run("Looks reasonable.");
    expect(mock.executed).toEqual(["arch-decision", "implement"]);
    expect(decisionEvents).toEqual([expect.objectContaining({ verdict: "go", parsed: false, note: expect.stringContaining("treated as go") })]);
  });
});
