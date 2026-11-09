import { describe, expect, it } from "vitest";
import type { AgentDefinition } from "@/types";
import {
  PERFORMANCE_DEFAULTS,
  PRIOR_SCORE,
  buildPerformanceSamples,
  scorePerformance,
  smooth,
  type PerfSubtaskInput,
  type PerformanceSample,
  type PerformanceScore,
} from "@/api/convex/lib/agentPerformance";
import { performanceRoutingEnabled, pickByPerformance } from "@/orchestrator/performanceRouting";
import { routeCapability } from "@/orchestrator/capabilities";
import { createRunContext } from "@/services/runner/runContext";
import type { ExecutePlanInput } from "@/services/runner/types";
import type { WebClient } from "@/tools/webClient";

/** Plan 027: performance scoring (smoothing, minimum sample size) and the router. */

const sample = (over: Partial<PerformanceSample>): PerformanceSample => ({
  agentId: "a",
  capability: "frontend-development",
  taskId: "t",
  subtaskKey: "s",
  finished: true,
  success: true,
  accepted: true,
  retriedOrFixed: false,
  regression: false,
  durationMs: 1000,
  tokens: 1000,
  at: 0,
  ...over,
});
const many = (n: number, over: Partial<PerformanceSample>) => Array.from({ length: n }, (_, i) => sample({ subtaskKey: `s${i}`, ...over }));

describe("scorePerformance — smoothing and minimum sample size", () => {
  it("smooth() pulls small samples toward the prior", () => {
    expect(smooth(1, 1, 0.8, 4)).toBeCloseTo(0.84);
    expect(smooth(0, 1, 0.8, 4)).toBeCloseTo(0.64);
    expect(smooth(100, 100, 0.8, 4)).toBeGreaterThan(0.99);
  });

  it("below the minimum sample size the score is exactly the prior, even after failures", () => {
    const [s] = scorePerformance(many(PERFORMANCE_DEFAULTS.minSamples - 1, { success: false, accepted: false }));
    expect(s.insufficient).toBe(true);
    expect(s.score).toBeCloseTo(PRIOR_SCORE, 3);
    // The breakdown still shows the evidence it has.
    expect(s.factors.success.raw).toBe(0);
  });

  it("a new agent is not punished relative to a poor one, and loses to a strong one", () => {
    const scores = scorePerformance([
      ...many(10, { agentId: "strong" }),
      ...many(10, { agentId: "poor", success: false, accepted: false, retriedOrFixed: true }),
      ...many(1, { agentId: "new", success: false }),
    ]);
    const by = Object.fromEntries(scores.map((s) => [s.agentId, s.score]));
    expect(by.strong).toBeGreaterThan(by.new);
    expect(by.new).toBeGreaterThan(by.poor);
  });

  it("acceptance, retries and regressions lower the score; unjudged samples don't count for acceptance", () => {
    const base = scorePerformance(many(8, { agentId: "x" }))[0];
    const regress = scorePerformance(many(8, { agentId: "x", regression: true }))[0];
    const retried = scorePerformance(many(8, { agentId: "x", retriedOrFixed: true }))[0];
    const unjudged = scorePerformance(many(8, { agentId: "x", accepted: null }))[0];
    expect(regress.score).toBeLessThan(base.score);
    expect(retried.score).toBeLessThan(base.score);
    expect(unjudged.factors.acceptance.n).toBe(0);
    expect(unjudged.factors.acceptance.rate).toBeCloseTo(PERFORMANCE_DEFAULTS.priors.acceptance);
  });

  it("efficiency is relative to the capability's peers", () => {
    const scores = scorePerformance([
      ...many(6, { agentId: "fast", durationMs: 500, tokens: 500 }),
      ...many(6, { agentId: "slow", durationMs: 4000, tokens: 4000 }),
    ]);
    const fast = scores.find((s) => s.agentId === "fast")!;
    const slow = scores.find((s) => s.agentId === "slow")!;
    expect(fast.factors.efficiency.value).toBeGreaterThan(0.5);
    expect(slow.factors.efficiency.value).toBeLessThan(0.5);
    expect(fast.factors.efficiency.tokensPerAccepted).toBe(500);
  });
});

describe("buildPerformanceSamples", () => {
  const st = (over: Partial<PerfSubtaskInput>): PerfSubtaskInput => ({
    taskId: "t1", key: "s1", capability: "Frontend Development", kind: "implementation", status: "completed",
    origin: "plan", agentId: "fe", attempts: 1, dependencies: [], startedAt: 0, completedAt: 1000, at: 0,
    acceptanceStatus: null, gates: { pass: 0, fail: 0 }, requirementIds: [], ...over,
  });

  it("marks a regression when a later fix touches the agent's files, a fix dependency, and gate/coverage failures", () => {
    const samples = buildPerformanceSamples({
      subtasks: [
        st({ key: "s1", gates: { pass: 2, fail: 0 } }),
        st({ key: "s2", requirementIds: ["R2"], completedAt: 1500 }),
        st({ key: "fix1", origin: "review_fix", agentId: "fe", startedAt: 2000, completedAt: 3000, at: 2000, dependencies: ["s2"] }),
      ],
      executions: [
        { taskId: "t1", subtaskKey: "s1", agentId: "fe", attempt: 1, filePaths: ["src/a.ts"] },
        { taskId: "t1", subtaskKey: "s2", agentId: "fe", attempt: 2, filePaths: ["src/b.ts"] },
        { taskId: "t1", subtaskKey: "fix1", agentId: "fe", attempt: 1, filePaths: ["src/a.ts"] },
      ],
      usage: [{ taskId: "t1", subtaskKey: "s1", agentId: "fe", tokens: 300 }],
      tasks: [{ taskId: "t1", gaps: ["R2"] }],
    });
    const s1 = samples.find((s) => s.subtaskKey === "s1")!;
    const s2 = samples.find((s) => s.subtaskKey === "s2")!;
    expect(s1).toMatchObject({ capability: "frontend-development", regression: true, accepted: true, tokens: 300, durationMs: 1000 });
    expect(s2).toMatchObject({ regression: false, retriedOrFixed: true, accepted: false });
  });
});

const agent = (over: Partial<AgentDefinition> & { _id: string; name: string; role: string }): AgentDefinition =>
  ({ isEnabled: true, capabilities: [], supportedTools: ["read_file"], ...over }) as AgentDefinition;
const fe1 = agent({ _id: "fe1", name: "Frontend", role: "frontend", capabilities: ["frontend-development"], priority: 8, maxConcurrency: 1 });
const fe2 = agent({ _id: "fe2", name: "Frontend B", role: "frontend", capabilities: ["frontend-development"], priority: 5, maxConcurrency: 2 });
const be = agent({ _id: "be", name: "Backend", role: "backend", capabilities: ["backend-development"], priority: 9, maxConcurrency: 4 });
const team = [fe1, fe2, be];

const score = (agentId: string, value: number, samples = 10, tokensPerAccepted: number | null = 1000): PerformanceScore => ({
  agentId, capability: "frontend-development", samples, insufficient: samples < 3, score: value, prior: PRIOR_SCORE,
  factors: {
    success: { rate: value, raw: value, n: samples }, acceptance: { rate: value, raw: value, n: samples },
    retry: { rate: 0, raw: 0, n: samples }, regression: { rate: 0, raw: 0, n: samples },
    efficiency: { value: 0.5, medianDurationMs: 1000, tokensPerAccepted },
  },
});
const scoresOf = (list: PerformanceScore[]) => (a: AgentDefinition, cap: string) => list.find((s) => s.agentId === a._id && s.capability === cap);

describe("pickByPerformance", () => {
  it("a better score wins", () => {
    const pick = pickByPerformance(fe1, "frontend-development", team, { loadOf: () => 0, scoreOf: scoresOf([score("fe1", 0.6), score("fe2", 0.9)]) });
    expect(pick.agent?._id).toBe("fe2");
    expect(pick.performance).toMatchObject({ from: "Frontend", to: "Frontend B", changed: true });
    expect(pick.performance?.reason).toMatch(/higher performance score: 0\.90 vs 0\.60/);
    expect(pick.performance?.scores.map((s) => s.agent)).toEqual(["Frontend", "Frontend B"]);
  });

  it("never violates the capability, however good another agent's score", () => {
    const pick = pickByPerformance(fe1, "frontend-development", team, {
      loadOf: () => 0,
      scoreOf: (a) => (a._id === "be" ? score("be", 0.99) : score(a._id, 0.5)),
    });
    expect(pick.agent?.role).toBe("frontend");
    expect(pick.performance?.scores.some((s) => s.role === "backend")).toBe(false);
  });

  it("leaves fallback (no exact match) picks alone", () => {
    const fallback = routeCapability("data-science", team);
    const pick = pickByPerformance(fallback, "data-science", team, { loadOf: () => 0, scoreOf: () => score("fe2", 0.99) });
    expect(pick.agent?._id).toBe(fallback?._id);
    expect(pick.performance).toBeUndefined();
  });

  it("respects capacity: a full agent is never picked while another has room, and all-full keeps the usual pick", () => {
    const full = pickByPerformance(fe1, "frontend-development", team, {
      loadOf: (a) => (a._id === "fe2" ? 2 : 0),
      scoreOf: scoresOf([score("fe1", 0.5), score("fe2", 0.95)]),
    });
    expect(full.agent?._id).toBe("fe1");
    const allFull = pickByPerformance(fe1, "frontend-development", team, {
      loadOf: (a) => (a._id === "fe1" ? 1 : 2),
      scoreOf: scoresOf([score("fe1", 0.5), score("fe2", 0.95)]),
    });
    expect(allFull.agent?._id).toBe("fe1");
    expect(allFull.performance?.reason).toMatch(/at capacity/);
    const defFull = pickByPerformance(fe1, "frontend-development", team, { loadOf: (a) => (a._id === "fe1" ? 1 : 0), scoreOf: () => undefined });
    expect(defFull.agent?._id).toBe("fe2");
  });

  it("ties keep the original order; within the tie margin model fit then budget decide", () => {
    const tie = pickByPerformance(fe1, "frontend-development", team, { loadOf: () => 0, scoreOf: scoresOf([score("fe1", 0.8), score("fe2", 0.81)]) });
    expect(tie.agent?._id).toBe("fe1");
    expect(tie.performance?.changed).toBe(false);
    const noScores = pickByPerformance(fe1, "frontend-development", team, { loadOf: () => 0, scoreOf: () => undefined });
    expect(noScores.agent?._id).toBe("fe1");
    const modelFit = pickByPerformance(fe1, "frontend-development", team, {
      loadOf: () => 0,
      scoreOf: scoresOf([score("fe1", 0.8), score("fe2", 0.8)]),
      modelFits: (a) => a._id === "fe2",
    });
    expect(modelFit.agent?._id).toBe("fe2");
    const budget = pickByPerformance(fe1, "frontend-development", team, {
      loadOf: () => 0,
      scoreOf: scoresOf([score("fe1", 0.8, 10, 50_000), score("fe2", 0.8, 10, 1000)]),
      remainingTokens: 10_000,
    });
    expect(budget.agent?._id).toBe("fe2");
    // A real score gap beats model fit.
    const gap = pickByPerformance(fe1, "frontend-development", team, {
      loadOf: () => 0,
      scoreOf: scoresOf([score("fe1", 0.9), score("fe2", 0.6)]),
      modelFits: (a) => a._id === "fe2",
    });
    expect(gap.agent?._id).toBe("fe1");
  });

  it("setting wins over the env default; default off", () => {
    expect(performanceRoutingEnabled({}, undefined)).toBe(false);
    expect(performanceRoutingEnabled({}, true)).toBe(true);
    expect(performanceRoutingEnabled({ performanceRouting: false }, true)).toBe(false);
    expect(performanceRoutingEnabled({ performanceRouting: true }, false)).toBe(true);
  });
});

describe("runContext.assign with performance routing", () => {
  const plan = {
    version: 1,
    subtasks: [{ key: "ui", title: "UI", description: "Build UI", kind: "implementation", capability: "frontend-development", dependencies: [], order: 1 }],
  };
  const ctxFor = (project: Record<string, unknown>, policy: Record<string, unknown> = {}) =>
    createRunContext(
      {
        deps: { policy, api: {} },
        task: { _id: "t1", command: "build ui" },
        project: { _id: "p1", ...project },
        plan,
        state: { feedback: [] },
        agents: team,
        completedKeys: [],
        workspacePath: "/tmp/x",
      } as unknown as ExecutePlanInput,
      {} as WebClient
    );

  it("off leaves the pick unchanged and records nothing", () => {
    const ctx = ctxFor({});
    ctx.performanceScores.set("fe2::frontend-development", score("fe2", 0.99));
    ctx.performanceScores.set("fe1::frontend-development", score("fe1", 0.1));
    expect(ctx.assign("ui")?._id).toBe(routeCapability("frontend-development", team)?._id);
    expect(ctx.performanceByKey.size).toBe(0);
  });

  it("on, the better-scored capable agent is assigned and the decision recorded", () => {
    const ctx = ctxFor({ performanceRouting: true });
    const usual = routeCapability("frontend-development", team)!;
    const other = usual._id === "fe1" ? "fe2" : "fe1";
    ctx.performanceScores.set(`${usual._id}::frontend-development`, score(usual._id, 0.4));
    ctx.performanceScores.set(`${other}::frontend-development`, score(other, 0.95));
    expect(ctx.assign("ui")?._id).toBe(other);
    expect(ctx.performanceByKey.get("ui")).toMatchObject({ changed: true });
  });

  it("env fallback turns it on when the project has no setting", () => {
    const ctx = ctxFor({}, { performanceRouting: true });
    expect(ctx.performanceRouting).toBe(true);
  });
});
