import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkerAgent, WorkerTask } from "@/workerApi";
import { createSharedTaskContext } from "@/orchestrator/taskContext";
import { classifyCommand } from "@/orchestrator/classifier";
import { buildAgentExecutionContext, formatAgentContextForPrompt } from "@/execution/agentContext";
import { createInputDeliveryAck, pullTaskInputs } from "@/services/runner/session";
import { createFakeApi, createRunnerDeps, testPolicy, testTask } from "./helpers";

/**
 * Single input guard, worker side: undelivered steer/answer inputs are
 * folded into the shared context before each subtask, always rendered in
 * the agent prompt, and acknowledged as delivered ONLY when a prompt
 * actually renders them.
 */

const captured = vi.hoisted(() => ({ inputs: [] as Array<Record<string, any>>, renderInPrompt: false }));

vi.mock("../src/execution/agentExecutor", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/execution/agentExecutor")>();
  return {
    ...orig,
    executeSubtask: async (input: any) => {
      captured.inputs.push(input);
      // Real prompt construction path when the test wants the LLM prompt built.
      if (captured.renderInPrompt) orig.priorContextFor(input);
      return { status: "completed", output: "done" };
    },
  };
});

vi.mock("../src/orchestrator/planner", () => {
  const plan = {
    version: 1,
    goal: "Implement the feature",
    strategy: "dag",
    requiresApproval: false,
    maxConcurrency: 1,
    subtasks: [
      {
        key: "implement",
        title: "Implement",
        description: "Write the code",
        kind: "code_change",
        capability: "frontend-development",
        dependencies: [],
        order: 0,
      },
    ],
  };
  return { createPlan: async () => ({ plan, createdBy: "llm", notes: [] }), heuristicPlan: () => plan };
});

import { processTask } from "@/services/taskRunner";
import { priorContextFor } from "../src/execution/agentExecutor";

const IMPLEMENTER = {
  _id: "agent-implementer",
  name: "Implementer",
  role: "frontend",
  capabilities: ["frontend-development"],
  isEnabled: true,
  priority: 0,
} as WorkerAgent;

function sharedContext() {
  return createSharedTaskContext({
    taskId: "task-1",
    projectId: "project-1",
    originalRequest: "Build the page",
    title: "Build the page",
    classification: classifyCommand("Build the page"),
  });
}

let workspace: string;
beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-input-guard-"));
  captured.inputs = [];
  captured.renderInPrompt = false;
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("agent prompt renders user input", () => {
  it("keeps every user instruction even past the 3-decision window and reports its ids", () => {
    const ctx = sharedContext();
    ctx.decisions = [
      { decision: "user_answer", reason: "use the blue theme", fromAgent: "user", createdAt: 1, inputId: "in-1" },
      { decision: "APPROVE", reason: "a", createdAt: 2 },
      { decision: "APPROVE", reason: "b", createdAt: 3 },
      { decision: "APPROVE", reason: "c", createdAt: 4 },
      { decision: "APPROVE", reason: "d", createdAt: 5 },
    ];
    const curated = buildAgentExecutionContext({ taskContext: ctx, agent: IMPLEMENTER as any, assignment: "x" });
    expect(curated.userInputIds).toEqual(["in-1"]);
    const prompt = formatAgentContextForPrompt(curated);
    expect(prompt).toContain("use the blue theme");
    expect(prompt).toContain("Instructions from the user");
  });

  it("priorContextFor acks exactly the inputs it rendered", () => {
    const ctx = sharedContext();
    ctx.decisions = [{ decision: "user_answer", reason: "rename to Foo", fromAgent: "user", createdAt: 1, inputId: "in-9" }];
    const acked: string[][] = [];
    const prompt = priorContextFor({
      taskContext: ctx,
      agent: IMPLEMENTER,
      subtask: { title: "t", description: "d" },
      priorOutputs: new Map(),
      onUserInputsRendered: (ids: string[]) => acked.push(ids),
    } as any);
    expect(prompt).toContain("rename to Foo");
    expect(acked).toEqual([["in-9"]]);
  });

  it("does not ack when the context has no user input", () => {
    const acked: string[][] = [];
    priorContextFor({
      taskContext: sharedContext(),
      agent: IMPLEMENTER,
      subtask: { title: "t", description: "d" },
      priorOutputs: new Map(),
      onUserInputsRendered: (ids: string[]) => acked.push(ids),
    } as any);
    expect(acked).toEqual([]);
  });
});

describe("pullTaskInputs / createInputDeliveryAck", () => {
  it("folds pending inputs once (dedupe by input id) without marking them delivered", async () => {
    const marked: string[][] = [];
    const { api } = createFakeApi({
      listPendingTaskInputs: async () => [{ _id: "in-1", kind: "steer", text: "also add tests", createdAt: 10 }],
      markTaskInputsDelivered: async ({ inputIds }: { inputIds: string[] }) => {
        marked.push(inputIds);
        return { marked: inputIds.length };
      },
    });
    const deps = createRunnerDeps({ api, policy: testPolicy({}), workspaceRoot: workspace });
    const ctx = sharedContext();
    await pullTaskInputs(deps, "task-1", ctx);
    await pullTaskInputs(deps, "task-1", ctx);
    const folded = ctx.decisions.filter((d) => d.decision === "user_answer");
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ reason: "also add tests", inputId: "in-1" });
    expect(marked).toHaveLength(0);
  });

  it("acks each input once per run and re-offers it if the ack fails", async () => {
    let fail = true;
    const marked: string[][] = [];
    const { api } = createFakeApi({
      markTaskInputsDelivered: async ({ inputIds }: { inputIds: string[] }) => {
        marked.push(inputIds);
        if (fail) throw new Error("network");
        return { marked: inputIds.length };
      },
    });
    const ack = createInputDeliveryAck(createRunnerDeps({ api, policy: testPolicy({}), workspaceRoot: workspace }));
    ack(["in-1"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fail = false;
    ack(["in-1"]);
    ack(["in-1"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(marked).toEqual([["in-1"], ["in-1"]]);
  });
});

describe("processTask delivers steer inputs", () => {
  function createDeps(marked: string[][]) {
    const task = testTask({ title: "Implement the feature", command: "Implement the feature" });
    const project = { _id: "project-1", name: "Fixture", workspacePath: workspace, approvalMode: "auto" as const };
    const { api } = createFakeApi({
      getContext: async () => ({ task, project, agents: [IMPLEMENTER], plan: null, subtasks: [], approvalMode: "auto" as const }),
      completeTask: async (input: Record<string, unknown>) => ({ applied: true, status: input.status }),
      listPendingTaskInputs: async () => [{ _id: "in-7", kind: "steer", text: "keep the old API", createdAt: 5 }],
      markTaskInputsDelivered: async ({ inputIds }: { inputIds: string[] }) => {
        marked.push(inputIds);
        return { marked: inputIds.length };
      },
    });
    const policy = testPolicy({
      maxConcurrency: 1,
      maxReplans: 1,
      maxPlanningIterations: 1,
      maxReviewIterations: 1,
      maxConcurrentLLMCalls: 1,
      orchestratorAuthoritative: false,
      decisionLlmMode: "off",
    });
    return { deps: createRunnerDeps({ api, policy, workspaceRoot: workspace }), task: task as unknown as WorkerTask };
  }

  it("hands the steer to the subtask but does not mark it delivered when no prompt rendered it", async () => {
    const marked: string[][] = [];
    const { deps, task } = createDeps(marked);
    await processTask(task, deps);
    const sub = captured.inputs[0];
    expect(sub?.taskContext?.decisions.some((d: any) => d.inputId === "in-7")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(marked.flat()).not.toContain("in-7");
  });

  it("marks the steer delivered (with the backend ack) once the prompt renders it", async () => {
    captured.renderInPrompt = true;
    const marked: string[][] = [];
    const { deps, task } = createDeps(marked);
    await processTask(task, deps);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(marked.flat()).toContain("in-7");
  });
});
