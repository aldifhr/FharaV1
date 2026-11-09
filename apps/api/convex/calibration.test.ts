/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { decisionFromEvent } from "./lib/calibration/capture";
import { buildTaskEvidence, labelDecision, type EvidenceRows } from "./lib/calibration/outcome";
import {
  MIN_ESTIMATE_SAMPLES,
  MIN_ROUTING_SAMPLES,
  estimatorSignals,
  recommendations,
  routingSignals,
  type AgentSetting,
  type LabelledDecision,
} from "./lib/calibration/aggregate";
import { estimatePlan, multiplierFor } from "./lib/estimate";

/** Decision Outcome Calibration (plan 026). */

const modules = import.meta.glob("./**/*.ts");

function rows(partial: Partial<EvidenceRows>): EvidenceRows {
  return {
    task: { status: "done" },
    subtasks: [],
    plans: [],
    events: [],
    approvals: [],
    fileChanges: [],
    usage: [],
    ...partial,
  };
}
const sub = (key: string, extra: Partial<EvidenceRows["subtasks"][number]> = {}) => ({
  key,
  status: "completed",
  acceptanceStatus: "accepted",
  attempts: 1,
  startedAt: 1000,
  completedAt: 2000,
  ...extra,
});
const routing = (key: string, extra: Record<string, unknown> = {}) => ({
  type: "routing",
  subtaskKey: key,
  chosen: "Backend",
  agentName: "Backend",
  capability: "backend-development",
  decidedAt: 900,
  ...extra,
});

describe("capture: decisions from existing events", () => {
  test("maps each decision event and ignores the rest", () => {
    const ev = (type: string, payload: unknown, extra = {}) =>
      decisionFromEvent({ id: "e1", taskId: "t1", type, payload, createdAt: 5, ...extra });
    expect(ev("tool.started", {})).toBeNull();
    expect(ev("plan.created", { version: 2, createdBy: "user", subtasks: [] })).toBeNull();
    expect(ev("plan.created", { version: 1, strategy: "dag", createdBy: "orchestrator", subtasks: ["a", "b"] })).toMatchObject({
      type: "plan",
      dedupeKey: "t1:plan:v1",
      chosen: "v1 dag (2 subtasks)",
      planVersion: 1,
    });
    const routed = ev(
      "subtask.routed",
      {
        subtaskKey: "api",
        capability: "backend-development",
        agent: "Backend 2",
        role: "backend",
        match: "exact",
        loadAware: { from: "Backend", to: "Backend 2", reason: "Backend at capacity (1/1)" },
      },
      {}
    );
    expect(routed).toMatchObject({
      type: "routing",
      dedupeKey: "t1:routing:api:Backend 2",
      chosen: "Backend 2",
      alternatives: ["Backend"],
      meta: { match: "exact", loadAware: { from: "Backend" } },
    });
    expect(routed!.reason).toContain("Backend at capacity");
    expect(ev("plan.replan_diff", { fromVersion: 1, toVersion: 2, failed: ["api"], added: ["api2"] })).toMatchObject({
      type: "replan",
      chosen: "v1 → v2",
      meta: { failed: ["api"], added: ["api2"] },
    });
    expect(ev("subtask.escalated", { subtaskKey: "a", route: "ask_user", kind: "ambiguous", reason: "which db?" })).toMatchObject({
      type: "escalation",
      chosen: "ask_user",
      alternatives: ["replan"],
    });
    expect(ev("qa.fix_started", { iteration: 1, findings: 2, agent: "Frontend" })).toMatchObject({ type: "qa_loop", chosen: "continue" });
    expect(ev("review.loop_stopped", { iteration: 2, findings: 3 })).toMatchObject({ type: "review_loop", chosen: "stop", meta: { stopReason: "max_iterations" } });
    expect(ev("stall.repeated_output", { detail: { loop: "qa", count: 2 } })).toMatchObject({ type: "qa_loop", chosen: "stop", meta: { stopReason: "repeated_output" } });
    expect(ev("stall.repeated_output", { detail: { loop: "verify" } })).toBeNull();
    expect(ev("orchestrator.decision", { subtaskKey: "a", action: "delegate", target: "b", reasoning: "needs api", expectedOutcome: "b done" })).toMatchObject({
      type: "engine",
      chosen: "delegate → b",
      reason: "needs api",
      meta: { action: "delegate", target: "b" },
    });
    expect(ev("orchestrator.delegation", { decision: "APPROVE", capability: "frontend" })).toMatchObject({ type: "delegation", chosen: "APPROVE" });
  });
});

describe("outcome labelling rules", () => {
  test("routing: good, bad, suboptimal, unknown", () => {
    const good = buildTaskEvidence(rows({ subtasks: [sub("api")] }));
    expect(labelDecision(routing("api"), good)).toMatchObject({ label: "good", final: true });

    const failed = buildTaskEvidence(rows({ task: { status: "failed" }, subtasks: [sub("api", { status: "failed", acceptanceStatus: null })] }));
    expect(labelDecision(routing("api"), failed).label).toBe("bad");
    expect(labelDecision(routing("api"), failed).factors).toContain("subtask failed");

    const replanned = buildTaskEvidence(
      rows({ subtasks: [sub("api")], events: [{ type: "plan.replan_diff", payload: { fromVersion: 1, toVersion: 2, failed: ["api"] }, createdAt: 3000 }] })
    );
    expect(labelDecision(routing("api"), replanned)).toMatchObject({ label: "bad", factors: ["caused replan v1→v2"] });

    const rejected = buildTaskEvidence(rows({ subtasks: [sub("api")], approvals: [{ kind: "file_change", status: "rejected", subtaskKey: "api" }] }));
    expect(labelDecision(routing("api"), rejected).label).toBe("bad");

    const retried = buildTaskEvidence(rows({ subtasks: [sub("api", { attempts: 2 })] }));
    expect(labelDecision(routing("api"), retried)).toMatchObject({ label: "suboptimal", factors: ["needed 2 attempts"] });

    const reviewed = buildTaskEvidence(
      rows({
        subtasks: [sub("api")],
        fileChanges: [{ filePath: "./src/api.ts", subtaskKey: "api" }],
        events: [{ type: "review.requested_changes", payload: { findings: [{ filePath: "src/api.ts", description: "x" }] }, createdAt: 2500 }],
      })
    );
    expect(labelDecision(routing("api"), reviewed).factors).toContain("review requested changes on its files (1)");
    expect(labelDecision(routing("api"), reviewed).label).toBe("suboptimal");

    const regressed = buildTaskEvidence(
      rows({
        subtasks: [sub("api", { completedAt: 2000 })],
        events: [
          { type: "task.check", payload: { label: "verify:test", status: "passed" }, createdAt: 1500 },
          { type: "task.check", payload: { label: "verify:test", status: "failed" }, createdAt: 2500 },
        ],
      })
    );
    expect(labelDecision(routing("api"), regressed).factors[0]).toMatch(/^regression: verify:test/);

    // Estimate: 3× tokens is suboptimal; 2× is only a note.
    const plan = { version: 1, createdAt: 0, createdBy: "orchestrator", estimate: { tokens: { total: 1000 }, perSubtask: [{ key: "api", inputTokens: 800, outputTokens: 200, durationMs: { mid: 1000 } }] } };
    const over = buildTaskEvidence(rows({ subtasks: [sub("api")], plans: [plan], usage: [{ subtaskKey: "api", inputTokens: 2500, outputTokens: 600 }] }));
    const overLabel = labelDecision(routing("api"), over);
    expect(overLabel.label).toBe("suboptimal");
    expect(overLabel.signals.tokensRatio).toBe(3.1);
    expect(overLabel.signals.durationRatio).toBe(1);
    const note = buildTaskEvidence(rows({ subtasks: [sub("api")], plans: [plan], usage: [{ subtaskKey: "api", inputTokens: 2000, outputTokens: 100 }] }));
    expect(labelDecision(routing("api"), note)).toMatchObject({ label: "good", factors: ["tokens estimate off by 2.1×"] });

    const running = buildTaskEvidence(rows({ task: { status: "running" }, subtasks: [sub("api", { status: "running" })] }));
    expect(labelDecision(routing("api"), running)).toMatchObject({ label: "unknown", final: false });
    expect(labelDecision(routing("api"), buildTaskEvidence(rows({ subtasks: [sub("api", { status: "skipped" })] }))).label).toBe("unknown");

    // History factor: shown, never changes the label.
    expect(labelDecision(routing("api"), good, { bad: 3, total: 4 }).factors).toContain(
      "Backend failed backend-development 3/4 times before"
    );
    expect(labelDecision(routing("api"), good, { bad: 3, total: 4 }).label).toBe("good");
  });

  test("plan: planner miss, replaced, final failure, user rejection", () => {
    const plans = [
      { version: 1, createdAt: 100, createdBy: "orchestrator" },
      { version: 2, createdAt: 500, createdBy: "orchestrator" },
    ];
    const ev = buildTaskEvidence(
      rows({
        plans,
        events: [
          { type: "requirements.coverage", payload: { uncovered: ["r2"], missingEvidence: [] }, createdAt: 300 },
          { type: "plan.replan_diff", payload: { fromVersion: 1, toVersion: 2, failed: ["a"] }, createdAt: 501 },
          { type: "requirements.coverage", payload: { uncovered: [], missingEvidence: [] }, createdAt: 800 },
        ],
      })
    );
    const v1 = labelDecision({ type: "plan", chosen: "v1", decidedAt: 100, planVersion: 1 }, ev);
    expect(v1.label).toBe("suboptimal");
    expect(v1.factors).toEqual(["replaced by replan to v2", "planner missed 1 requirement(s)"]);
    expect(v1.signals).toMatchObject({ plannerMiss: true, hadRequirements: true });
    const v2 = labelDecision({ type: "plan", chosen: "v2", decidedAt: 500, planVersion: 2 }, ev);
    expect(v2).toMatchObject({ label: "good", signals: { plannerMiss: false } });

    const failed = buildTaskEvidence(rows({ task: { status: "failed" }, plans: [plans[0]] }));
    expect(labelDecision({ type: "plan", chosen: "v1", decidedAt: 100, planVersion: 1 }, failed).factors).toContain("task failed on this plan");
    const rejected = buildTaskEvidence(rows({ task: { status: "rejected" }, plans: [plans[0]], approvals: [{ kind: "plan", status: "rejected" }] }));
    expect(labelDecision({ type: "plan", chosen: "v1", decidedAt: 100, planVersion: 1 }, rejected).label).toBe("bad");
    const running = buildTaskEvidence(rows({ task: { status: "running" }, plans: [plans[0]] }));
    expect(labelDecision({ type: "plan", chosen: "v1", decidedAt: 100, planVersion: 1 }, running)).toMatchObject({ label: "unknown", final: false });
  });

  test("replan: repeated strategy, failure after, success", () => {
    const meta = { fromVersion: 1, toVersion: 2, failed: ["api"], added: ["api2"], modified: [] };
    const repeated = buildTaskEvidence(
      rows({
        task: { status: "failed" },
        plans: [
          { version: 1, createdAt: 0, createdBy: "orchestrator" },
          { version: 2, createdAt: 100, createdBy: "orchestrator" },
          { version: 3, createdAt: 200, createdBy: "orchestrator" },
        ],
        events: [
          { type: "plan.replan_diff", payload: { fromVersion: 1, toVersion: 2, failed: ["api"], added: ["api2"] }, createdAt: 100 },
          { type: "plan.replan_diff", payload: { fromVersion: 2, toVersion: 3, failed: ["api", "api2"] }, createdAt: 200 },
        ],
      })
    );
    const out = labelDecision({ type: "replan", chosen: "v1 → v2", decidedAt: 100, meta }, repeated);
    expect(out.label).toBe("bad");
    expect(out.factors).toContain("replan repeated strategy: the same nodes failed again");
    expect(out.factors).toContain("replanned nodes failed again (v2→v3)");

    const ok = buildTaskEvidence(
      rows({
        plans: [{ version: 1, createdAt: 0, createdBy: "orchestrator" }, { version: 2, createdAt: 100, createdBy: "orchestrator" }],
        events: [{ type: "plan.replan_diff", payload: { fromVersion: 1, toVersion: 2, failed: ["api"] }, createdAt: 100 }],
      })
    );
    expect(labelDecision({ type: "replan", chosen: "v1 → v2", decidedAt: 100, meta }, ok).label).toBe("good");
  });

  test("QA/review loop continue and stop", () => {
    const verdicts = (list: Array<[string, number, number?]>) =>
      list.map(([type, at, n]) => ({ type, payload: type === "qa.failed" ? { findings: new Array(n ?? 1).fill("x") } : {}, createdAt: at }));
    const passedNext = buildTaskEvidence(rows({ events: verdicts([["qa.failed", 100, 2], ["qa.passed", 300]]) }));
    expect(labelDecision({ type: "qa_loop", chosen: "continue", decidedAt: 150 }, passedNext).label).toBe("good");
    const twoRounds = buildTaskEvidence(rows({ events: verdicts([["qa.failed", 100], ["qa.failed", 300], ["qa.passed", 500]]) }));
    expect(labelDecision({ type: "qa_loop", chosen: "continue", decidedAt: 150 }, twoRounds).label).toBe("suboptimal");
    const never = buildTaskEvidence(rows({ task: { status: "failed" }, events: verdicts([["qa.failed", 100], ["qa.failed", 300]]) }));
    expect(labelDecision({ type: "qa_loop", chosen: "continue", decidedAt: 150 }, never).label).toBe("bad");
    const shrinking = buildTaskEvidence(rows({ events: verdicts([["qa.failed", 100, 4], ["qa.failed", 300, 2]]) }));
    expect(labelDecision({ type: "qa_loop", chosen: "stop", decidedAt: 350, meta: { stopReason: "max_iterations" } }, shrinking)).toMatchObject({
      label: "suboptimal",
      factors: ["findings were still shrinking (4→2)"],
    });
    expect(labelDecision({ type: "qa_loop", chosen: "stop", decidedAt: 350, meta: { stopReason: "repeated_output" } }, shrinking).label).toBe("good");
  });

  test("engine and escalation follow the target / task", () => {
    const ev = buildTaskEvidence(rows({ task: { status: "failed" }, subtasks: [sub("b", { status: "failed", acceptanceStatus: null })] }));
    expect(labelDecision({ type: "engine", chosen: "delegate → b", decidedAt: 1, meta: { action: "delegate", target: "b" } }, ev).label).toBe("bad");
    expect(labelDecision({ type: "engine", chosen: "complete", decidedAt: 1, meta: { action: "complete" } }, ev).label).toBe("bad");
    expect(labelDecision({ type: "engine", chosen: "x", decidedAt: 1, meta: { action: "execute", expectedOutcome: "decision:step_limit" } }, ev).label).toBe("bad");
    const done = buildTaskEvidence(rows({ task: { status: "done", requirementCoverage: { outcome: "completed_with_gaps" } } }));
    expect(labelDecision({ type: "engine", chosen: "complete", decidedAt: 1, meta: { action: "complete" } }, done).factors).toContain("completed with requirement gaps");
    expect(labelDecision({ type: "escalation", chosen: "replan", decidedAt: 1, meta: { repeated: true } }, buildTaskEvidence(rows({})))).toMatchObject({
      label: "suboptimal",
      factors: ["repeated escalation"],
    });
  });
});

function decision(extra: Partial<LabelledDecision> & { label: LabelledDecision["label"] }): LabelledDecision {
  return { id: Math.random().toString(36), projectId: "p1", taskId: "t", type: "routing", decidedAt: 1, agentName: "Backend", agentId: "a1", capability: "auth", role: "backend", ...extra };
}
const AGENTS: AgentSetting[] = [
  { id: "a1", name: "Backend", role: "backend", priority: 0, capabilities: ["auth", "backend-development"], enabled: true },
  { id: "a2", name: "Backend 2", role: "backend", priority: 0, capabilities: ["auth"], enabled: true },
];

describe("aggregation + recommendation thresholds", () => {
  test("routing signal: rate and trend; unknown never counts", () => {
    const list = [
      ...[1, 2, 3].map((t) => decision({ label: "good", decidedAt: t })),
      ...[4, 5, 6].map((t) => decision({ label: "bad", decidedAt: t })),
      decision({ label: "unknown", decidedAt: 7 }),
    ];
    const [s] = routingSignals(list);
    expect(s).toMatchObject({ good: 3, bad: 3, unknown: 1, labelled: 6, goodRate: 0.5, trend: "declining" });
  });

  test("routing recommendation needs MIN_ROUTING_SAMPLES and an alternative agent", () => {
    const bad = (n: number) => Array.from({ length: n }, (_, i) => decision({ label: i === 0 ? "good" : "bad", decidedAt: i + 1 }));
    const base = { agents: AGENTS, multipliersByProject: new Map(), actions: [] };
    expect(recommendations({ ...base, decisions: bad(MIN_ROUTING_SAMPLES - 1) })).toEqual([]);
    const [rec] = recommendations({ ...base, decisions: bad(MIN_ROUTING_SAMPLES) });
    expect(rec.title).toBe("Lower Backend priority for capability auth: 1/5 good");
    expect(rec.apply).toEqual({ kind: "agent_priority", agentId: "a1", agentName: "Backend", from: 0, to: -1 });
    // No other agent declares the capability: advisory only, no Apply.
    const [solo] = recommendations({ ...base, agents: [AGENTS[0]], decisions: bad(5) });
    expect(solo.apply).toBeNull();
    // A good-enough agent gets nothing.
    const fine = Array.from({ length: 6 }, (_, i) => decision({ label: i < 3 ? "good" : "bad" }));
    expect(recommendations({ ...base, decisions: fine })).toEqual([]);
  });

  test("estimator signal + recommendation (median ratio, min samples, multiplier compounding)", () => {
    const est = (n: number, ratio: number) =>
      Array.from({ length: n }, () => decision({ label: "good", complexity: "high", tokensRatio: ratio, durationRatio: 1 }));
    const [sig] = estimatorSignals(est(5, 2.1));
    expect(sig).toMatchObject({ role: "backend", complexity: "high", tokens: { samples: 5, ratio: 2.1 }, duration: { ratio: 1 } });
    const base = { agents: AGENTS, actions: [] };
    expect(recommendations({ ...base, multipliersByProject: new Map(), decisions: est(MIN_ESTIMATE_SAMPLES - 1, 2.1) })).toEqual([]);
    const [rec] = recommendations({ ...base, multipliersByProject: new Map(), decisions: est(MIN_ESTIMATE_SAMPLES, 2.1) });
    expect(rec.title).toBe("Estimator under-predicts HIGH backend tokens by 2.1x");
    expect(rec.apply).toMatchObject({ kind: "estimator_multiplier", role: "backend", complexity: "high", metric: "tokens", from: 1, to: 2.1 });
    const [again] = recommendations({
      ...base,
      multipliersByProject: new Map([["p1", [{ role: "backend", complexity: "high", tokens: 2 }]]]),
      decisions: est(5, 1.6),
    });
    expect(again.apply).toMatchObject({ from: 2, to: 3.2 });
  });

  test("dismissed / applied recommendations return only on fresh evidence", () => {
    const old = Array.from({ length: 5 }, (_, i) => decision({ label: "bad", decidedAt: 10 + i }));
    const base = { agents: AGENTS, multipliersByProject: new Map() };
    const id = "routing:Backend:auth";
    expect(recommendations({ ...base, decisions: old, actions: [{ recId: id, action: "dismissed", at: 100 }] })).toEqual([]);
    const fresh = Array.from({ length: 5 }, (_, i) => decision({ label: "bad", decidedAt: 200 + i }));
    const back = recommendations({ ...base, decisions: [...old, ...fresh], actions: [{ recId: id, action: "applied", at: 100 }] });
    expect(back.map((r) => r.id)).toEqual([id]);
    expect(back[0].samples).toBe(5);
  });

  test("estimator multiplier reaches the estimate (exact complexity, then role-wide)", () => {
    const multipliers = [
      { role: "backend", tokens: 1.5 },
      { role: "backend", complexity: "high", tokens: 2, duration: 3 },
    ];
    expect(multiplierFor(multipliers, "backend", "high", "tokens")).toBe(2);
    expect(multiplierFor(multipliers, "backend", "low", "tokens")).toBe(1.5);
    expect(multiplierFor(multipliers, "backend", "low", "duration")).toBe(1);
    expect(multiplierFor(multipliers, "frontend", "high", "tokens")).toBe(1);
    const input = { subtasks: [{ key: "a", kind: "code_change", role: "backend", dependencies: [] }], samples: [], models: {}, now: 1 };
    const plain = estimatePlan(input);
    const scaled = estimatePlan({ ...input, multipliers, complexity: "high" });
    expect(scaled.tokens.total).toBe(Math.round(plain.perSubtask[0].inputTokens * 2) + Math.round(plain.perSubtask[0].outputTokens * 2));
    expect(scaled.perSubtask[0].durationMs.mid).toBe(plain.perSubtask[0].durationMs.mid * 3);
    expect(scaled).toMatchObject({ calibrated: true, complexity: "high" });
    expect(plain.calibrated).toBeUndefined();
  });
});

async function seedRun(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const be = await ctx.db.insert("agents", { name: "Backend", role: "backend", status: "idle", capabilities: ["auth"], priority: 0 });
    await ctx.db.insert("agents", { name: "Backend 2", role: "backend", status: "idle", capabilities: ["auth"], priority: 0 });
    const projectId = await ctx.db.insert("projects", { name: "Shop", workspacePath: "/tmp/a" });
    const taskId = await ctx.db.insert("tasks", { projectId, title: "Auth", command: "c", status: "done", updatedAt: Date.now() });
    const base = { description: "d", dependencies: [], order: 1, attempts: 1, kind: "code_change" as const, capability: "auth" };
    await ctx.db.insert("subtasks", { ...base, taskId, projectId, key: "login", title: "Login", status: "failed", objective: "Login works", requirementIds: ["r1"] });
    await ctx.db.insert("plans", { taskId, projectId, version: 1, strategy: "dag", createdBy: "orchestrator", goal: "Auth", payload: {}, createdAt: 1 });
    const now = Date.now();
    await ctx.db.insert("taskEvents", { taskId, projectId, type: "plan.created", payload: { version: 1, strategy: "dag", createdBy: "orchestrator", subtasks: ["login"] }, createdAt: now - 5000 });
    await ctx.db.insert("taskEvents", { taskId, projectId, type: "subtask.routed", payload: { subtaskKey: "login", capability: "auth", agent: "Backend", role: "backend", match: "exact" }, createdAt: now - 4000 });
    await ctx.db.insert("taskEvents", { taskId, projectId, type: "subtask.routed", payload: { subtaskKey: "login", capability: "auth", agent: "Backend", role: "backend", match: "exact" }, createdAt: now - 3000 });
    await ctx.db.insert("taskEvents", { taskId, projectId, type: "tool.started", payload: {}, createdAt: now - 2000 });
    return { projectId, taskId, be };
  });
}

describe("ledger, backfill, apply (convex)", () => {
  test("live hook: logEvent records one decision per decision event, deduped", async () => {
    const t = convexTest(schema, modules);
    const { projectId, taskId } = await seedRun(t);
    const routed = { taskId, projectId, type: "subtask.routed", payload: { subtaskKey: "login", capability: "auth", agent: "Backend", role: "backend", match: "exact" } };
    await t.mutation(internal.orchestration.logEvent, routed);
    await t.mutation(internal.orchestration.logEvent, routed); // retry of the same node
    await t.mutation(internal.orchestration.logEvent, { taskId, projectId, type: "tool.started", payload: {} });
    const rows = await t.run(async (ctx) => await ctx.db.query("decisions").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "routing",
      chosen: "Backend",
      alternatives: ["Backend 2"],
      expected: { objective: "Login works", requirementIds: ["r1"] },
    });
  });

  test("a terminal task schedules the evaluation only when it has decisions", async () => {
    const t = convexTest(schema, modules);
    const { projectId, taskId } = await seedRun(t);
    await t.run(async (ctx) => ctx.db.patch(taskId, { status: "running" }));
    await t.mutation(internal.orchestration.logEvent, {
      taskId,
      projectId,
      type: "subtask.routed",
      payload: { subtaskKey: "login", capability: "auth", agent: "Backend", role: "backend", match: "exact" },
    });
    await t.mutation(api.tasks.cancel, { taskId });
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.map((s) => s.name)).toContain("calibration:evaluateTask");
    const empty = await t.run(async (ctx) =>
      ctx.db.insert("tasks", { projectId, title: "No decisions", command: "c", status: "running", updatedAt: 1 })
    );
    await t.mutation(api.tasks.cancel, { taskId: empty });
    const after = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(after.filter((s) => s.name === "calibration:evaluateTask")).toHaveLength(1);
  });

  test("backfill is capped and idempotent, and labels the outcomes", async () => {
    const t = convexTest(schema, modules);
    const { taskId } = await seedRun(t);
    const first = await t.mutation(internal.calibration.backfill, { days: 9999, limit: 9999 });
    expect(first).toMatchObject({ tasks: 1, inserted: 2, next: null });
    const second = await t.mutation(internal.calibration.backfill, { days: 30 });
    expect(second).toMatchObject({ tasks: 1, inserted: 0 });
    const decisions = await t.query(api.calibration.forTask, { taskId });
    expect(decisions.map((d) => [d.type, d.label])).toEqual([
      ["plan", "good"],
      ["routing", "bad"],
    ]);
    expect(decisions[1].factors).toContain("subtask failed");
  });

  test("recommendations never apply themselves; Apply shows the diff contract and is audited", async () => {
    const t = convexTest(schema, modules);
    const { projectId, taskId, be } = await seedRun(t);
    await t.mutation(internal.calibration.backfill, { days: 30 });
    const otherTask = await t.run(async (ctx) => {
      const otherTask = await ctx.db.insert("tasks", { projectId, title: "Older", command: "c", status: "done", updatedAt: 1 });
      for (let i = 0; i < 5; i++) {
        await ctx.db.insert("decisions", {
          projectId,
          taskId: otherTask,
          type: "routing",
          chosen: "Backend",
          alternatives: ["Backend 2"],
          dedupeKey: `seed-${i}`,
          agentId: be,
          agentName: "Backend",
          capability: "auth",
          role: "backend",
          decidedAt: Date.now() - 1000 + i,
          label: i === 0 ? "good" : "bad",
          outcome: { label: i === 0 ? "good" : "bad", factors: [], final: true, signals: {}, evaluatedAt: 1 },
        });
      }
      return otherTask;
    });
    expect(otherTask).toBeTruthy();
    // Evaluation + summary read only: priority unchanged, no audit, no action.
    await t.mutation(internal.calibration.evaluateTask, { taskId });
    const summary = await t.query(api.calibration.summary, { projectId });
    const rec = summary.recommendations.find((r) => r.id === "routing:Backend:auth")!;
    expect(rec.title).toBe("Lower Backend priority for capability auth: 1/6 good");
    expect(rec.apply).toMatchObject({ kind: "agent_priority", from: 0, to: -1 });
    const untouched = await t.run(async (ctx) => ({
      agent: await ctx.db.get(be),
      audit: await ctx.db.query("audit").collect(),
      actions: await ctx.db.query("calibrationActions").collect(),
    }));
    expect(untouched.agent!.priority).toBe(0);
    expect(untouched.audit).toHaveLength(0);
    expect(untouched.actions).toHaveLength(0);

    // A stale diff is refused.
    await expect(
      t.mutation(api.calibration.apply, { recId: rec.id, projectId, expectedFrom: 3, expectedTo: 2 })
    ).rejects.toThrow(/changed since you saw the diff/);
    await t.mutation(api.calibration.apply, { recId: rec.id, projectId, expectedFrom: 0, expectedTo: -1 });
    const after = await t.run(async (ctx) => ({
      agent: await ctx.db.get(be),
      audit: await ctx.db.query("audit").collect(),
      actions: await ctx.db.query("calibrationActions").collect(),
    }));
    expect(after.agent!.priority).toBe(-1);
    expect(after.audit.map((a) => a.action).sort()).toEqual(["agent.update", "calibration.apply"]);
    expect(after.audit.find((a) => a.action === "agent.update")!.details).toMatchObject({ changed: ["priority"], source: "calibration" });
    expect(after.actions[0]).toMatchObject({ action: "applied", recId: rec.id, change: { from: 0, to: -1 } });
    // Applied → gone until fresh evidence.
    const next = await t.query(api.calibration.summary, { projectId });
    expect(next.recommendations.find((r) => r.id === rec.id)).toBeUndefined();
    await expect(
      t.mutation(api.calibration.apply, { recId: rec.id, projectId, expectedFrom: 0, expectedTo: -1 })
    ).rejects.toThrow(/no longer current/);
  });

  test("Dismiss hides a recommendation and is audited", async () => {
    const t = convexTest(schema, modules);
    const { projectId, taskId } = await seedRun(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 5; i++) {
        await ctx.db.insert("decisions", {
          projectId,
          taskId,
          type: "replan",
          chosen: "v1 → v2",
          alternatives: [],
          dedupeKey: `r-${i}`,
          decidedAt: Date.now() - 100 + i,
          label: "bad",
          outcome: { label: "bad", factors: [], final: true, signals: {}, evaluatedAt: 1 },
        });
      }
    });
    const before = await t.query(api.calibration.summary, { projectId });
    expect(before.recommendations.map((r) => r.id)).toContain("replan:effectiveness");
    expect(before.recommendations.find((r) => r.id === "replan:effectiveness")!.apply).toBeNull();
    await t.mutation(api.calibration.dismiss, { recId: "replan:effectiveness", projectId });
    const after = await t.query(api.calibration.summary, { projectId });
    expect(after.recommendations.map((r) => r.id)).not.toContain("replan:effectiveness");
    const audit = await t.run(async (ctx) => await ctx.db.query("audit").collect());
    expect(audit.map((a) => a.action)).toEqual(["calibration.dismiss"]);
  });
});
