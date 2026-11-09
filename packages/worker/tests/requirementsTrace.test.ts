import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecutionPlan } from "@/orchestrator/types";
import type { WorkerAgent, WorkerApi, WorkerSubtask, WorkerTask } from "@/workerApi";
import {
  computeRequirementCoverage,
  coverageBlocksDone,
  coverageGapNote,
  extractRequirementsFallback,
  linkSubtasksToRequirements,
  normalizeLlmRequirements,
  type Requirement,
} from "@/api/convex/lib/requirements";
import { withRequirements } from "@/orchestrator/planner";
import { buildPlanningPrompt } from "@/orchestrator/planner";
import { withApiDefaults } from "./helpers/fakeApi";
import { testPolicy } from "./helpers/policy";

/**
 * Plan 025: intent-to-execution traceability. Requirements come from the
 * request (LLM with a deterministic fallback), subtasks map to them, and a
 * deterministic coverage check keeps a task with an uncovered requirement
 * from being "done".
 */

vi.mock("../src/execution/agentExecutor", () => ({
  executeSubtask: async (input: { subtask: { key: string; kind: string }; saveFileChange: (change: unknown) => Promise<void> }) => {
    const key = input.subtask.key;
    if (input.subtask.kind === "code_change") {
      await input.saveFileChange({ filePath: `src/${key}.ts`, changeType: "new", newContent: "export {};\n", diff: "" });
      return { status: "completed", output: `output-${key}`, meta: { filePaths: [`src/${key}.ts`] } };
    }
    return { status: "completed", output: `output-${key}` };
  },
}));

import { processTask } from "@/services/taskRunner";

const AUTH_REQUEST = "Implement auth: login, register, logout, dan refresh token";

describe("requirement extraction fallback", () => {
  it("splits a list with an Indonesian conjunction into one requirement per item, with source spans", () => {
    const requirements = extractRequirementsFallback(AUTH_REQUEST);
    expect(requirements.map((r) => r.text)).toEqual(["login", "register", "logout", "refresh token"]);
    expect(requirements.map((r) => r.id)).toEqual(["r1", "r2", "r3", "r4"]);
    for (const requirement of requirements) {
      expect(requirement.source).toBe("fallback");
      expect(AUTH_REQUEST.slice(requirement.span!.start, requirement.span!.end)).toBe(requirement.text);
    }
  });

  it("reads bullet lists and keeps a plain request as one requirement", () => {
    expect(extractRequirementsFallback("Please:\n- add dark mode\n- update README\n- add tests").map((r) => r.text)).toEqual([
      "add dark mode",
      "update README",
      "add tests",
    ]);
    expect(extractRequirementsFallback("Fix the bug in checkout.").map((r) => r.text)).toEqual(["Fix the bug in checkout"]);
    // "A and B" is split only when both sides are actions.
    expect(extractRequirementsFallback("Add a search and filter bar")).toHaveLength(1);
    expect(extractRequirementsFallback("Add a login page and fix the header").map((r) => r.text)).toEqual([
      "Add a login page",
      "fix the header",
    ]);
    expect(extractRequirementsFallback("   ")).toEqual([]);
  });

  it("normalizes the planner's requirements and translates its ids", () => {
    const normalized = normalizeLlmRequirements(
      [
        { id: "A", text: "User can log in", quote: "login" },
        { id: "B", text: "Refresh token rotation", quote: "refresh token" },
      ],
      AUTH_REQUEST
    );
    expect(normalized?.requirements.map((r) => [r.id, r.source])).toEqual([["r1", "llm"], ["r2", "llm"]]);
    expect(normalized?.requirements[1].span).toEqual({ start: AUTH_REQUEST.indexOf("refresh token"), end: AUTH_REQUEST.length });
    expect(normalized?.idMap.get("b")).toBe("r2");
    expect(normalizeLlmRequirements([], AUTH_REQUEST)).toBeNull();
    expect(normalizeLlmRequirements("nope", AUTH_REQUEST)).toBeNull();
  });
});

const authPlan = (withRefresh: boolean): ExecutionPlan => ({
  version: 1,
  goal: "Auth",
  strategy: "dag",
  requiresApproval: false,
  maxConcurrency: 1,
  subtasks: [
    { key: "login", title: "Login endpoint", description: "Implement login", kind: "code_change", capability: "frontend-development", dependencies: [], order: 0 },
    { key: "register", title: "Register endpoint", description: "Implement registration", kind: "code_change", capability: "frontend-development", dependencies: [], order: 1 },
    { key: "logout", title: "Logout endpoint", description: "Implement logout", kind: "code_change", capability: "frontend-development", dependencies: [], order: 2 },
    ...(withRefresh
      ? [{ key: "refresh", title: "Refresh token", description: "Issue and rotate refresh tokens", kind: "code_change" as const, capability: "frontend-development", dependencies: [], order: 3 }]
      : []),
  ],
});

describe("subtask → requirement mapping", () => {
  it("keeps declared ids, links by name, and leaves an unnamed requirement unmapped", () => {
    const requirements = extractRequirementsFallback(AUTH_REQUEST);
    const linked = linkSubtasksToRequirements(authPlan(false).subtasks, requirements);
    expect(linked.map((s) => s.requirementIds)).toEqual([["r1"], ["r2"], ["r3"]]);
    expect(linked.flatMap((s) => s.requirementIds)).not.toContain("r4");
  });

  it("maps every subtask to a single requirement", () => {
    const requirements = extractRequirementsFallback("Fix the checkout bug");
    const linked = linkSubtasksToRequirements(authPlan(false).subtasks, requirements);
    expect(linked.every((s) => s.requirementIds.join() === "r1")).toBe(true);
  });

  it("withRequirements uses the planner's requirements, else the fallback, and fixed ids on replan", () => {
    const parsed = {
      requirements: [{ id: "r1", text: "login", quote: "login" }, { id: "r2", text: "refresh token", quote: "refresh token" }],
    };
    const llm = withRequirements({ ...authPlan(false), subtasks: authPlan(false).subtasks.map((s) => ({ ...s, requirementIds: s.key === "login" ? ["r1"] : ["zzz"] })) }, { command: AUTH_REQUEST }, parsed);
    expect(llm.requirements?.map((r) => r.text)).toEqual(["login", "refresh token"]);
    expect(llm.subtasks[0].requirementIds).toEqual(["r1"]);
    expect(llm.subtasks[1].requirementIds).toEqual([]);

    const fallback = withRequirements(authPlan(false), { command: `${AUTH_REQUEST}\n\n[attached file contents]`, request: AUTH_REQUEST }, null);
    expect(fallback.requirements?.map((r) => r.id)).toEqual(["r1", "r2", "r3", "r4"]);

    const fixed: Requirement[] = [{ id: "r1", text: "refresh token", source: "fallback" }];
    expect(withRequirements(authPlan(true), { command: AUTH_REQUEST, requirements: fixed }, parsed).requirements).toEqual(fixed);
  });

  it("the planning prompt asks for requirements, or lists the fixed ones on a replan", () => {
    const base = {
      command: AUTH_REQUEST,
      classification: { kind: "code_change" as const, strategy: "single" as const, reasons: [], suggestedCapabilities: [] },
      agents: [],
      policy: testPolicy({}),
    };
    expect(buildPlanningPrompt(base)).toContain("REQUIREMENTS: first list every distinct thing");
    const replan = buildPlanningPrompt({ ...base, requirements: [{ id: "r4", text: "refresh token", source: "fallback" }] });
    expect(replan).toContain('r4 "refresh token"');
    expect(replan).not.toContain("REQUIREMENTS: first list");
  });
});

describe("coverage check", () => {
  const requirements = extractRequirementsFallback(AUTH_REQUEST);
  const done = (plan: ExecutionPlan, overrides: Record<string, Record<string, unknown>> = {}) =>
    plan.subtasks.map((s) => ({ ...s, status: "completed", acceptanceStatus: "accepted", ...(overrides[s.key] ?? {}) }));
  const files = (plan: ExecutionPlan) => Object.fromEntries(plan.subtasks.map((s) => [s.key, [`src/${s.key}.ts`]]));

  it("the auth example without a refresh-token subtask: r4 is uncovered and the task cannot be done", () => {
    const plan = authPlan(false);
    const report = computeRequirementCoverage({ requirements, subtasks: done(plan), filesBySubtask: files(plan) });
    expect(report.covered).toEqual(["r1", "r2", "r3"]);
    expect(report.uncovered).toEqual(["r4"]);
    expect(report.complete).toBe(false);
    expect(coverageBlocksDone(report)).toBe(true);
    expect(coverageGapNote(report)).toContain('r4 "refresh token" (uncovered');
  });

  it("covered once a subtask serves every requirement with passing evidence", () => {
    const plan = authPlan(true);
    const report = computeRequirementCoverage({ requirements, subtasks: done(plan), filesBySubtask: files(plan) });
    expect(report.complete).toBe(true);
    expect(coverageBlocksDone(report)).toBe(false);
  });

  it("missing evidence: no passing evidence, a failed gate, a rejected acceptance or an unfinished subtask", () => {
    const plan = authPlan(true);
    const noEvidence = computeRequirementCoverage({ requirements, subtasks: done(plan) });
    expect(noEvidence.missingEvidence).toEqual(["r1", "r2", "r3", "r4"]);
    expect(coverageBlocksDone(noEvidence)).toBe(true);

    const gates = computeRequirementCoverage({
      requirements,
      subtasks: done(plan, {
        login: { gateResults: [{ gateId: "tests", status: "pass", evidence: { kind: "verification", summary: "ok" } }] },
        register: { gateResults: [{ gateId: "tests", status: "fail", evidence: { kind: "verification", summary: "2 failing" } }] },
        logout: { acceptanceStatus: "rejected" },
        refresh: { status: "failed" },
      }),
    });
    const state = Object.fromEntries(gates.requirements.map((entry) => [entry.requirement.id, entry.state]));
    expect(state).toEqual({ r1: "covered", r2: "missing_evidence", r3: "missing_evidence", r4: "missing_evidence" });
    expect(gates.requirements[3].reason).toContain("refresh is failed");
  });

  it("a single-requirement request with only missing evidence is left to the existing gates", () => {
    const single = extractRequirementsFallback("Fix the checkout bug");
    const report = computeRequirementCoverage({ requirements: single, subtasks: done(authPlan(false)) });
    expect(report.missingEvidence).toEqual(["r1"]);
    expect(coverageBlocksDone(report)).toBe(false);
  });

  it("runner-added nodes carry no requirement of their own", () => {
    const plan = authPlan(true);
    const subtasks = [...done(plan), { key: "fix_qa_1", title: "Fix refresh token", kind: "code_change", status: "failed", origin: "fix" }];
    const report = computeRequirementCoverage({ requirements, subtasks, filesBySubtask: files(plan) });
    expect(report.complete).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// processTask: the coverage check is the last gate before "done"
// ---------------------------------------------------------------------------

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
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "moagent-trace-"));
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function createDeps(plan: ExecutionPlan) {
  const captured = {
    completions: [] as Array<Record<string, unknown>>,
    events: [] as Array<{ type: string; payload?: Record<string, unknown> }>,
    coverage: [] as Array<Record<string, unknown>>,
  };
  const task = { _id: "task-1", projectId: "project-1", title: "Auth", command: AUTH_REQUEST, status: "running" };
  const project = { _id: "project-1", name: "Fixture", workspacePath: workspace, approvalMode: "auto" as const };
  const subtasks = plan.subtasks.map((subtask, index) => ({
    _id: `sub-${index}`,
    ...subtask,
    status: "pending",
    attempts: 0,
  })) as unknown as WorkerSubtask[];
  const changes = new Map<string, Record<string, unknown>>();
  const api = {
    getContext: async () => ({
      task,
      project,
      agents: [IMPLEMENTER],
      plan: { _id: "plan-1", taskId: task._id, version: 1, strategy: plan.strategy, createdBy: "orchestrator" as const, goal: plan.goal, payload: plan, createdAt: 0 },
      subtasks,
      approvalMode: "auto" as const,
    }),
    logEvent: async (input: { type: string; payload?: Record<string, unknown> }) => {
      captured.events.push(input);
    },
    startExecution: async () => "exec-1",
    updateExecution: async (input: { subtaskKey?: string; status: string; output?: string }) => {
      const subtask = subtasks.find((c) => c.key === input.subtaskKey);
      if (subtask) subtask.status = input.status as WorkerSubtask["status"];
    },
    updateSubtask: async (input: { key: string; status: string }) => {
      const subtask = subtasks.find((c) => c.key === input.key);
      if (subtask) subtask.status = input.status as WorkerSubtask["status"];
      return Boolean(subtask);
    },
    saveFileChange: async (change: { filePath: string; subtaskKey?: string }) => {
      changes.set(change.filePath, { _id: `change-${changes.size + 1}`, ...change });
      return `change-${changes.size}`;
    },
    markFilesApplied: async (input: { filePaths: string[] }) => {
      for (const filePath of input.filePaths) {
        const change = changes.get(filePath);
        if (change) change.appliedAt = Date.now();
      }
    },
    getFileChanges: async () => Array.from(changes.values()),
    getApprovals: async () => [],
    recordAudit: async () => undefined,
    recordEvaluation: async () => undefined,
    recordDelegation: async () => undefined,
    recordLifecycle: async () => undefined,
    completeTask: async (input: Record<string, unknown>) => {
      captured.completions.push(input);
    },
    appendAgentMessage: async () => undefined,
    recordTokenUsage: async () => undefined,
    getTaskTokenUsage: async () => ({ calls: 0, inputTokens: 0, outputTokens: 0 }),
    getTaskContext: async () => null,
    upsertTaskContext: async () => undefined,
    saveDynamicSubtasks: async () => undefined,
    setPlanning: async () => undefined,
    savePlan: async () => 1,
    requestApproval: async () => "approval-1",
    recordRequirementCoverage: async (input: Record<string, unknown>) => {
      captured.coverage.push(input);
      return { applied: true };
    },
  };
  return {
    deps: {
      api: withApiDefaults(api) as unknown as WorkerApi,
      workerId: "test-worker",
      policy: testPolicy({
        maxConcurrency: 1,
        maxReplans: 0,
        maxPlanningIterations: 0,
        maxConcurrentLLMCalls: 1,
        allowFallback: true,
        orchestratorAuthoritative: true,
        decisionLlmMode: "off",
        reviewMode: "never",
        qaMode: "never",
      }),
      workspaceRoot: workspace,
      log: () => undefined,
    },
    captured,
    task: task as unknown as WorkerTask,
  };
}

describe("processTask coverage gate (plan 025)", () => {
  const requirements = extractRequirementsFallback(AUTH_REQUEST);

  it("auth example: refresh token has no subtask → the task is not done, it ends completed with gaps", async () => {
    const { deps, captured, task } = createDeps({ ...authPlan(false), requirements });
    await processTask(task, deps);

    const coverageEvent = captured.events.find((event) => event.type === "requirements.coverage");
    expect(coverageEvent?.payload?.uncovered).toEqual(["r4"]);
    expect(coverageEvent?.payload?.blocksDone).toBe(true);
    expect(captured.coverage.at(-1)).toMatchObject({ outcome: "completed_with_gaps", uncovered: ["r4"] });

    expect(captured.completions.some((completion) => completion.status === "done")).toBe(false);
    const last = captured.completions.at(-1);
    expect(last?.status).toBe("failed");
    expect(String(last?.errorMessage)).toContain("Completed with gaps");
    expect(String(last?.errorMessage)).toContain('r4 "refresh token"');
  });

  it("every requirement served with evidence → done", async () => {
    const { deps, captured, task } = createDeps({ ...authPlan(true), requirements });
    await processTask(task, deps);
    expect(captured.coverage.at(-1)).toMatchObject({ outcome: "covered", uncovered: [], missingEvidence: [] });
    expect(captured.completions.at(-1)?.status).toBe("done");
  });

  it("a plan without requirements (pre-023) is not gated", async () => {
    const { deps, captured, task } = createDeps(authPlan(false));
    await processTask(task, deps);
    expect(captured.events.some((event) => event.type === "requirements.coverage")).toBe(false);
    expect(captured.completions.at(-1)?.status).toBe("done");
  });
});
