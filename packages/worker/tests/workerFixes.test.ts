import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecutionPlan } from "@/orchestrator/types";
import type { ExecutionPolicy } from "@/orchestrator/policy";
import type {
  WorkerAgent,
  WorkerApi,
  WorkerFileChange,
  WorkerSubtask,
  WorkerTask,
} from "@/workerApi";
import { withApiDefaults } from "./helpers/fakeApi";

/**
 * Regression tests for the 2026-11-09 worker audit fixes:
 *  - core H1 / QA P0-1: verification runs without any QA node;
 *  - core H2: broker "ask" creates an approval (no zombie task);
 *  - core H3: review routed to the Reviewer, not the CTO;
 *  - QA policy: blocked QA is a note (no fix loop), QA_REQUIRED fails,
 *    QA fix routed to the UI owner, at most qaMaxFixIterations rounds,
 *    ask-mode QA fix requests approval instead of re-running QA.
 */

const mock = vi.hoisted(() => ({
  executed: [] as Array<{ key: string; kind: string; agentId: string; capability: string; allowedPaths?: string[] }>,
  qaVerdicts: [] as string[],
  verifyResults: [] as Array<"passed" | "failed">,
  verifyCalls: 0,
}));

vi.mock("../src/execution/agentExecutor", () => ({
  executeSubtask: async (input: {
    subtask: { key: string; kind: string; capability: string; allowedPaths?: string[] };
    agent: { _id: string };
    saveFileChange: (change: unknown) => Promise<void>;
  }) => {
    mock.executed.push({
      key: input.subtask.key,
      kind: input.subtask.kind,
      agentId: input.agent._id,
      capability: input.subtask.capability,
      allowedPaths: input.subtask.allowedPaths,
    });
    if (input.subtask.kind === "code_change") {
      const file = input.subtask.key.startsWith("fix_") ? "check.txt" : `${input.subtask.key}.txt`;
      await input.saveFileChange({
        filePath: file,
        changeType: "new",
        newContent: `${input.subtask.key}\n`,
        diff: "",
      });
      return { status: "completed", output: "changed", meta: { filePaths: [file] } };
    }
    if (input.subtask.kind === "qa") {
      const verdict = mock.qaVerdicts.shift() ?? "passed";
      const checks =
        verdict === "blocked"
          ? [{ label: "qa-environment", status: "inconclusive", details: "Chromium is not installed on the worker" }]
          : [
              { label: "application reachable", status: "passed", details: "http://127.0.0.1:9001" },
              { label: "structural check", status: verdict === "passed" ? "passed" : "failed", details: "Console errors: boom" },
            ];
      if (verdict === "failed") {
        return { status: "failed", error: "QA failed: boom", meta: { verdict, checks } };
      }
      return { status: "completed", output: `QA verdict: ${verdict}`, meta: { verdict, checks } };
    }
    if (input.subtask.kind === "review") {
      return { status: "completed", output: "Review approved.", meta: { verdict: "approved", findings: [] } };
    }
    return { status: "completed", output: "ok" };
  },
}));

vi.mock("../src/execution/verification", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/execution/verification")>();
  return {
    ...original,
    runVerification: async () => {
      mock.verifyCalls += 1;
      const result = mock.verifyResults.shift() ?? "passed";
      return {
        checks: [{ name: "tsc", status: result, details: result === "failed" ? "check.txt: type error" : undefined }],
      };
    },
  };
});

import { processTask, resumeTask } from "@/services/taskRunner";

const POLICY: ExecutionPolicy = {
  maxSubtasks: 12,
  maxConcurrency: 1,
  maxReplans: 0,
  maxReviewIterations: 2,
  subtaskTimeoutMs: 5_000,
  subtaskRetries: 0,
  approvalTimeoutMs: 60_000,
  taskTimeoutMs: 60_000,
  verificationEnabled: true,
  verificationIncludeBuild: false,
  verificationTimeoutMs: 10_000,
  maxAgentsPerTask: 5,
  maxLLMCallsPerTask: 50,
  maxDelegationDepth: 2,
  maxConcurrentLLMCalls: 1,
  maxTokenBudgetPerTask: 500_000,
  qaMode: "auto",
  qaMaxFixIterations: 1,
};

const FRONTEND = { _id: "agent-fe", name: "Frontend", role: "frontend", capabilities: ["frontend-development"], isEnabled: true, priority: 0 } as WorkerAgent;
const BACKEND = { _id: "agent-be", name: "Backend", role: "backend", capabilities: ["backend-development"], isEnabled: true, priority: 0 } as WorkerAgent;
const CTO = { _id: "agent-cto", name: "CTO", role: "cto", capabilities: ["architecture", "security-audit"], isEnabled: true, priority: 5 } as WorkerAgent;
const REVIEWER = { _id: "agent-rev", name: "Reviewer", role: "reviewer", capabilities: ["code-review"], isEnabled: true, priority: 0 } as WorkerAgent;
const QA = { _id: "agent-qa", name: "QA", role: "qa", capabilities: ["browser-testing"], isEnabled: true, priority: 0 } as WorkerAgent;

const node = (
  key: string,
  kind: ExecutionPlan["subtasks"][number]["kind"],
  capability: string,
  dependencies: string[] = [],
  extra: Partial<ExecutionPlan["subtasks"][number]> = {}
): ExecutionPlan["subtasks"][number] => ({
  key,
  title: key,
  description: `${key} work`,
  kind,
  capability,
  dependencies,
  order: 0,
  ...extra,
});

function planOf(subtasks: ExecutionPlan["subtasks"], requiresApproval = true): ExecutionPlan {
  return {
    version: 1,
    goal: "worker fixes",
    strategy: "dag",
    requiresApproval,
    maxConcurrency: 1,
    subtasks: subtasks.map((s, order) => ({ ...s, order })),
  };
}

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "moagent-fixes-"));
  mock.executed = [];
  mock.qaVerdicts = [];
  mock.verifyResults = [];
  mock.verifyCalls = 0;
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function createDeps(options: {
  plan: ExecutionPlan;
  agents: WorkerAgent[];
  approvalMode?: "ask" | "auto";
  broker?: "allow" | "ask" | "deny";
  policy?: Partial<ExecutionPolicy>;
  /** Resume scenario: task waits in needs_approval with an approved approval. */
  resumeApproved?: boolean;
  completed?: string[];
  stagedFiles?: string[];
}) {
  const approvalMode = options.approvalMode ?? "auto";
  const task = {
    _id: "task-1",
    projectId: "project-1",
    title: "fix",
    command: "fix the dashboard",
    status: options.resumeApproved ? "needs_approval" : "running",
  };
  const project = { _id: "project-1", name: "Fixture", workspacePath: workspace, approvalMode, qaUrl: "http://127.0.0.1:9001" };
  const subtasks: WorkerSubtask[] = options.plan.subtasks.map((subtask, index) => ({
    _id: `sub-${index}`,
    ...subtask,
    status: options.completed?.includes(subtask.key) ? "completed" : "pending",
    output: options.completed?.includes(subtask.key) ? "done earlier" : undefined,
    attempts: 0,
  })) as unknown as WorkerSubtask[];
  const changes = new Map<string, WorkerFileChange>();
  for (const filePath of options.stagedFiles ?? []) {
    changes.set(filePath, {
      _id: `seed-${filePath}`,
      taskId: "task-1",
      subtaskKey: options.completed?.[0],
      filePath,
      changeType: "new",
      newContent: "seeded\n",
      diff: "",
    } as unknown as WorkerFileChange);
  }
  const captured = {
    messages: [] as Array<{ agentId?: string; content: string }>,
    approvals: [] as Array<{ summary: string; subtaskKey?: string; payload: any }>,
    completions: [] as Array<{ status: string; errorMessage?: string }>,
    events: [] as Array<{ type: string; payload?: any }>,
    brokerCalls: [] as any[],
  };
  const api = {
    getContext: async () => ({
      task,
      project,
      agents: options.agents,
      plan: {
        _id: "plan-1",
        taskId: task._id,
        version: 1,
        strategy: options.plan.strategy,
        createdBy: "orchestrator" as const,
        goal: options.plan.goal,
        payload: options.plan,
        createdAt: 0,
      },
      subtasks,
      executions: [],
      approvalMode,
    }),
    logEvent: async (event: { type: string; payload?: unknown }) => {
      captured.events.push(event as { type: string; payload?: any });
    },
    startExecution: async () => "exec-1",
    updateExecution: async (input: { subtaskKey?: string; status: string; output?: string }) => {
      const subtask = subtasks.find((c) => c.key === input.subtaskKey);
      if (subtask) {
        subtask.status = input.status as WorkerSubtask["status"];
        if (input.output) subtask.output = input.output;
      }
      return { applied: true };
    },
    updateSubtask: async (input: { key: string; status: string; output?: string }) => {
      const subtask = subtasks.find((c) => c.key === input.key);
      if (!subtask) return false;
      subtask.status = input.status as WorkerSubtask["status"];
      if (input.output) subtask.output = input.output;
      return true;
    },
    saveFileChange: async (change: { filePath: string; changeType: "new"; newContent?: string; diff: string }) => {
      changes.set(change.filePath, { _id: `c-${changes.size}`, taskId: task._id, ...change } as unknown as WorkerFileChange);
      return `c-${changes.size}`;
    },
    markFilesApplied: async (input: { filePaths: string[] }) => {
      for (const filePath of input.filePaths) {
        const change = changes.get(filePath);
        if (change) change.appliedAt = Date.now();
      }
    },
    getFileChanges: async () => Array.from(changes.values()),
    getApprovals: async () =>
      options.resumeApproved
        ? [{ _id: "approval-0", kind: "apply_changes", status: "approved", payload: { filePaths: [] } }]
        : [],
    setTaskStatus: async () => undefined,
    recordAudit: async () => undefined,
    recordEvaluation: async () => undefined,
    completeTask: async (input: { status: string; errorMessage?: string }) => {
      captured.completions.push(input);
    },
    appendAgentMessage: async (input: { agentId?: string; content: string }) => {
      captured.messages.push(input);
    },
    recordTokenUsage: async () => undefined,
    setPlanning: async () => undefined,
    savePlan: async () => 1,
    requestApproval: async (input: { summary: string; subtaskKey?: string; payload: unknown }) => {
      captured.approvals.push(input as { summary: string; subtaskKey?: string; payload: any });
      return "approval-1";
    },
    checkPermission: async (input: unknown) => {
      captured.brokerCalls.push(input);
      return { decision: options.broker ?? "allow", reason: "test" };
    },
  };
  if (process.env.DEBUG_FIXES) {
    process.on("beforeExit", () => undefined);
    (captured as any).dump = () =>
      console.log(JSON.stringify({ c: captured.completions, e: captured.events.map((e) => e.type + " " + JSON.stringify(e.payload ?? {}).slice(0, 200)) }, null, 1));
  }
  return {
    deps: {
      api: withApiDefaults(api) as unknown as WorkerApi,
      workerId: "test-worker",
      policy: { ...POLICY, ...options.policy },
      workspaceRoot: workspace,
      log: () => undefined,
    },
    captured,
    task: task as unknown as WorkerTask,
  };
}

describe("core H1: verification is not gated on QA", () => {
  it("a plan with NO QA node still runs the verification fix loop before completing", async () => {
    mock.verifyResults = ["failed", "passed", "passed"];
    const { deps, captured, task } = createDeps({
      plan: planOf([node("implement", "code_change", "frontend-development")]),
      agents: [FRONTEND],
    });
    await processTask(task, deps);
    (captured as any).dump?.();
    // The verify loop (not only finalize's one-shot) ran and spawned a fix.
    expect(mock.executed.map((e) => e.key)).toEqual(["implement", "fix_verify_1"]);
    expect(mock.verifyCalls).toBeGreaterThanOrEqual(2);
    expect(captured.events.some((e) => e.type === "verification.fix_started")).toBe(true);
    expect(captured.completions.at(-1)?.status).toBe("done");
  });

  it("verification runs BEFORE QA", async () => {
    mock.verifyResults = ["passed", "passed"];
    const { deps, captured, task } = createDeps({
      plan: planOf([
        node("implement", "code_change", "frontend-development"),
        node("qa", "qa", "browser-testing", ["implement"]),
      ]),
      agents: [FRONTEND, QA],
    });
    await processTask(task, deps);
    const stages = captured.events
      .filter((e) => e.type === "task.stage")
      .map((e) => e.payload?.stage);
    expect(stages.indexOf("verifying")).toBeGreaterThan(-1);
    expect(stages.indexOf("verifying")).toBeLessThan(stages.indexOf("qa"));
    expect(captured.completions.at(-1)?.status).toBe("done");
  });
});

describe("core H2: broker ask never leaves a zombie task", () => {
  it("resumed run + broker ask (approval does not cover the files) → a new approval is requested, never a silent wait", async () => {
    const { deps, captured } = createDeps({
      plan: planOf([node("implement", "code_change", "frontend-development")]),
      agents: [FRONTEND],
      approvalMode: "ask",
      broker: "ask",
      resumeApproved: true,
      completed: ["implement"],
      stagedFiles: ["implement.txt"],
    });
    await resumeTask("task-1", deps);
    expect(captured.brokerCalls).toHaveLength(1);
    // Broker receives every target + plan version + resolved root.
    expect(captured.brokerCalls[0].targetPaths).toHaveLength(1);
    expect(captured.brokerCalls[0].planVersion).toBe(1);
    expect(captured.brokerCalls[0].workspaceRoot).toBeTruthy();
    // The ask became a real approval row the user can act on.
    expect(captured.approvals).toHaveLength(1);
    expect(captured.approvals[0].summary).toContain("Apply changes to 1 file(s)");
    // Metrics reflect reality: nothing was verified before approval.
    expect(captured.approvals[0].payload.metrics.build).toBe("not run");
    expect(captured.approvals[0].payload.metrics.tests).toBe("not run");
    expect(captured.completions).toHaveLength(0);
  });

  it("ask mode first pass: the plan approval carries honest metrics", async () => {
    const { deps, captured, task } = createDeps({
      plan: planOf([node("implement", "code_change", "frontend-development")]),
      agents: [FRONTEND],
      approvalMode: "ask",
    });
    await processTask(task, deps);
    expect(captured.approvals).toHaveLength(1);
    expect(captured.approvals[0].payload.metrics.build).toBe("not run");
    expect(captured.messages.some((m) => /prepared and verified/.test(m.content))).toBe(false);
  });
});

describe("core H3: review routing", () => {
  it("routes review to the Reviewer (code-review), never the CTO", async () => {
    const { deps, task } = createDeps({
      plan: planOf([
        node("implement", "code_change", "frontend-development"),
        node("review", "review", "code-review", ["implement"]),
      ]),
      agents: [CTO, FRONTEND, REVIEWER],
    });
    await processTask(task, deps);
    const review = mock.executed.find((e) => e.kind === "review");
    expect(review?.agentId).toBe("agent-rev");
  });

  it("falls back to the CTO only when no reviewer exists", async () => {
    const { deps, task } = createDeps({
      plan: planOf([
        node("implement", "code_change", "frontend-development"),
        node("review", "review", "code-review", ["implement"]),
      ]),
      agents: [CTO, FRONTEND],
    });
    await processTask(task, deps);
    expect(mock.executed.find((e) => e.kind === "review")?.agentId).toBe("agent-cto");
  });
});

describe("QA policy", () => {
  const qaPlan = () =>
    planOf([
      node("implement_api", "code_change", "backend-development", [], { allowedPaths: ["apps/api"] }),
      node("implement_ui", "code_change", "frontend-development", [], { allowedPaths: ["apps/web"] }),
      node("qa", "qa", "browser-testing", ["implement_api", "implement_ui"]),
    ]);

  it("blocked QA (environment) is a note: no fix loop, task completes", async () => {
    mock.qaVerdicts = ["blocked"];
    const { deps, captured, task } = createDeps({ plan: qaPlan(), agents: [FRONTEND, BACKEND, QA] });
    await processTask(task, deps);
    (captured as any).dump?.();
    expect(mock.executed.some((e) => e.key.startsWith("fix_qa"))).toBe(false);
    expect(captured.events.some((e) => e.type === "qa.blocked")).toBe(true);
    expect(captured.messages.some((m) => m.content.startsWith("QA skipped:"))).toBe(true);
    expect(captured.completions.at(-1)?.status).toBe("done");
  });

  it("blocked QA fails the task when QA is required", async () => {
    mock.qaVerdicts = ["blocked"];
    const { deps, captured, task } = createDeps({
      plan: qaPlan(),
      agents: [FRONTEND, BACKEND, QA],
      policy: { qaRequired: true },
    });
    await processTask(task, deps);
    expect(mock.executed.some((e) => e.key.startsWith("fix_qa"))).toBe(false);
    expect(captured.completions.at(-1)?.status).toBe("failed");
  });

  it("a QA failure is fixed by the UI owner, scoped to its allowedPaths, at most 1 round", async () => {
    mock.qaVerdicts = ["failed", "failed", "failed"];
    const { deps, captured, task } = createDeps({ plan: qaPlan(), agents: [FRONTEND, BACKEND, QA] });
    await processTask(task, deps);
    (captured as any).dump?.();
    const fixes = mock.executed.filter((e) => e.key.startsWith("fix_qa"));
    expect(fixes).toHaveLength(1);
    expect(fixes[0].capability).toBe("frontend-development");
    expect(fixes[0].agentId).toBe("agent-fe");
    expect(fixes[0].allowedPaths).toEqual(["apps/web"]);
    expect(mock.executed.filter((e) => e.kind === "qa")).toHaveLength(2);
    expect(captured.completions.at(-1)?.status).toBe("failed");
  });

  it("ask mode: a QA fix requests approval instead of re-running QA on unfixed code", async () => {
    mock.qaVerdicts = ["failed", "passed"];
    // Resumed after the user approved the main diff: apply → verify → QA.
    const { deps, captured } = createDeps({
      plan: planOf([
        node("implement", "code_change", "frontend-development"),
        node("qa", "qa", "browser-testing", ["implement"]),
      ]),
      agents: [FRONTEND, QA],
      approvalMode: "ask",
      broker: "allow",
      resumeApproved: true,
      completed: ["implement"],
      stagedFiles: ["implement.txt"],
    });
    await resumeTask("task-1", deps);
    // QA ran once on the applied code; the fix was prepared but NOT
    // silently applied, and QA did not re-run on the unfixed workspace.
    expect(mock.executed.filter((e) => e.kind === "qa")).toHaveLength(1);
    expect(mock.executed.some((e) => e.key === "fix_qa_1")).toBe(true);
    expect(captured.approvals).toHaveLength(1);
    expect(captured.approvals[0].summary).toMatch(/^Apply QA fix/);
    expect(captured.approvals[0].subtaskKey).toBe("fix_qa_1");
    // The approval covers every staged file the resumed run will apply.
    expect(captured.approvals[0].payload.filePaths.sort()).toEqual(["check.txt", "implement.txt"]);
    await expect(fs.access(path.join(workspace, "check.txt"))).rejects.toThrow();
    expect(captured.completions).toHaveLength(0);
  });

  it("the QA pass message does not overclaim", async () => {
    mock.qaVerdicts = ["passed"];
    const { deps, captured, task } = createDeps({
      plan: planOf([
        node("implement", "code_change", "frontend-development"),
        node("qa", "qa", "browser-testing", ["implement"]),
      ]),
      agents: [FRONTEND, QA],
    });
    await processTask(task, deps);
    const pass = captured.messages.find((m) => m.agentId === "agent-qa" && m.content.startsWith("QA checks passed"));
    expect(pass).toBeDefined();
    expect(pass!.content).not.toMatch(/assertions/i);
    expect(captured.events.find((e) => e.type === "qa.passed")).toBeDefined();
  });
});
