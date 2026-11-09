import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkerAgent, WorkerTask } from "@/workerApi";

/**
 * Replan Intelligence end to end through processTask: a completed node
 * that passed (the analysis) is FROZEN — the replan carries it over
 * unchanged and it is never executed again, even when the planner
 * rewrote it; only the failed branch is replaced. The accepted plan
 * version carries the diff record (payload.replan), and no subtask row
 * carries the planner-only replanReasoning field.
 */

const mock = vi.hoisted(() => ({
  plannerCalls: [] as Array<{ feedback?: string }>,
  executed: [] as string[],
}));

vi.mock("../src/orchestrator/planner", () => {
  const first = {
    version: 1,
    goal: "Implement the feature",
    strategy: "dag",
    requiresApproval: false,
    maxConcurrency: 1,
    subtasks: [
      { key: "analyze", title: "Analyze", description: "Read the code", kind: "analysis", capability: "frontend-development", dependencies: [], order: 0 },
      { key: "implement", title: "Implement", description: "Write the code", kind: "code_change", capability: "frontend-development", dependencies: ["analyze"], order: 1 },
    ],
  };
  const second = {
    ...first,
    subtasks: [
      // The planner rewrote the frozen node: the Preservation Guard restores it.
      { key: "analyze", title: "Analyze again", description: "Read the code twice", kind: "analysis", capability: "frontend-development", dependencies: [], order: 0 },
      {
        key: "implement_small",
        title: "Implement (narrow)",
        description: "Write only the header change",
        kind: "code_change",
        capability: "frontend-development",
        dependencies: ["analyze"],
        order: 1,
        replanReasoning: "the full change exploded; narrow it to the header",
      },
    ],
    replanRemovals: [{ key: "implement", reasoning: "replaced by implement_small" }],
  };
  return {
    createPlan: async (input: { feedback?: string }) => {
      mock.plannerCalls.push({ feedback: input.feedback });
      return { plan: mock.plannerCalls.length === 1 ? first : second, createdBy: "llm", notes: [] };
    },
    heuristicPlan: () => first,
  };
});

vi.mock("../src/execution/agentExecutor", () => ({
  executeSubtask: async (input: { subtask: { key: string } }) => {
    mock.executed.push(input.subtask.key);
    if (input.subtask.key === "analyze") return { status: "completed", output: "analysis done" };
    return { status: "failed", error: "boom: implementation exploded" };
  },
}));

import { processTask } from "@/services/taskRunner";
import { createFakeApi, createRunnerDeps, testPolicy, testTask } from "./helpers";

const IMPLEMENTER = {
  _id: "agent-implementer",
  name: "Implementer",
  role: "frontend",
  capabilities: ["frontend-development"],
  isEnabled: true,
  priority: 0,
} as WorkerAgent;

let workspace: string;
beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "moagent-preserve-"));
  mock.plannerCalls = [];
  mock.executed = [];
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("Replan preservation (completed nodes never re-run)", () => {
  it("freezes the passed node, replans only the failed branch, and stores the diff", async () => {
    const task = testTask({ title: "Implement the feature", command: "Implement the feature" });
    const project = { _id: "project-1", name: "Fixture", workspacePath: workspace, approvalMode: "auto" as const };
    const saved: Array<Record<string, unknown>> = [];
    const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const { api, completions } = createFakeApi({
      getContext: async () => ({ task, project, agents: [IMPLEMENTER], plan: null, subtasks: [], approvalMode: "auto" as const }),
      savePlan: async (input: Record<string, unknown>) => {
        saved.push(input);
        return saved.length;
      },
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

    expect(mock.plannerCalls).toHaveLength(2);
    // The scope handed to the LLM: failed node, frozen node.
    const feedback = mock.plannerCalls[1].feedback ?? "";
    expect(feedback).toContain("Failed nodes");
    expect(feedback).toContain("- implement [code_change/frontend-development]");
    expect(feedback).toContain("FROZEN completed nodes");
    expect(feedback).toContain("- analyze [analysis/frontend-development]");

    // analyze ran exactly once across both plan versions.
    expect(mock.executed.filter((key) => key === "analyze")).toHaveLength(1);
    expect(mock.executed).toContain("implement_small");

    const replanned = saved.at(-1)!;
    const payload = replanned.payload as {
      subtasks: Array<{ key: string; description: string; replanReasoning?: string }>;
      replanRemovals?: unknown;
      replan: {
        failedKeys: string[];
        frozenKeys: string[];
        restoredKeys: string[];
        diff: { added: Array<{ key: string; reasoning?: string }>; removed: Array<{ key: string; reasoning?: string }>; preserved: Array<{ key: string; frozen?: boolean }> };
      };
    };
    // Frozen node restored verbatim.
    expect(payload.subtasks.find((subtask) => subtask.key === "analyze")?.description).toBe("Read the code");
    expect(payload.replan.failedKeys).toEqual(["implement"]);
    expect(payload.replan.frozenKeys).toEqual(["analyze"]);
    expect(payload.replan.restoredKeys).toEqual(["analyze"]);
    expect(payload.replan.diff.added).toEqual([
      expect.objectContaining({ key: "implement_small", reasoning: "the full change exploded; narrow it to the header" }),
    ]);
    expect(payload.replan.diff.removed).toEqual([expect.objectContaining({ key: "implement", reasoning: "replaced by implement_small" })]);
    expect(payload.replan.diff.preserved).toEqual([expect.objectContaining({ key: "analyze", frozen: true })]);
    // Planner-only fields never reach the rows / payload subtasks.
    expect(payload.replanRemovals).toBeUndefined();
    for (const subtask of replanned.subtasks as Array<Record<string, unknown>>) {
      expect(subtask).not.toHaveProperty("replanReasoning");
    }
    expect(events.some((event) => event.type === "plan.replan_diff")).toBe(true);
    expect(completions.at(-1)?.status).toBe("failed");
  });
});
