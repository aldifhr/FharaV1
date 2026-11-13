import { describe, expect, it } from "vitest";
import type { AgentDefinition, PlanSubtask } from "@/types";
import type { RunContext } from "@/services/runner/types";
import { budgetHaltFeedback, createCancelCheck, retryAllowed, shouldHaltNewNodes } from "@/services/runner/nodes/executionGuard";
import { createExecutionResolver, nodeTimeoutFor, refreshRoutingSignals, unroutableOutcome } from "@/services/runner/nodes/executionResolver";
import { createNodeObserver, createStallReporter, logHeld, logRouted, logSkippedRoutes } from "@/services/runner/nodes/nodeObserver";
import { foldQaCheck } from "@/services/runner/nodes/qaNode";
import { agentHasSlot, schedulerHooks, toSchedulerNodes } from "@/services/runner/nodes/nodeDispatcher";
import { blockNode, createSiblingTracker, prerequisiteFailure, runNode, type NodeLifecycleEnv } from "@/services/runner/nodes/nodeLifecycle";
import { testPolicy } from "./helpers";

/**
 * Focused unit tests for the runNodes implementation details in
 * services/runner/nodes/ (one describe per module). The end-to-end
 * behaviour stays pinned by the runNodes / decisionEngine / scheduler goldens.
 */

const subtask = (key: string, kind = "code_change", dependencies: string[] = []) =>
  ({ key, title: key, description: key, kind, capability: "frontend", dependencies, order: 0 }) as PlanSubtask;

const agent = (fields: Partial<AgentDefinition> = {}) =>
  ({ _id: "agent-1", name: "Ada", role: "frontend", capabilities: ["frontend"], ...fields }) as AgentDefinition;

function harness(fields: Record<string, unknown> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const api = new Proxy({} as Record<string, unknown>, {
    get: (_, name: string) => async (args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "getContext") return { task: { status: (fields.status as string) ?? "running" } };
      if (name === "getAgentLoad") return { "agent-1": 2 };
      return undefined;
    },
  });
  const ctx = {
    plan: { version: 1, goal: "g", strategy: "dag", subtasks: [] },
    state: { feedback: [] as string[], fileChanges: new Map(), appliedFilesBySubtask: new Map() },
    runCompleted: new Set<string>(),
    executionIds: new Map(),
    assign: () => null,
    deps: { api, policy: testPolicy({ maxConcurrency: 2 }), workerId: "w" },
    input: { agents: [] },
    task: { _id: "task-1", command: "c" },
    project: { _id: "project-1" },
    taskId: "task-1",
    activeByAgent: new Map<string, number>(),
    modelRoutingByKey: new Map(),
    loadAwareByKey: new Map(),
    performanceByKey: new Map(),
    lastPostedMessage: new Map(),
    loadSnapshot: new Map(),
    performanceScores: new Map(),
    performanceScoresAt: 0,
    lastStatusCheck: 0,
    budgetHalt: false,
    stepLimitHit: false,
    decisionTerminal: false,
    paused: false,
    cancelled: false,
    ...fields,
  } as unknown as RunContext;
  return { ctx, calls, events: () => calls.filter((call) => call.name === "logEvent").map((call) => call.args) };
}

const exhaustedBudget = (exhausted: boolean) => ({ isLlmBudgetExhausted: () => ({ exhausted, reason: "calls 5/5" }) });

describe("nodes/executionGuard", () => {
  it("halts new nodes on any latch", () => {
    expect(shouldHaltNewNodes(harness().ctx)).toBe(false);
    expect(shouldHaltNewNodes(harness({ paused: true }).ctx)).toBe(true);
    expect(shouldHaltNewNodes(harness({ budgetHalt: true }).ctx)).toBe(true);
  });

  it("cancels on the task abort signal without polling", async () => {
    const controller = new AbortController();
    controller.abort();
    const { ctx, calls } = harness({ input: { taskAbort: { signal: controller.signal, abort: () => undefined } } });
    expect(await createCancelCheck(ctx)()).toBe(true);
    expect(ctx.cancelled).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("polls the task status and latches pause without cancelling", async () => {
    const { ctx } = harness({ status: "paused" });
    expect(await createCancelCheck(ctx)()).toBe(false);
    expect(ctx.paused).toBe(true);
    const stopped = harness({ status: "cancelled" });
    expect(await createCancelCheck(stopped.ctx)()).toBe(true);
  });

  it("vetoes retries once aborted or out of LLM budget", () => {
    expect(retryAllowed({})).toBe(true);
    expect(retryAllowed({ budget: exhaustedBudget(true) } as never)).toBe(false);
    expect(retryAllowed({ budget: exhaustedBudget(false) } as never)).toBe(true);
  });

  it("names the budget only while the halt is latched", () => {
    expect(budgetHaltFeedback({ budgetHalt: false, input: { budget: exhaustedBudget(true) } } as never, "a")).toBeUndefined();
    expect(budgetHaltFeedback({ budgetHalt: true, input: { budget: exhaustedBudget(true) } } as never, "a")).toBe("a: Budget exhausted: calls 5/5");
  });
});

describe("nodes/executionResolver", () => {
  it("blocks an unroutable node with the engine's reason", async () => {
    const { ctx, events } = harness();
    const outcome = await unroutableOutcome(ctx, "a", subtask("a"));
    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.error.startsWith("Blocked: ")).toBe(true);
    expect(events()[0]).toMatchObject({ type: "subtask.routed", payload: { subtaskKey: "a", agent: null, blocked: true } });
  });

  it("resolves nothing and runs on the API without an LLM resolver", async () => {
    const { ctx } = harness();
    const resolver = createExecutionResolver(ctx);
    expect(await resolver.prepare("a", agent())).toBeUndefined();
    expect(await resolver.handles("a", agent())).toEqual({ route: undefined, llmHandles: undefined });
    expect(await resolver.runtime("a", agent({ executionRuntime: "api" } as never), undefined)).toEqual({ runtime: "api" });
  });

  it("follows a prepared native route", async () => {
    const { ctx } = harness();
    const route = { runtime: "native-provider", model: "m", skipped: [] } as never;
    expect(await createExecutionResolver(ctx).runtime("a", agent(), route)).toEqual({ runtime: "native-provider", model: "m" });
  });

  it("gives a node at least the policy timeout", () => {
    const { ctx } = harness();
    expect(nodeTimeoutFor(ctx, null)).toBeGreaterThanOrEqual(Math.min(ctx.deps.policy.subtaskTimeoutMs, 1));
  });

  it("reads the agent load only when load-aware routing is on", async () => {
    const off = harness();
    await refreshRoutingSignals(off.ctx);
    expect(off.calls).toHaveLength(0);
    const on = harness({ loadAwareRouting: true });
    await refreshRoutingSignals(on.ctx);
    expect(on.ctx.loadSnapshot.get("agent-1")).toBe(2);
  });
});

describe("nodes/nodeObserver", () => {
  it("logs a stall at its level", async () => {
    const { ctx, events } = harness();
    await createStallReporter(ctx)({ kind: "agent_stalled", action: "retry", reason: "quiet", nodeKey: "a" } as never);
    expect(events()[0]).toMatchObject({ subtaskKey: "a", level: "warn", payload: { action: "retry", reason: "quiet" } });
  });

  it("logs skipped routes, holds and the routed agent", async () => {
    const { ctx, events } = harness();
    await logSkippedRoutes(ctx, "a", [{ model: "m", reason: "r" }] as never);
    await logHeld(ctx, "a");
    await logRouted(ctx, "a", subtask("a"), agent({ capabilities: ["frontend"] } as never), undefined);
    expect(events().map((event) => event.type)).toEqual(["opencode.skipped", "subtask.held", "subtask.routed"]);
    expect(events()[2]).toMatchObject({ payload: { agent: "Ada", match: "exact" } });
  });

  it("drops an exact-duplicate message and records token usage", async () => {
    const { ctx, calls } = harness();
    let beats = 0;
    const observer = createNodeObserver({
      ctx, nodeKey: "a", subtask: subtask("a"), agent: agent(), executionId: undefined,
      beat: () => beats++, reportActivity: () => undefined, live: { push: () => undefined, line: () => undefined } as never,
    });
    await observer.onMessage("same");
    await observer.onMessage("same");
    await observer.onTokenUsage(0, 0, "m");
    await observer.onTokenUsage(3, 4, "m");
    expect(calls.filter((call) => call.name === "appendAgentMessage")).toHaveLength(1);
    expect(calls.filter((call) => call.name === "recordTokenUsage")).toHaveLength(1);
    expect(beats).toBe(4);
  });
});

describe("nodes/qaNode", () => {
  it("folds a check into the live QA card and re-posts it", async () => {
    const qaCard = { key: "qa:1", iteration: 1, rows: [] as never[], agentId: "agent-1" } as RunContext["qaCard"];
    const { ctx, calls } = harness({ qaCard });
    await foldQaCheck(ctx, { label: "application reachable", status: "passed", details: "http://localhost:3000" });
    expect(ctx.qaCard?.url).toBe("http://localhost:3000");
    expect(calls.length).toBeGreaterThan(0);
  });

  it("ignores an unlabelled check", async () => {
    const { ctx, calls } = harness({ qaCard: { key: "k", iteration: 1, rows: [] } });
    await foldQaCheck(ctx, {});
    expect(calls).toHaveLength(0);
  });
});

describe("nodes/nodeDispatcher", () => {
  it("keeps only in-subset dependencies and marks writers", () => {
    const nodes = toSchedulerNodes([subtask("a"), subtask("b", "analysis", ["a", "outside"])], new Set(["a", "b"]));
    expect(nodes.map((node) => [node.id, node.dependencies, node.writes])).toEqual([["a", [], true], ["b", ["a"], false]]);
  });

  it("defers a node whose agent is at its concurrency", () => {
    const { ctx } = harness({ assign: () => agent({ maxConcurrency: 1 } as never) });
    expect(agentHasSlot(ctx, "a")).toBe(true);
    ctx.activeByAgent.set("agent-1", 1);
    expect(agentHasSlot(ctx, "a")).toBe(false);
    expect(agentHasSlot(harness().ctx, "a")).toBe(true);
  });

  it("builds the scheduler hooks from the policy", () => {
    const { ctx } = harness();
    const env = { ctx, reportStall: async () => undefined } as unknown as NodeLifecycleEnv;
    const hooks = schedulerHooks(env, { agentStallMs: 5, agentStallRetries: 2, repeatedOutputLimit: 3 });
    expect(hooks).toMatchObject({ maxConcurrency: 2, stallMs: 5, stallRetries: 2 });
    expect(hooks.shouldHaltNewNodes?.()).toBe(false);
  });
});

describe("nodes/nodeLifecycle", () => {
  it("fails the subset closed on an unmet prerequisite", () => {
    const { ctx } = harness();
    const nodes = [subtask("b", "code_change", ["a"])];
    const result = prerequisiteFailure(ctx, nodes, new Set(["b"]));
    expect(result?.failed).toEqual(["b"]);
    expect(ctx.state.feedback).toHaveLength(1);
    ctx.runCompleted.add("a");
    expect(prerequisiteFailure(ctx, nodes, new Set(["b"]))).toBeUndefined();
  });

  it("holds a node blocked by a pause, and records any other block", async () => {
    const paused = harness({ paused: true });
    const env = (ctx: RunContext) => ({ ctx, siblings: createSiblingTracker([]) }) as unknown as NodeLifecycleEnv;
    await blockNode(env(paused.ctx), { id: "a", dependencies: [] }, "halted");
    expect(paused.events()[0]).toMatchObject({ type: "subtask.held" });
    expect(paused.ctx.state.feedback).toHaveLength(0);
    const blocked = harness();
    await blockNode(env(blocked.ctx), { id: "a", dependencies: [] }, "halted");
    expect(blocked.ctx.state.feedback).toEqual(["a: halted"]);
    expect(blocked.events()[0]).toMatchObject({ type: "subtask.blocked", level: "warn" });
  });

  it("returns a previously completed node without executing it", async () => {
    const { ctx } = harness({ assign: () => agent() });
    ctx.plan.subtasks.push(subtask("a"));
    ctx.runCompleted.add("a");
    const env = { ctx } as unknown as NodeLifecycleEnv;
    expect(await runNode(env, { id: "a", dependencies: [] }, new AbortController().signal, undefined)).toEqual({
      status: "completed",
      output: "Previously completed",
    });
  });
});
