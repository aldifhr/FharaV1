import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecutionPolicy } from "@/orchestrator/policy";
import type { WorkerAgent, WorkerTask } from "@/workerApi";
import { createFakeApi, createRunnerDeps, testPolicy, testTask } from "./helpers";

/**
 * P1b phase 1 (Decision Engine seam): golden event sequences.
 *
 * Every scenario drives the real `processTask` (planner and executor mocked,
 * as in taskRunner.engineReplan / phase5Runner / taskRunner.askUser) and
 * records what the decision path emits: every logEvent type in order, the
 * orchestrator.decision payload (action, target, decidedBy, expectedOutcome,
 * step), qa.* / objective payloads, delegations, pauses, agent messages, the
 * re-plan feedback and the final completion. The snapshots under
 * tests/__golden__/decision-engine/ were recorded on the code BEFORE the
 * runner overrides moved into `orchestrator/decisionEngine/`; any later
 * change to a decision or an event shows up as a snapshot diff
 * (`npx vitest run tests/decisionEngine.golden.test.ts -u` to accept one
 * on purpose).
 */

type Outcome = { status: "completed" | "failed"; output?: string; error?: string; meta?: Record<string, unknown> };
type Step = { files?: string[]; outcome: Outcome };

const scenario = vi.hoisted(() => ({
  plans: [] as unknown[],
  /** subtask key → outcomes per attempt (the last one repeats). */
  steps: {} as Record<string, Array<{ files?: string[]; outcome: Record<string, unknown> }>>,
  /** kind → default step when the key has none. */
  byKind: {} as Record<string, { files?: string[]; outcome: Record<string, unknown> }>,
  attempts: new Map<string, number>(),
  createPlanCalls: [] as Array<string | null>,
  /** When set, decide() returns this decision (as taskRunner.askUser does). */
  forced: null as Record<string, unknown> | null,
}));

vi.mock("../src/orchestrator/decision", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/orchestrator/decision")>();
  return {
    ...orig,
    decide: async (...args: Parameters<typeof orig.decide>) =>
      scenario.forced ? { decision: { ...scenario.forced, planVersion: 1, createdAt: 0 } } : orig.decide(...args),
  };
});

vi.mock("../src/orchestrator/planner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/orchestrator/planner")>()),
  createPlan: async (input: { feedback?: string }) => {
    scenario.createPlanCalls.push(input.feedback ?? null);
    const index = Math.min(scenario.createPlanCalls.length - 1, scenario.plans.length - 1);
    return { plan: JSON.parse(JSON.stringify(scenario.plans[index])), createdBy: "llm", notes: [] };
  },
  heuristicPlan: () => JSON.parse(JSON.stringify(scenario.plans[0])),
}));

vi.mock("../src/execution/agentExecutor", () => ({
  executeSubtask: async (input: {
    subtask: { key: string; kind: string };
    saveFileChange: (change: unknown) => Promise<void>;
  }) => {
    const key = input.subtask.key;
    const attempt = scenario.attempts.get(key) ?? 0;
    scenario.attempts.set(key, attempt + 1);
    const list = scenario.steps[key];
    const step = list ? list[Math.min(attempt, list.length - 1)] : scenario.byKind[input.subtask.kind] ?? { outcome: { status: "completed", output: `output-${key}` } };
    for (const file of step.files ?? []) {
      await input.saveFileChange({ filePath: file, changeType: "new", newContent: "content\n", diff: "" });
    }
    const outcome = { ...step.outcome } as Record<string, unknown>;
    if (step.files && step.files.length > 0) outcome.meta = { filePaths: step.files, ...((outcome.meta as object) ?? {}) };
    return outcome;
  },
}));

import { processTask } from "@/services/taskRunner";

const agent = (id: string, name: string, role: string, capabilities: string[]) =>
  ({ _id: id, name, role, capabilities, isEnabled: true, priority: 0 }) as WorkerAgent;

const FRONTEND = agent("agent-frontend", "Frontend", "frontend", ["frontend-development"]);
const BACKEND = agent("agent-backend", "Backend", "backend", ["backend-development"]);
const REVIEWER = agent("agent-reviewer", "Reviewer", "reviewer", ["code-review"]);
const QA = agent("agent-qa", "QA", "qa", ["browser-testing"]);
const RESEARCHER = agent("agent-research", "Researcher", "researcher", ["research"]);

const node = (key: string, kind: string, capability: string, dependencies: string[] = [], order = 0) => ({
  key,
  title: key,
  description: `Do ${key}`,
  kind,
  capability,
  dependencies,
  order,
});

const plan = (goal: string, subtasks: unknown[]) => ({
  version: 1,
  goal,
  strategy: "dag",
  requiresApproval: false,
  maxConcurrency: 1,
  subtasks,
});

const done = (output: string, meta?: Record<string, unknown>): Outcome => ({ status: "completed", output, ...(meta ? { meta } : {}) });

interface Scenario {
  name: string;
  command: string;
  plans: unknown[];
  steps?: Record<string, Step[]>;
  byKind?: Record<string, Step>;
  agents: WorkerAgent[];
  policy?: Partial<ExecutionPolicy>;
  pauseApplied?: boolean;
  forced?: Record<string, unknown>;
}

const SCENARIOS: Scenario[] = [
  {
    // taskRunner.engineReplan: an empty code_change → objective unmet → bounded re-plan → fail.
    name: "empty-code-change-replan",
    command: "Implement the feature",
    plans: [plan("Implement the feature", [node("implement", "code_change", "frontend-development")])],
    steps: { implement: [{ outcome: done("wrote nothing") }] },
    agents: [FRONTEND],
    policy: { maxReplans: 1, maxPlanningIterations: 1, orchestratorAuthoritative: false },
  },
  {
    // phase5Runner chain: applied code changes → objective met → complete latch.
    name: "code-change-complete",
    command: "Implement the feature",
    plans: [plan("Implement the feature", [node("s1", "code_change", "frontend-development"), node("s2", "code_change", "frontend-development", ["s1"], 1)])],
    steps: { s1: [{ files: ["a.txt"], outcome: done("did s1") }], s2: [{ files: ["b.txt"], outcome: done("did s2") }] },
    agents: [FRONTEND],
  },
  {
    // An APPROVE with a delegation recommendation spawns a delegate node, records the handoff.
    name: "delegate-backend",
    command: "Implement the feature",
    plans: [plan("Implement the feature", [node("ui", "code_change", "frontend-development")])],
    steps: {
      ui: [{ files: ["ui.txt"], outcome: done("did ui", { delegationRecommendation: { targetCapability: "backend-development", reason: "The API endpoint is missing", priority: "high" } }) }],
    },
    byKind: { code_change: { files: ["api.txt"], outcome: done("did api") } },
    agents: [FRONTEND, BACKEND],
  },
  {
    // A dynamic QA delegation is deferred to the post-apply QA stage.
    name: "delegate-qa-deferred",
    command: "Implement the feature",
    plans: [plan("Implement the feature", [node("ui", "code_change", "frontend-development")])],
    steps: {
      ui: [{ files: ["ui.txt"], outcome: done("did ui", { delegationRecommendation: { targetCapability: "browser-testing", reason: "Check it in a browser", priority: "high" } }) }],
    },
    byKind: { qa: { outcome: done("QA verdict: passed", { verdict: "passed", checks: [] }) } },
    agents: [FRONTEND, QA],
  },
  {
    // ... and suppressed under qaMode=never.
    name: "delegate-qa-suppressed",
    command: "Implement the feature",
    plans: [plan("Implement the feature", [node("ui", "code_change", "frontend-development")])],
    steps: {
      ui: [{ files: ["ui.txt"], outcome: done("did ui", { delegationRecommendation: { targetCapability: "browser-testing", reason: "Check it in a browser", priority: "high" } }) }],
    },
    agents: [FRONTEND, QA],
    policy: { qaMode: "never" } as Partial<ExecutionPolicy>,
  },
  {
    // A REVISE on a review node never spawns an engine fix (the review loop owns it).
    name: "review-changes-requested",
    command: "Implement the feature",
    plans: [plan("Implement the feature", [node("impl", "code_change", "frontend-development"), node("review", "review", "code-review", ["impl"], 1)])],
    steps: {
      impl: [{ files: ["impl.txt"], outcome: done("did impl") }],
      review: [
        { outcome: done("changes requested", { verdict: "changes_requested", findings: [{ severity: "high", file: "impl.txt", message: "Handle the empty state" }] }) },
        { outcome: done("approved", { verdict: "approved", findings: [] }) },
      ],
    },
    byKind: { code_change: { files: ["impl.txt"], outcome: done("fixed impl") } },
    agents: [FRONTEND, REVIEWER],
  },
  {
    // A permanently failed node: the engine judges the failure, the runner reports it.
    name: "failed-subtask",
    command: "Implement the feature",
    plans: [plan("Implement the feature", [node("impl", "code_change", "frontend-development")])],
    steps: { impl: [{ outcome: { status: "failed", error: "Permission denied: cannot write" } }] },
    agents: [FRONTEND],
  },
  {
    // The step bound halts the scheduler (decision:step_limit).
    name: "step-limit",
    command: "Implement the feature",
    plans: [plan("Implement the feature", [node("s1", "code_change", "frontend-development"), node("s2", "code_change", "frontend-development", ["s1"], 1)])],
    byKind: { code_change: { files: ["x.txt"], outcome: done("did it") } },
    agents: [FRONTEND],
    policy: { maxDecisionSteps: 1 },
  },
  {
    // A failed /research angle does not latch a replan; the synthesis runs on the rest.
    name: "research-angle-failed",
    command: "Research chart libraries",
    plans: [
      plan("Research chart libraries", [
        node("ra-1", "research", "research"),
        node("ra-2", "research", "research"),
        { ...node("synthesis", "research", "research", ["ra-1", "ra-2"], 1), partialDependencies: true },
      ]),
    ],
    steps: {
      "ra-1": [{ outcome: done("angle one findings") }],
      "ra-2": [{ outcome: { status: "failed", error: "Permission denied: source unavailable" } }],
      synthesis: [{ outcome: done("synthesis report") }],
    },
    agents: [RESEARCHER],
  },
  {
    // taskRunner.askUser: an ask_user decision pauses the task (first pause wins).
    name: "ask-user-pause",
    command: "Implement the feature",
    plans: [plan("Implement the feature", [node("impl", "code_change", "frontend-development")])],
    steps: { impl: [{ files: ["impl.txt"], outcome: done("did impl") }] },
    agents: [FRONTEND],
    pauseApplied: true,
    forced: { id: "d-ask", action: "ask_user", reasoning: "no other path", question: "Which style?", options: ["Bold", "Minimal"], decidedBy: "llm" },
  },
  {
    // call_agent: an ephemeral consult, logged as a System line; budget counts it.
    name: "call-agent",
    command: "Implement the feature",
    plans: [plan("Implement the feature", [node("impl", "code_change", "frontend-development")])],
    steps: { impl: [{ files: ["impl.txt"], outcome: done("did impl") }] },
    agents: [FRONTEND, BACKEND],
    forced: { id: "d-call", action: "call_agent", reasoning: "ask backend", target: { capability: "backend-development" }, decidedBy: "llm" },
  },
];

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-golden-engine-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

const KEEP_PAYLOAD = new Set(["orchestrator.decision", "orchestrator.objective_unmet", "orchestrator.completed", "orchestrator.budget_blocked", "orchestrator.decision_fallback", "orchestrator.evaluation_failed", "qa.deferred", "qa.suppressed"]);

async function run(s: Scenario) {
  scenario.plans = s.plans;
  scenario.steps = (s.steps ?? {}) as typeof scenario.steps;
  scenario.byKind = (s.byKind ?? {}) as typeof scenario.byKind;
  scenario.attempts = new Map();
  scenario.createPlanCalls = [];
  scenario.forced = s.forced ?? null;
  const events: unknown[] = [];
  const messages: string[] = [];
  const delegations: unknown[] = [];
  const pauses: unknown[] = [];
  const task = testTask({ title: s.command, command: s.command });
  const project = { _id: "project-1", name: "Fixture", workspacePath: workspace, approvalMode: "auto" as const };
  const { api, completions } = createFakeApi({
    getContext: async () => ({ task, project, agents: s.agents, plan: null, subtasks: [], approvalMode: "auto" as const }),
    logEvent: async (input: { type: string; payload?: Record<string, unknown>; subtaskKey?: string; level?: string }) => {
      if (!KEEP_PAYLOAD.has(input.type)) {
        events.push(input.type);
        return;
      }
      const payload = { ...(input.payload ?? {}) };
      delete payload.id;
      delete payload.budget;
      events.push({ type: input.type, subtaskKey: input.subtaskKey ?? null, level: input.level ?? null, payload });
    },
    appendAgentMessage: async (input: { content: string; subtaskKey?: string }) => {
      messages.push(`${input.subtaskKey ?? "-"}: ${input.content}`);
    },
    appendSystemLine: async (input: { content: string }) => {
      messages.push(`system: ${input.content}`);
    },
    recordDelegation: async (input: Record<string, unknown>) => {
      delegations.push({ from: input.fromAgentId, to: input.toAgentId ?? null, capability: input.capability ?? null, decision: input.decision });
    },
    pauseForInput: async (input: { question: string }) => {
      pauses.push(input.question);
      return s.pauseApplied ? { applied: true } : { applied: false, reason: "lease_lost" as const };
    },
    recordLifecycle: async () => undefined,
    upsertTaskContext: async () => undefined,
    getTaskContext: async () => null,
  });
  const policy = testPolicy({
    maxConcurrency: 1,
    maxReplans: 0,
    maxPlanningIterations: 0,
    maxReviewIterations: 1,
    maxConcurrentLLMCalls: 1,
    allowFallback: true,
    orchestratorAuthoritative: true,
    decisionLlmMode: "off",
    ...s.policy,
  });
  await processTask(task as unknown as WorkerTask, createRunnerDeps({ api, policy, workspaceRoot: workspace }));
  const last = completions.at(-1) as { status?: string; errorMessage?: string } | undefined;
  const trace = {
    events,
    messages,
    delegations,
    pauses,
    replanFeedback: scenario.createPlanCalls,
    attempts: Object.fromEntries([...scenario.attempts.entries()].sort(([a], [b]) => a.localeCompare(b))),
    completion: last ? { status: last.status ?? null, errorMessage: last.errorMessage ?? null } : null,
  };
  return JSON.stringify(trace, null, 2).split(workspace).join("<workspace>").replace(/"createdAt": \d+/g, '"createdAt": 0');
}

describe("decision engine seam: golden event sequences (no behaviour change)", () => {
  for (const s of SCENARIOS) {
    it(s.name, async () => {
      const trace = await run(s);
      await expect(`${trace}\n`).toMatchFileSnapshot(`./__golden__/decision-engine/${s.name}.json`);
      // Deterministic: a second run produces the same trace.
      expect(await run(s)).toBe(trace);
    });
  }
});
