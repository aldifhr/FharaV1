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
 * Phase 3: with ORCHESTRATOR_AUTHORITATIVE on, evaluateAfterExecution
 * decisions must become real work inside the same scheduler run:
 *  - APPROVE + a matching delegation recommendation spawns a delegation
 *    subtask that actually executes, and recordDelegation points at it.
 *  - REVISE on a non-review subtask spawns a fix subtask carrying the
 *    structured findings.
 *  - REVISE on a review subtask stays with the review loop — no second,
 *    duplicate fix subtask.
 *  (The legacy record-only path behind ORCHESTRATOR_DECISION_ENGINE was
 *  deleted in plan 013 step 7: the decision engine is the only path.)
 */

const mockState = vi.hoisted(() => ({
  inputs: [] as Array<{
    key: string;
    kind: string;
    capability: string;
    description: string;
  }>,
  reviewVerdicts: [] as Array<{ verdict: string; findings: unknown[] }>,
  implementRecommendation: null as null | {
    targetCapability: string;
    reason: string;
  },
  auditFindings: [] as unknown[],
}));

vi.mock("../src/execution/agentExecutor", () => ({
  executeSubtask: async (input: {
    subtask: {
      key: string;
      kind: string;
      capability: string;
      description: string;
    };
    saveFileChange: (change: unknown) => Promise<void>;
  }) => {
    const { subtask } = input;
    mockState.inputs.push({
      key: subtask.key,
      kind: subtask.kind,
      capability: subtask.capability,
      description: subtask.description,
    });
    if (subtask.kind === "code_change") {
      const filePath = `file-${subtask.key}.txt`;
      await input.saveFileChange({
        filePath,
        changeType: "new",
        newContent: "content\n",
        diff: "",
      });
      const meta: Record<string, unknown> = { filePaths: [filePath] };
      if (subtask.key === "implement" && mockState.implementRecommendation) {
        meta.delegationRecommendation = mockState.implementRecommendation;
      }
      return { status: "completed", output: "changed", meta };
    }
    if (subtask.kind === "audit") {
      return {
        status: "completed",
        output: "audit done",
        meta: { findings: mockState.auditFindings },
      };
    }
    if (subtask.kind === "review") {
      const next = mockState.reviewVerdicts.shift() ?? {
        verdict: "approved",
        findings: [],
      };
      return {
        status: "completed",
        output: `verdict ${next.verdict}`,
        meta: next,
      };
    }
    return { status: "completed", output: "ok" };
  },
}));

import { processTask } from "@/services/taskRunner";

const BASE_POLICY: ExecutionPolicy = {
  maxSubtasks: 8,
  maxConcurrency: 2,
  maxReplans: 0,
  maxPlanningIterations: 0,
  maxReviewIterations: 2,
  subtaskTimeoutMs: 5_000,
  subtaskRetries: 0,
  approvalTimeoutMs: 60_000,
  taskTimeoutMs: 60_000,
  verificationEnabled: false,
  verificationIncludeBuild: false,
  verificationTimeoutMs: 10_000,
  maxAgentsPerTask: 3,
  maxLLMCallsPerTask: 12,
  maxDelegationDepth: 2,
  maxConcurrentLLMCalls: 1,
  maxTokenBudgetPerTask: 50_000,
  allowFallback: true,
  orchestratorAuthoritative: true,
};

const IMPLEMENTER = {
  _id: "agent-implementer",
  name: "Implementer",
  role: "frontend",
  capabilities: ["frontend-development"],
  isEnabled: true,
  priority: 0,
} as WorkerAgent;
const SECURITY = {
  _id: "agent-security",
  name: "Security",
  role: "security",
  capabilities: ["security-audit"],
  isEnabled: true,
  priority: 1,
} as WorkerAgent;
const REVIEWER = {
  _id: "agent-reviewer",
  name: "Reviewer",
  role: "reviewer",
  capabilities: ["code-review"],
  isEnabled: true,
  priority: 2,
} as WorkerAgent;

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "moagent-live-"));
  mockState.inputs = [];
  mockState.reviewVerdicts = [];
  mockState.implementRecommendation = null;
  mockState.auditFindings = [];
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

interface Captured {
  events: Array<{ type: string; payload: Record<string, unknown> }>;
  delegations: Array<Record<string, unknown>>;
  completions: Array<Record<string, unknown>>;
}

function createDeps(
  plan: ExecutionPlan,
  agents: WorkerAgent[],
  command: string,
  policy: ExecutionPolicy = BASE_POLICY
) {
  const captured: Captured = { events: [], delegations: [], completions: [] };
  const task = {
    _id: "task-1",
    projectId: "project-1",
    title: command,
    command,
    status: "running",
  };
  const project = {
    _id: "project-1",
    name: "Fixture",
    workspacePath: workspace,
    approvalMode: "auto" as const,
  };
  const subtasks: WorkerSubtask[] = plan.subtasks.map((subtask, index) => ({
    _id: `sub-${index}`,
    key: subtask.key,
    title: subtask.title,
    description: subtask.description,
    kind: subtask.kind,
    capability: subtask.capability,
    dependencies: subtask.dependencies,
    order: subtask.order,
    status: "pending",
    attempts: 0,
  })) as WorkerSubtask[];
  const changes = new Map<string, WorkerFileChange>();

  const api = {
    getContext: async () => ({
      task,
      project,
      agents,
      plan: {
        _id: "plan-1",
        taskId: task._id,
        version: 1,
        strategy: plan.strategy,
        createdBy: "orchestrator" as const,
        goal: plan.goal,
        payload: plan,
        createdAt: 0,
      },
      subtasks,
      approvalMode: "auto" as const,
    }),
    logEvent: async (input: { type: string; payload: Record<string, unknown> }) => {
      captured.events.push({ type: input.type, payload: input.payload });
    },
    startExecution: async () => "exec-1",
    updateExecution: async (input: {
      subtaskKey?: string;
      status: string;
      output?: string;
      error?: string;
    }) => {
      if (!input.subtaskKey) return;
      const subtask = subtasks.find(
        (candidate) => candidate.key === input.subtaskKey
      );
      if (!subtask) return;
      subtask.status = input.status as WorkerSubtask["status"];
      if (input.output) subtask.output = input.output;
      if (input.error) subtask.error = input.error;
    },
    updateSubtask: async (input: {
      key: string;
      status: string;
      output?: string;
      error?: string;
    }) => {
      const subtask = subtasks.find((candidate) => candidate.key === input.key);
      if (!subtask) return false;
      subtask.status = input.status as WorkerSubtask["status"];
      if (input.output) subtask.output = input.output;
      if (input.error) subtask.error = input.error;
      return true;
    },
    saveFileChange: async (change: {
      filePath: string;
      changeType: "new" | "modified" | "deleted";
      newContent?: string;
      diff: string;
    }) => {
      changes.set(change.filePath, {
        _id: `change-${changes.size + 1}`,
        taskId: task._id,
        ...change,
        diff: change.diff ?? "",
      } as WorkerFileChange);
      return `change-${changes.size}`;
    },
    markFilesApplied: async (input: { taskId: string; filePaths: string[] }) => {
      const now = Date.now();
      for (const filePath of input.filePaths) {
        const change = changes.get(filePath);
        if (change) change.appliedAt = now;
      }
    },
    getFileChanges: async () => Array.from(changes.values()),
    getApprovals: async () => [],
    recordAudit: async () => undefined,
    recordEvaluation: async () => undefined,
    recordDelegation: async (input: Record<string, unknown>) => {
      captured.delegations.push(input);
    },
    completeTask: async (input: Record<string, unknown>) => {
      captured.completions.push(input);
    },
    appendAgentMessage: async () => undefined,
    recordTokenUsage: async () => undefined,
    setPlanning: async () => undefined,
    savePlan: async () => 1,
    requestApproval: async () => "approval-1",
  };

  return {
    deps: {
      api: withApiDefaults(api) as unknown as WorkerApi,
      workerId: "test-worker",
      policy,
      workspaceRoot: workspace,
      log: () => undefined,
    },
    captured,
    task: task as unknown as WorkerTask,
  };
}

const planWith = (
  subtasks: ExecutionPlan["subtasks"],
  goal: string
): ExecutionPlan => ({
  version: 1,
  goal,
  strategy: "dag",
  requiresApproval: true,
  maxConcurrency: 1,
  subtasks,
});

describe("orchestrator live decisions (Phase 3)", () => {
  it("APPROVE spawns a real delegation subtask that executes, and recordDelegation points at the run", async () => {
    mockState.implementRecommendation = {
      targetCapability: "security-audit",
      reason: "needs a security pass",
    };
    mockState.reviewVerdicts = [{ verdict: "approved", findings: [] }];
    const plan = planWith(
      [
        {
          key: "implement",
          title: "Implement",
          description: "Write the page",
          kind: "code_change",
          capability: "frontend-development",
          dependencies: [],
          order: 0,
        },
        {
          key: "review",
          title: "Review",
          description: "Review the change",
          kind: "review",
          capability: "code-review",
          dependencies: ["implement"],
          order: 1,
        },
      ],
      "Implement the settings page"
    );
    const { deps, captured, task } = createDeps(
      plan,
      [IMPLEMENTER, SECURITY, REVIEWER],
      "Implement the settings page"
    );
    await processTask(task, deps);

    const delegateCall = mockState.inputs.find((input) =>
      input.key.startsWith("decision_delegate_")
    );
    expect(delegateCall).toBeDefined();
    expect(delegateCall?.capability).toBe("security-audit");
    expect(delegateCall?.kind).toBe("audit");

    expect(captured.delegations).toHaveLength(1);
    expect(captured.delegations[0].toAgentId).toBe("agent-security");
    expect(captured.delegations[0].capability).toBe("security-audit");

    const decision = captured.events.find(
      (event) =>
        event.type === "orchestrator.decision" &&
        event.payload.subtaskKey === "implement"
    );
    expect(decision?.payload.action).toBe("delegate");
    expect(decision?.payload.decidedBy).toBe("deterministic");
  });

  it("REVISE on a non-review subtask spawns a fix subtask carrying the structured findings", async () => {
    mockState.auditFindings = [
      {
        severity: "critical",
        filePath: "src/auth.ts",
        description: "Auth bypass via missing check",
        suggestion: "Add the missing authorization check",
      },
    ];
    const plan = planWith(
      [
        {
          key: "audit",
          title: "Audit auth",
          description: "Audit the authentication module",
          kind: "audit",
          capability: "security-audit",
          dependencies: [],
          order: 0,
        },
        {
          key: "implement",
          title: "Implement",
          description: "Apply the planned changes",
          kind: "code_change",
          capability: "frontend-development",
          dependencies: ["audit"],
          order: 1,
        },
      ],
      "Audit the authentication module"
    );
    const { deps, captured, task } = createDeps(
      plan,
      [IMPLEMENTER, SECURITY],
      "Audit the authentication module"
    );
    await processTask(task, deps);

    const fixCall = mockState.inputs.find((input) =>
      input.key.startsWith("decision_execute_")
    );
    expect(fixCall).toBeDefined();
    expect(fixCall?.kind).toBe("code_change");
    expect(fixCall?.capability).toBe("frontend-development");
    expect(fixCall?.description).toContain("Auth bypass via missing check");

    const decision = captured.events.find(
      (event) =>
        event.type === "orchestrator.decision" &&
        event.payload.subtaskKey === "audit"
    );
    expect(decision?.payload.action).toBe("execute");
  });

  it("REVISE on the review subtask stays with the review loop — exactly one fix subtask", async () => {
    mockState.reviewVerdicts = [
      {
        verdict: "changes_requested",
        findings: [
          {
            severity: "high",
            filePath: "check.txt",
            description: "Automated test finding",
            suggestion: "Apply the suggested change",
          },
        ],
      },
      { verdict: "approved", findings: [] },
    ];
    const plan = planWith(
      [
        {
          key: "implement",
          title: "Implement",
          description: "Write the file",
          kind: "code_change",
          capability: "frontend-development",
          dependencies: [],
          order: 0,
        },
        {
          key: "review",
          title: "Review",
          description: "Review the change",
          kind: "review",
          capability: "code-review",
          dependencies: ["implement"],
          order: 1,
        },
      ],
      "Write check.txt"
    );
    const { deps, task } = createDeps(
      plan,
      [IMPLEMENTER, REVIEWER],
      "Write check.txt"
    );
    await processTask(task, deps);

    const keys = mockState.inputs.map((input) => input.key);
    // The review loop's own fix subtask ran exactly once...
    expect(keys.filter((key) => key === "review_fix_1")).toHaveLength(1);
    // ...and the orchestrator spawned no fix or delegation subtask of
    // its own for the review outcome.
    expect(keys.filter((key) => key.startsWith("fix_"))).toHaveLength(0);
    expect(keys.filter((key) => key.startsWith("delegate_"))).toHaveLength(0);
    expect(keys.filter((key) => key === "review")).toHaveLength(2);
  });

  it("advisory planning flag no longer gates execution: the engine spawns work (plan 013 step 7)", async () => {
    mockState.implementRecommendation = {
      targetCapability: "security-audit",
      reason: "needs a security pass",
    };
    mockState.reviewVerdicts = [{ verdict: "approved", findings: [] }];
    const plan = planWith(
      [
        {
          key: "implement",
          title: "Implement",
          description: "Write the page",
          kind: "code_change",
          capability: "frontend-development",
          dependencies: [],
          order: 0,
        },
        {
          key: "review",
          title: "Review",
          description: "Review the change",
          kind: "review",
          capability: "code-review",
          dependencies: ["implement"],
          order: 1,
        },
      ],
      "Implement the settings page"
    );
    const legacyPolicy: ExecutionPolicy = {
      ...BASE_POLICY,
      orchestratorAuthoritative: false,
    };
    const { deps, captured, task } = createDeps(
      plan,
      [IMPLEMENTER, SECURITY, REVIEWER],
      "Implement the settings page",
      legacyPolicy
    );
    await processTask(task, deps);

    expect(
      mockState.inputs.some((input) => input.key.startsWith("decision_delegate_"))
    ).toBe(true);
    expect(captured.delegations).toHaveLength(1);
    expect(captured.delegations[0].toAgentId).toBe("agent-security");
  });
});
