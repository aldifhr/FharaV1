import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ExecutionPlan } from "@/orchestrator/types";

/**
 * Spec §8: the QA base URL must be resolved per task
 * (project.qaUrl > project.devUrl > worker-start env fallback) and threaded
 * explicitly runner -> executor -> runResponsiveQa, never via the shared
 * process.env.QA_BASE_URL (which raced across concurrent tasks).
 *
 * This file covers the resolver precedence and the executor -> QA hop
 * (runResponsiveQa spied). The runner -> executor hop is covered by
 * qaTaskRunner.test.ts, which mocks the executor instead.
 */

const qaSpy = vi.hoisted(() => ({
  calls: [] as Array<{ workspacePath: string; options: Record<string, unknown> }>,
}));

vi.mock("../src/execution/qa", () => ({
  runResponsiveQa: async (workspacePath: string, options: Record<string, unknown>) => {
    qaSpy.calls.push({ workspacePath, options });
    return { verdict: "passed", checks: [], failures: [], inconclusive: [] };
  },
}));

import { executeSubtask, type SubtaskExecutionInput } from "@/execution/agentExecutor";
import { resolveQaBaseUrl } from "@/services/taskRunner";

describe("resolveQaBaseUrl precedence", () => {
  it("prefers qaUrl over devUrl over the env fallback", () => {
    expect(
      resolveQaBaseUrl({ qaUrl: "http://qa:1", devUrl: "http://dev:2" }, "http://env:3")
    ).toBe("http://qa:1");
    expect(resolveQaBaseUrl({ devUrl: "http://dev:2" }, "http://env:3")).toBe("http://dev:2");
    expect(resolveQaBaseUrl({}, "http://env:3")).toBe("http://env:3");
    expect(resolveQaBaseUrl({ qaUrl: null, devUrl: null }, "http://env:3")).toBe("http://env:3");
    expect(resolveQaBaseUrl({}, undefined)).toBeUndefined();
  });
});

function makeQaInput(overrides: Partial<SubtaskExecutionInput> = {}): SubtaskExecutionInput {
  return {
    workspacePath: "/tmp/moagent-ws",
    command: "Run QA on the app",
    plan: {
      version: 1,
      goal: "qa",
      strategy: "dag",
      requiresApproval: false,
      maxConcurrency: 1,
      subtasks: [],
    } as ExecutionPlan,
    subtask: {
      key: "qa",
      title: "QA",
      description: "Check the app",
      kind: "qa",
      capability: "browser-testing",
      dependencies: [],
      order: 0,
    } as SubtaskExecutionInput["subtask"],
    agent: {
      _id: "agent-qa",
      name: "QA",
      role: "qa",
      capabilities: ["browser-testing"],
    } as SubtaskExecutionInput["agent"],
    priorOutputs: new Map(),
    fileChanges: [],
    signal: new AbortController().signal,
    onEvent: async () => undefined,
    onMessage: async () => undefined,
    onChunk: async () => undefined,
    saveFileChange: async () => undefined,
    ...overrides,
  };
}

describe("executeQa threading", () => {
  beforeEach(() => {
    qaSpy.calls = [];
  });

  it("passes the per-task qaBaseUrl to runResponsiveQa", async () => {
    const result = await executeSubtask(makeQaInput({ qaBaseUrl: "http://127.0.0.1:5173" }));
    expect(result.status).toBe("completed");
    expect(qaSpy.calls).toHaveLength(1);
    expect(qaSpy.calls[0].workspacePath).toBe("/tmp/moagent-ws");
    expect(qaSpy.calls[0].options.baseUrl).toBe("http://127.0.0.1:5173");
  });

  it("passes baseUrl undefined when the task has none (qa.ts fallback applies)", async () => {
    const result = await executeSubtask(makeQaInput());
    expect(result.status).toBe("completed");
    expect(qaSpy.calls).toHaveLength(1);
    expect(qaSpy.calls[0].options.baseUrl).toBeUndefined();
  });
});
