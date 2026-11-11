import { describe, expect, it, vi } from "vitest";
import type { Escalation } from "@/api/convex/lib/subtaskContract";
import { handleEscalation } from "@/services/runner/escalation";
import { parseCtoVerdict, CTO_QUESTION_SPEC } from "@/decisionTurn/ctoQuestion";
import { runDecisionTurn } from "@/decisionTurn/runDecisionTurn";
import type { DecisionTurnPort } from "@/decisionTurn/port";
import type { RunState } from "@/services/runner/types";

/** GOAT G13: executor escalations go to the CTO's decision turn first, within policy. */

const dep: Escalation = { kind: "new_dependency", reason: "The change adds a dependency the subtask does not name: zod", detail: "zod", source: "detected" };
const cto = { _id: "a-cto", name: "CTO", role: "cto", isEnabled: true } as never;
const backend = { _id: "a-be", name: "Backend", role: "backend", isEnabled: true } as never;

function fakePort(overrides: Partial<Record<keyof DecisionTurnPort, unknown>> = {}) {
  const calls: Record<string, any[]> = { open: [], answer: [], expire: [], consume: [] };
  const port = {
    open: vi.fn(async (input: any) => {
      calls.open.push(input);
      return (overrides.open as any) ?? { route: "cto", turnId: "turn1", status: "open", expiresAt: Date.now() + 60_000 };
    }),
    answer: vi.fn(async (input: any) => {
      calls.answer.push(input);
      return (overrides.answer as any) ?? { applied: true, status: input.verdict === "answer" ? "answered" : "escalated" };
    }),
    expire: vi.fn(async (input: any) => {
      calls.expire.push(input);
      return { applied: true };
    }),
    consume: vi.fn(async (input: any) => {
      calls.consume.push(input);
      return { consumed: true };
    }),
    claimNext: vi.fn(async () => null),
  } as unknown as DecisionTurnPort;
  return { port, calls };
}

function fakeCtx(opts: { mode?: string; port?: DecisionTurnPort; ask?: (prompt: string) => Promise<string>; agents?: unknown[] } = {}) {
  const calls: Record<string, any[]> = { pauseForInput: [], logEvent: [] };
  const api = {
    pauseForInput: vi.fn(async (input: any) => {
      calls.pauseForInput.push(input);
      return { applied: true };
    }),
    logEvent: vi.fn(async (input: any) => {
      calls.logEvent.push(input);
    }),
    recordSubtaskAcceptance: vi.fn(async () => ({ applied: true })),
  };
  const state: RunState = { priorOutputs: new Map(), qaVerdicts: {}, reviewVerdicts: {}, fileChanges: new Map(), appliedFilesBySubtask: new Map(), feedback: [] };
  const budgetGate = vi.fn();
  const ctx = {
    deps: {
      api,
      workerId: "w1",
      decisionTurns: opts.port,
      ctoFirst: { enabled: true, ttlMs: 60_000 },
      ...(opts.ask ? { decisionTurnAsk: opts.ask } : {}),
    },
    task: { _id: "t1", title: "CSV export", permissionMode: opts.mode ?? "auto_edits" },
    project: { _id: "p1" },
    taskId: "t1",
    plan: { subtasks: [{ key: "implement", title: "Implement export", description: "d" }] },
    agents: opts.agents ?? [cto, backend],
    state,
    input: { replansLeft: 2, assertBudgetForCall: budgetGate },
    inStageLoop: false,
    escalated: false,
    decisionTerminal: false,
    replanFeedback: null as string | null,
    waitingForInput: null as string | null,
  };
  return { ctx, calls, state, budgetGate };
}

const allow = async () =>
  JSON.stringify({ verdict: "answer", option: "Allow the dependency", answer: "Allow zod for request validation.", rationale: "Small and typed" });

describe("CTO-first escalations", () => {
  it("a new-dependency question within policy is answered by the CTO: replan with its decision, outbox consumed", async () => {
    const { port, calls: portCalls } = fakePort();
    const { ctx, calls, state, budgetGate } = fakeCtx({ port, ask: allow });
    await handleEscalation(ctx as any, "implement", dep, "e1");
    expect(portCalls.open[0]).toMatchObject({ source: "escalation", delivery: "inline", kind: "new_dependency", subtaskKey: "implement" });
    expect(budgetGate).toHaveBeenCalledTimes(1);
    expect(portCalls.answer[0]).toMatchObject({ turnId: "turn1", verdict: "answer", chosenOption: "Allow the dependency" });
    expect(calls.pauseForInput).toHaveLength(0);
    expect(ctx.replanFeedback).toMatch(/CTO decision: Allow zod for request validation\./);
    expect(state.allowedEscalations).toEqual([{ kind: "new_dependency", detail: "zod" }]);
    expect(portCalls.consume).toEqual([{ turnId: "turn1", workerId: "w1" }]);
    expect(calls.logEvent[0]).toMatchObject({ type: "subtask.escalated", payload: { route: "replan", decidedBy: "cto" } });
  });

  it("the CTO choosing the declining option replans without the allowance", async () => {
    const { port } = fakePort();
    const decline = async () =>
      JSON.stringify({ verdict: "answer", option: "Do it without a new dependency", answer: "Use the built-in URLSearchParams.", rationale: "No new dep needed" });
    const { ctx, state } = fakeCtx({ port, ask: decline });
    await handleEscalation(ctx as any, "implement", dep);
    expect(ctx.replanFeedback).toMatch(/CTO decision: Use the built-in URLSearchParams\./);
    expect(state.allowedEscalations).toBeUndefined();
  });

  it("a secret question and a push question always reach the user; the CTO is never asked", async () => {
    for (const reason of [
      "The change reads the API key from .env to call the payments service",
      "The change needs a git push of the generated client before it can build",
    ]) {
      const { port, calls: portCalls } = fakePort();
      const ask = vi.fn(allow);
      const { ctx, calls } = fakeCtx({ port, ask, mode: "full_access" });
      await handleEscalation(ctx as any, "implement", { ...dep, reason });
      expect(portCalls.open).toHaveLength(0);
      expect(ask).not.toHaveBeenCalled();
      expect(calls.pauseForInput).toHaveLength(1);
      expect(ctx.replanFeedback).toBeNull();
      expect(calls.logEvent[0]).toMatchObject({ payload: { route: "ask_user", decidedBy: "user_only" } });
    }
  });

  it("expiry never auto-picks: the turn expires and the user gets the question with both options", async () => {
    const { port, calls: portCalls } = fakePort({ open: { route: "cto", turnId: "turn1", status: "open", expiresAt: Date.now() + 30 } });
    const slow = () => new Promise<string>((resolve) => setTimeout(() => resolve('{"verdict":"answer","option":"Allow the dependency","answer":"ok"}'), 500));
    const { ctx, calls, state } = fakeCtx({ port, ask: slow });
    await handleEscalation(ctx as any, "implement", dep);
    expect(portCalls.answer).toHaveLength(0);
    expect(portCalls.expire).toHaveLength(1);
    expect(calls.pauseForInput).toHaveLength(1);
    expect(calls.pauseForInput[0].options).toEqual(["Allow the dependency", "Do it without a new dependency"]);
    expect(calls.pauseForInput[0].question).toMatch(/did not answer in time/);
    expect(state.allowedEscalations).toBeUndefined();
    expect(ctx.replanFeedback).toBeNull();
  });

  it("an answer committed before a crash is applied from `open` without a second turn", async () => {
    const { port, calls: portCalls } = fakePort({
      open: { route: "cto", turnId: "turn9", status: "answered", answer: "Allow zod.", chosenOption: "Allow the dependency" },
    });
    const ask = vi.fn(allow);
    const { ctx, state } = fakeCtx({ port, ask });
    await handleEscalation(ctx as any, "implement", dep);
    expect(ask).not.toHaveBeenCalled();
    expect(ctx.replanFeedback).toMatch(/CTO decision: Allow zod\./);
    expect(state.allowedEscalations).toHaveLength(1);
    expect(portCalls.consume).toEqual([{ turnId: "turn9", workerId: "w1" }]);
  });

  it("no CTO in the team (noCto): the deterministic policy decides as before G13", async () => {
    const { port } = fakePort({ open: { route: "user", category: "dependency", reason: "No CTO", noCto: true } });
    const { ctx, calls } = fakeCtx({ port, ask: allow });
    await handleEscalation(ctx as any, "implement", dep);
    expect(calls.pauseForInput).toHaveLength(0);
    expect(ctx.replanFeedback).toMatch(/^Escalation from subtask implement/);
    expect(calls.logEvent[0]).toMatchObject({ payload: { decidedBy: "policy" } });
  });
});

describe("CTO verdict parser", () => {
  const q = { question: "Add zod?", options: ["Allow the dependency", "Do it without a new dependency"] };
  it("escalates an option outside the offered ones, an unparseable reply, and an answer crossing the ceiling", () => {
    expect(parseCtoVerdict('{"verdict":"answer","option":"Something else","answer":"x"}', q).verdict).toBe("escalate");
    expect(parseCtoVerdict("sure, go ahead", q).verdict).toBe("escalate");
    expect(parseCtoVerdict('{"verdict":"answer","option":"Allow the dependency","answer":"Allow it, then push to main"}', q).verdict).toBe("escalate");
    expect(parseCtoVerdict('{"verdict":"escalate","rationale":"product call"}', q)).toEqual({ verdict: "escalate", rationale: "product call" });
  });

  it("the turn is unavailable without a CTO and never calls the model", async () => {
    const ask = vi.fn(allow);
    const outcome = await runDecisionTurn(CTO_QUESTION_SPEC, q, { agents: [backend], deadline: Date.now() + 1000, ask });
    expect(outcome.verdict).toBe("unavailable");
    expect(ask).not.toHaveBeenCalled();
  });
});
