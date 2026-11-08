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
  next: null as {
    verdict: "passed" | "failed" | "inconclusive";
    checks: Array<{ label: string; status: "passed" | "failed" | "inconclusive"; details?: string }>;
    failures: string[];
    inconclusive: string[];
  } | null,
}));

vi.mock("../src/execution/qa", () => ({
  runResponsiveQa: async (workspacePath: string, options: Record<string, unknown>) => {
    qaSpy.calls.push({ workspacePath, options });
    return qaSpy.next ?? { verdict: "passed", checks: [], failures: [], inconclusive: [] };
  },
  checkLabelFor: (viewportLabel: string, visualRegression: boolean) =>
    visualRegression ? `${viewportLabel} viewport` : "structural check",
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

  it("returns failed (not completed) on an inconclusive verdict, preserving it in meta", async () => {
    qaSpy.next = {
      verdict: "inconclusive",
      checks: [
        { label: "application reachable", status: "passed" },
        { label: "structural check", status: "inconclusive", details: "baseline missing" },
      ],
      failures: [],
      inconclusive: ["structural check"],
    };
    const result = await executeSubtask(makeQaInput({ qaBaseUrl: "http://127.0.0.1:3000" }));
    expect(result.status).toBe("failed");
    expect(result.meta).toMatchObject({ verdict: "inconclusive" });
  });

  it("structural runs carry no viewport/responsive/screenshot claims in output", async () => {
    qaSpy.next = {
      verdict: "passed",
      checks: [
        { label: "application reachable", status: "passed" },
        { label: "structural check", status: "passed" },
      ],
      failures: [],
      inconclusive: [],
    };
    const announced: string[] = [];
    const input = makeQaInput({
      plan: {
        version: 1,
        goal: "qa",
        strategy: "dag",
        requiresApproval: false,
        maxConcurrency: 1,
        visualQa: false,
        subtasks: [],
      } as unknown as ExecutionPlan,
      onMessage: async (content: string) => {
        announced.push(content);
      },
    });
    const result = await executeSubtask(input);
    expect(result.status).toBe("completed");
    expect(qaSpy.calls).toHaveLength(1);
    expect(qaSpy.calls[0].options.visualRegression).toBe(false);
    expect(announced.join("\n")).toContain("structural");
    expect(announced.join("\n")).not.toMatch(/desktop|tablet|mobile|responsive|screenshot/i);
  });

  it("checkLabelFor never emits viewport claims in structural mode", async () => {
    const { checkLabelFor } = await import("../src/execution/qa");
    expect(checkLabelFor("desktop", true)).toBe("desktop viewport");
    expect(checkLabelFor("mobile", true)).toBe("mobile viewport");
    expect(checkLabelFor("structural", false)).toBe("structural check");
    expect(checkLabelFor("desktop", false)).not.toMatch(/viewport|desktop|mobile|tablet|responsive/i);
  });
});
