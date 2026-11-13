import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecutionPolicy } from "@/orchestrator/policy";
import type { WorkerAgent } from "@/workerApi";
import { createFakeApi, createRunnerDeps, testPolicy, testTask } from "./helpers";

/**
 * Exec-pipeline: executePlan as a phase pipeline.
 *
 *  - with an isolated task worktree the order is review → verify → QA →
 *    approval → land; the approval is requested only after verify, QA and
 *    review passed on the FINAL snapshot, and nothing touches the user's
 *    checkout before it;
 *  - every verify / QA fix is re-reviewed (new snapshot id), a rejection
 *    loops through the fix owner within the review budget;
 *  - a cancel in any phase ends cancelled; without a worktree the legacy
 *    order (approval before verification) stays.
 */

type Step = { files?: string[]; outcome: Record<string, unknown> };

const scenario = vi.hoisted(() => ({
  steps: {} as Record<string, Step[]>,
  byKind: {} as Record<string, Step>,
  attempts: new Map<string, number>(),
  ranBy: {} as Record<string, string>,
  order: [] as string[],
  verifications: [] as Array<Array<Record<string, unknown>>>,
  verifyCalls: 0,
  /** Abort the task while this node / stage runs ("verify" = the verifier). */
  abortAt: null as string | null,
  abort: null as AbortController | null,
  content: 0,
}));

vi.mock("../src/execution/agentExecutor", () => ({
  executeSubtask: async (input: {
    subtask: { key: string; kind: string };
    agent?: { name?: string };
    workspacePath: string;
    saveFileChange: (change: unknown) => Promise<void>;
  }) => {
    const key = input.subtask.key;
    const attempt = scenario.attempts.get(key) ?? 0;
    scenario.attempts.set(key, attempt + 1);
    scenario.ranBy[key] = input.agent?.name ?? "?";
    scenario.order.push(`run:${key}`);
    if (scenario.abortAt === key) scenario.abort?.abort(new Error("Cancelled by user"));
    const list = scenario.steps[key];
    const step = list ? list[Math.min(attempt, list.length - 1)] : scenario.byKind[input.subtask.kind] ?? { outcome: { status: "completed", output: `output-${key}` } };
    for (const file of step.files ?? []) {
      // Every write is new content, so every fix makes a new snapshot. A
      // later write edits what is on disk by then (like the real executor).
      scenario.content += 1;
      // Like computeDiff: the old side is what is on disk (staged-only edits are rebuilt on).
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const previous = await readFile(join(input.workspacePath, file), "utf8").catch(() => undefined);
      const newContent = `content ${scenario.content}\n`;
      const { createHash } = await import("node:crypto");
      const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
      await input.saveFileChange(
        previous === undefined
          ? { filePath: file, changeType: "new", newContent, oldContentHash: hash(""), newContentHash: hash(newContent), diff: "" }
          : { filePath: file, changeType: "modified", oldContent: previous, newContent, oldContentHash: hash(previous), newContentHash: hash(newContent), diff: "" }
      );
    }
    const outcome = { ...step.outcome } as Record<string, unknown>;
    if (step.files && step.files.length > 0) outcome.meta = { filePaths: step.files, ...((outcome.meta as object) ?? {}) };
    return outcome;
  },
}));

vi.mock("../src/execution/verification", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/execution/verification")>();
  return {
    ...orig,
    runVerification: async (args: { onCheck?: (check: unknown) => Promise<void> }) => {
      scenario.order.push("verify");
      if (scenario.abortAt === "verify") scenario.abort?.abort(new Error("Cancelled by user"));
      const index = Math.min(scenario.verifyCalls++, Math.max(0, scenario.verifications.length - 1));
      const checks = JSON.parse(JSON.stringify(scenario.verifications[index] ?? [{ name: "typecheck", status: "passed" }]));
      for (const check of checks) await args.onCheck?.(check);
      return { checks, ran: checks.map((check: { name: string }) => check.name), skipped: [] };
    },
  };
});

vi.mock("../src/tools/gitWorktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/gitWorktree")>()),
  commitWorktree: async () => {
    scenario.order.push("commit");
    return true;
  },
  describeCommit: async () => ({ sha: "abc", message: "m", filesChanged: 1, additions: 1, deletions: 0, ahead: 1, behind: 0, comparedTo: "main" }),
}));

import { executePlan } from "@/services/runner/executePlan";
import type { RunState } from "@/services/runner/types";

const agent = (id: string, name: string, role: string, capabilities: string[]) =>
  ({ _id: id, name, role, capabilities, isEnabled: true, priority: 0 }) as WorkerAgent;
const FRONTEND = agent("agent-frontend", "Frontend", "frontend", ["frontend-development"]);
const BACKEND = agent("agent-backend", "Backend", "backend", ["backend-development"]);
const REVIEWER = agent("agent-reviewer", "Reviewer", "reviewer", ["code-review"]);
const QA = agent("agent-qa", "QA", "qa", ["browser-testing"]);
const AGENTS = [FRONTEND, BACKEND, REVIEWER, QA];

const node = (key: string, kind: string, capability: string, dependencies: string[] = [], order = 0) => ({
  key,
  title: key,
  description: `Do ${key}`,
  kind,
  capability,
  dependencies,
  order,
});
const done = (output: string, meta?: Record<string, unknown>) => ({ status: "completed", output, ...(meta ? { meta } : {}) });
const APPROVE: Step = { outcome: done("approved", { verdict: "approved", findings: [] }) };
const REJECT: Step = {
  outcome: done("changes requested", { verdict: "changes_requested", findings: [{ severity: "high", filePath: "api/server.ts", description: "Validate the input" }] }),
};
const QA_FAILED: Step = { outcome: done("QA verdict: failed", { verdict: "failed", checks: [{ label: "button renders", status: "failed", details: "button missing" }] }) };
const QA_PASSED: Step = { outcome: done("QA verdict: passed", { verdict: "passed", checks: [{ label: "button renders", status: "passed" }] }) };

const fullPlan = () => ({
  version: 1,
  goal: "Implement the feature",
  strategy: "dag" as const,
  requiresApproval: false,
  maxConcurrency: 1,
  subtasks: [
    { ...node("api", "code_change", "backend-development"), allowedPaths: ["api/"] },
    node("review", "review", "code-review", ["api"], 1),
    node("qa", "qa", "browser-testing", ["review"], 2),
  ],
});

const emptyState = (): RunState => ({
  priorOutputs: new Map(),
  qaVerdicts: {},
  reviewVerdicts: {},
  fileChanges: new Map(),
  appliedFilesBySubtask: new Map(),
  feedback: [],
});

let root: string;
let checkout: string;
let worktree: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-execp-"));
  checkout = path.join(root, "checkout");
  worktree = path.join(root, "worktree");
  await fs.mkdir(checkout, { recursive: true });
  await fs.mkdir(worktree, { recursive: true });
  scenario.steps = {};
  scenario.byKind = { code_change: { files: ["api/server.ts"], outcome: done("fixed") } };
  scenario.attempts = new Map();
  scenario.ranBy = {};
  scenario.order = [];
  scenario.verifications = [];
  scenario.verifyCalls = 0;
  scenario.abortAt = null;
  scenario.abort = null;
  scenario.content = 0;
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

interface RunOptions {
  isolated?: boolean;
  approvalResolved?: boolean;
  policy?: Partial<ExecutionPolicy>;
  state?: RunState;
  completedKeys?: string[];
  plan?: ReturnType<typeof fullPlan>;
}

async function run(options: RunOptions = {}) {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const approvals: Array<Record<string, unknown>> = [];
  const merges: unknown[] = [];
  const project = { _id: "project-1", name: "Fixture", workspacePath: checkout, approvalMode: "ask" as const, mainBranch: "main" };
  const task = testTask({ command: "Implement the feature" });
  const { api } = createFakeApi({
    getContext: async () => ({ task, project, agents: AGENTS, subtasks: [], approvalMode: "ask" as const }),
    logEvent: async (input: { type: string; payload?: Record<string, unknown> }) => {
      events.push({ type: input.type, payload: input.payload });
      if (input.type === "task.stage") scenario.order.push(`stage:${String(input.payload?.stage)}`);
      if (input.type === "review.rereview") scenario.order.push("rereview");
    },
    requestApproval: async (input: Record<string, unknown>) => {
      approvals.push(input);
      scenario.order.push("approval");
      return "approval-1";
    },
    checkPermission: async () => ({ decision: options.approvalResolved ? "allow" : "ask", reason: "test" }),
    mergeBranch: async (input: unknown) => {
      merges.push(input);
      scenario.order.push("merge");
    },
    recordTaskCommit: async () => undefined,
    postCard: async () => undefined,
  });
  const policy = testPolicy({
    maxConcurrency: 1,
    maxConcurrentLLMCalls: 1,
    maxReviewIterations: 2,
    qaMaxFixIterations: 1,
    verificationEnabled: true,
    allowFallback: true,
    orchestratorAuthoritative: false,
    decisionLlmMode: "off",
    ...options.policy,
  } as Partial<ExecutionPolicy>);
  const abort = new AbortController();
  scenario.abort = abort;
  const deps = createRunnerDeps({ api, policy, workspaceRoot: root });
  const state = options.state ?? emptyState();
  const result = await executePlan({
    deps,
    task,
    project: project as never,
    workspacePath: options.isolated === false ? checkout : worktree,
    agents: AGENTS as never,
    plan: (options.plan ?? fullPlan()) as never,
    state,
    approvalMode: "ask",
    approvalResolved: options.approvalResolved,
    completedKeys: new Set(options.completedKeys ?? []),
    taskAbort: abort,
    ...(options.isolated === false ? {} : { worktree: { branchName: "fhara/task-1", worktreePath: worktree } }),
  });
  return { result, events, approvals, merges, state };
}

const exists = (file: string) => fs.access(file).then(() => true, () => false);

describe("verified_first order (isolated worktree)", () => {
  it("requests approval only after review, verify and QA passed on the final snapshot; the checkout stays untouched", async () => {
    scenario.steps = { api: [{ files: ["api/server.ts"], outcome: done("did api") }], review: [APPROVE], qa: [QA_PASSED] };
    const { result, approvals, events, state } = await run();
    expect(result.status).toBe("waiting_approval");
    const order = scenario.order.filter((entry) => !entry.startsWith("stage:waiting"));
    const at = (entry: string) => order.indexOf(entry);
    expect(at("run:review")).toBeGreaterThan(at("run:api"));
    expect(at("verify")).toBeGreaterThan(at("run:review"));
    expect(at("run:qa")).toBeGreaterThan(at("verify"));
    expect(at("approval")).toBeGreaterThan(at("run:qa"));
    expect(order).not.toContain("merge");
    expect(approvals).toHaveLength(1);
    const payload = approvals[0].payload as Record<string, any>;
    expect(payload.stageOrder).toBe("verified_first");
    expect(payload.metrics).toMatchObject({ review: "approved", build: "passed", tests: "passed", qa: "passed" });
    // The approved snapshot is the final one, and its latest review verdict is approve.
    expect(state.reviewBySnapshot?.[payload.reviewSnapshotId]).toBe("approved");
    expect(events.find((event) => event.type === "task.stage_order")?.payload).toEqual({ order: "verified_first", reason: "isolated_worktree" });
    // Staged into the worktree for verify / QA; nothing in the user's checkout before approval.
    expect(await exists(path.join(worktree, "api/server.ts"))).toBe(true);
    expect(await exists(path.join(checkout, "api/server.ts"))).toBe(false);
  });

  it("a QA fix is re-reviewed under a new snapshot id before QA re-runs, with no per-fix approval", async () => {
    scenario.steps = { api: [{ files: ["api/server.ts"], outcome: done("did api") }], review: [APPROVE], qa: [QA_FAILED, QA_PASSED] };
    const { result, approvals, events, state } = await run();
    expect(result.status).toBe("waiting_approval");
    const reReviews = events.filter((event) => event.type === "review.rereview");
    expect(reReviews).toHaveLength(1);
    expect(reReviews[0].payload).toMatchObject({ stage: "QA", fixKey: "fix_qa_1" });
    const snapshots = Object.keys(state.reviewBySnapshot ?? {});
    expect(snapshots).toHaveLength(2);
    expect(snapshots).toContain(reReviews[0].payload?.snapshotId);
    expect(scenario.attempts.get("review")).toBe(2);
    const order = scenario.order;
    expect(order.indexOf("rereview")).toBeGreaterThan(order.indexOf("run:fix_qa_1"));
    expect(order.lastIndexOf("run:review")).toBeLessThan(order.lastIndexOf("run:qa"));
    // QA fix changed the content after verification: verification re-runs before approval.
    expect(scenario.verifyCalls).toBe(2);
    expect(approvals).toHaveLength(1);
    expect((approvals[0].payload as Record<string, any>).reviewSnapshotId).toBe(reReviews[0].payload?.snapshotId);
  });

  it("a review reject after a QA fix loops through the fix owner, then approval is requested", async () => {
    scenario.steps = {
      api: [{ files: ["api/server.ts"], outcome: done("did api") }],
      review: [APPROVE, REJECT, APPROVE],
      qa: [QA_FAILED, QA_PASSED],
    };
    const { result, approvals, state } = await run();
    expect(result.status).toBe("waiting_approval");
    // decideFixOwner: the writer of api/server.ts (Backend) owns the review fix.
    expect(scenario.ranBy.review_fix_1).toBe("Backend");
    expect(scenario.attempts.get("review")).toBe(3);
    const verdicts = Object.values(state.reviewBySnapshot ?? {});
    expect(verdicts).toContain("changes_requested");
    expect(approvals).toHaveLength(1);
    const snapshot = (approvals[0].payload as Record<string, any>).reviewSnapshotId;
    expect(state.reviewBySnapshot?.[snapshot]).toBe("approved");
  });

  it("an exhausted review budget during re-review ends cleanly as failed (review_rejected), never asking", async () => {
    scenario.steps = {
      api: [{ files: ["api/server.ts"], outcome: done("did api") }],
      review: [APPROVE, REJECT],
      qa: [QA_FAILED, QA_PASSED],
    };
    const { result, approvals, state, events } = await run({ policy: { maxReviewIterations: 1 } });
    expect(result).toMatchObject({ status: "failed", failureKind: "review_rejected" });
    expect(approvals).toHaveLength(0);
    expect(state.feedback.join("\n")).toMatch(/Review still requested changes after 1 fix attempt/);
    expect(events.some((event) => event.type === "review.loop_stopped")).toBe(true);
    expect(await exists(path.join(checkout, "api/server.ts"))).toBe(false);
  });

  it("resumed with the approval for the same snapshot: lands (merge, accepted by the user)", async () => {
    scenario.steps = { review: [APPROVE], qa: [QA_PASSED] };
    const state = emptyState();
    state.fileChanges.set("api/server.ts", { filePath: "api/server.ts", changeType: "new", newContent: "content 1\n", diff: "" } as never);
    state.appliedFilesBySubtask.set("api", ["api/server.ts"]);
    state.reviewVerdicts.review = { verdict: "approved", findings: [] } as never;
    state.qaVerdicts.qa = "passed";
    const { result, approvals, merges, events } = await run({ approvalResolved: true, state, completedKeys: ["api", "review", "qa"] });
    expect(result.status).toBe("completed");
    expect(approvals).toHaveLength(0);
    expect(merges).toHaveLength(1);
    expect(events.find((event) => event.type === "branch.merged")?.payload).toMatchObject({ acceptedBy: "user" });
  });

  for (const phase of ["api", "review", "verify", "qa", "fix_qa_1"]) {
    it(`a cancel during ${phase} ends the invocation cancelled`, async () => {
      scenario.steps = { api: [{ files: ["api/server.ts"], outcome: done("did api") }], review: [APPROVE], qa: [QA_FAILED, QA_PASSED] };
      scenario.abortAt = phase;
      const { result, approvals, merges } = await run();
      expect(result).toMatchObject({ status: "cancelled", failureKind: "cancelled" });
      expect(approvals).toHaveLength(0);
      expect(merges).toHaveLength(0);
    });
  }
});

describe("terminal outcome failure kinds (item 7)", () => {
  it("a code change with no file changes ends no_change", async () => {
    scenario.steps = { api: [{ outcome: done("wrote nothing") }] };
    const plan = fullPlan();
    plan.subtasks = plan.subtasks.filter((subtask) => subtask.kind === "code_change");
    const { result } = await run({ plan });
    expect(result).toMatchObject({ status: "failed", failureKind: "no_change" });
  });

  it("verification still failing after its fix rounds ends verify_failed", async () => {
    scenario.steps = { api: [{ files: ["api/server.ts"], outcome: done("did api") }], review: [APPROVE] };
    scenario.verifications = [[{ name: "typecheck", status: "failed", details: "api/server.ts(3,1): error TS2322", files: ["api/server.ts"] }]];
    const plan = fullPlan();
    plan.subtasks = plan.subtasks.filter((subtask) => subtask.kind !== "qa");
    const { result, approvals } = await run({ plan, policy: { maxReviewIterations: 1 } });
    expect(result).toMatchObject({ status: "failed", failureKind: "verify_failed" });
    expect(approvals).toHaveLength(0);
  });

  it("QA still failing after its fix round ends qa_failed", async () => {
    scenario.steps = { api: [{ files: ["api/server.ts"], outcome: done("did api") }], review: [APPROVE], qa: [QA_FAILED] };
    const { result, approvals } = await run();
    expect(result).toMatchObject({ status: "failed", failureKind: "qa_failed" });
    expect(approvals).toHaveLength(0);
  });
});

describe("legacy order (no isolated worktree)", () => {
  it("keeps approval before apply / verify / QA, and nothing is written before it", async () => {
    scenario.steps = { api: [{ files: ["api/server.ts"], outcome: done("did api") }], review: [APPROVE], qa: [QA_PASSED] };
    const { result, approvals, events } = await run({ isolated: false });
    expect(result.status).toBe("waiting_approval");
    expect(approvals).toHaveLength(1);
    expect(scenario.verifyCalls).toBe(0);
    expect(scenario.order).not.toContain("run:qa");
    expect(events.some((event) => event.type === "task.stage_order")).toBe(false);
    expect((approvals[0].payload as Record<string, any>).stageOrder).toBeUndefined();
    expect(await exists(path.join(checkout, "api/server.ts"))).toBe(false);
  });

  it("still re-reviews a verification fix before it lands", async () => {
    scenario.steps = { api: [{ files: ["api/server.ts"], outcome: done("did api") }], review: [APPROVE] };
    scenario.verifications = [[{ name: "typecheck", status: "failed", details: "api/server.ts(3,1): error TS2322", files: ["api/server.ts"] }], [{ name: "typecheck", status: "passed" }]];
    const plan = fullPlan();
    plan.subtasks = plan.subtasks.filter((subtask) => subtask.kind !== "qa");
    const { result, events, approvals } = await run({ isolated: false, approvalResolved: true, plan });
    const reReview = events.find((event) => event.type === "review.rereview");
    expect(reReview?.payload).toMatchObject({ stage: "verification", fixKey: "fix_verify_1" });
    // Legacy ask mode still asks per fix, but only once the fix passed its re-review.
    expect(result.status).toBe("waiting_approval");
    expect(approvals).toHaveLength(1);
    expect(scenario.order.indexOf("rereview")).toBeGreaterThan(scenario.order.indexOf("run:fix_verify_1"));
    expect(scenario.order.indexOf("approval")).toBeGreaterThan(scenario.order.lastIndexOf("run:review"));
  });
});
