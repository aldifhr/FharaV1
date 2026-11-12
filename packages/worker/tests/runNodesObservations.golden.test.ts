import { describe, expect, it, vi } from "vitest";
import type { PlanSubtask } from "@/types";
import type { RunContext } from "@/services/runner/types";
import { testPolicy } from "./helpers";

/**
 * P1b phase 4 (scheduler purification): golden traces of the runNodes
 * outcomes that become engine observations, recorded BEFORE the move:
 *
 *   - an unmet prerequisite fails the subset closed (`prerequisite_missing`)
 *   - a node with no agent left is BLOCKED with the reason (`unroutable`;
 *     only reachable for a node already completed in an earlier run, since
 *     onStart throws for a fresh one — see unroutable-node.json)
 *
 * The OpenCode-unavailable fallback (`runtime_unavailable`) goes through
 * processTask: decisionEngine.golden.test.ts, opencode-unavailable-fallback.
 * The decision step and the brief update are stubbed: only runNodes' own
 * events, feedback and result are traced.
 */

vi.mock("../src/services/runner/decision", () => ({ handleNodeOutcome: async () => undefined }));
vi.mock("../src/services/runner/brief", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/runner/brief")>()),
  recordBriefAfterNode: async () => undefined,
}));

import { runNodes } from "@/services/runner/runNodes";

const subtask = (key: string, kind: string, capability: string, dependencies: string[] = []) =>
  ({ key, title: key, description: `Do ${key}`, kind, capability, dependencies, order: 0 }) as PlanSubtask;

async function run(input: { subtasks: PlanSubtask[]; nodes: string[]; completed?: string[] }): Promise<string> {
  const events: unknown[] = [];
  const feedback: string[] = [];
  const api = new Proxy({} as Record<string, unknown>, {
    get: (_, name: string) => async (args: Record<string, unknown>) => {
      if (name === "logEvent") events.push(args);
      return name === "getContext" ? { task: { status: "running" } } : undefined;
    },
  });
  const ctx = {
    plan: { version: 1, goal: "g", strategy: "dag", subtasks: input.subtasks },
    state: { feedback, fileChanges: new Map() },
    runCompleted: new Set(input.completed ?? []),
    executionIds: new Map(),
    assign: () => undefined,
    deps: { api, policy: testPolicy({ maxConcurrency: 1 }) },
    input: { agents: [] },
    task: { _id: "task-1", command: "c" },
    project: { _id: "project-1" },
    taskId: "task-1",
    activeByAgent: new Map(),
    modelRoutingByKey: new Map(),
    loadAwareByKey: new Map(),
    performanceByKey: new Map(),
    stallThresholds: { agentStallMs: 0, agentStallRetries: 1, repeatedOutputLimit: 3 },
    lastStatusCheck: 0,
  } as unknown as RunContext;
  const nodes = input.subtasks.filter((candidate) => input.nodes.includes(candidate.key));
  const result = await runNodes(ctx, nodes);
  return JSON.stringify(
    {
      events,
      feedback,
      result: { status: result.status, failed: result.failed, outcomes: Object.fromEntries(result.outcomes) },
    },
    null,
    2
  );
}

describe("runNodes observations: golden traces (no behaviour change)", () => {
  it("runnodes-prerequisite-missing", async () => {
    const subtasks = [
      subtask("design", "analysis", "architecture"),
      subtask("build", "code_change", "frontend-development", ["design", "review"]),
      subtask("docs", "code_change", "frontend-development", ["review"]),
      subtask("ship", "code_change", "frontend-development", ["design", "build"]),
      subtask("review", "review", "code-review", ["build"]),
    ];
    const trace = await run({ subtasks, nodes: ["build", "docs", "ship"] });
    await expect(`${trace}\n`).toMatchFileSnapshot("./__golden__/decision-engine/runnodes-prerequisite-missing.json");
  });

  it("runnodes-unroutable-blocked", async () => {
    const subtasks = [subtask("db", "code_change", "database-administration")];
    const trace = await run({ subtasks, nodes: ["db"], completed: ["db"] });
    await expect(`${trace}\n`).toMatchFileSnapshot("./__golden__/decision-engine/runnodes-unroutable-blocked.json");
  });
});
