import { describe, expect, it, vi } from "vitest";
import { runScheduler, type NodeOutcome } from "@/scheduler/dagScheduler";
import {
  RepeatedOutputGuard,
  classifyProviderError,
  outputHash,
  stallThresholdsFromEnv,
  validateDag,
  type StallObservation,
} from "@/utils/stallDetector";
import { runLlmCallWithFallback, type FallbackHandle } from "@/effects/llmCall";
import { runWithObservationScope } from "@/effects/observationContext";
import { repeatedOutputStop } from "@/services/runner/repeatGuard";
import type { LLMProvider } from "@/llm";

const nodes = (definitions: Array<[string, string[]]>) =>
  definitions.map(([id, dependencies]) => ({ id, dependencies }));

const baseHooks = (observations: StallObservation[]) => ({
  maxConcurrency: 1,
  timeoutMs: 5_000,
  retries: 0,
  retryDelayMs: 0,
  onStart: async () => undefined,
  onOutcome: async () => undefined,
  onStall: (observation: StallObservation) => {
    observations.push(observation);
  },
});

describe("Deadlock & stall detector — scheduler", () => {
  it("dependency deadlock: a node whose dependency failed fails with the node and the reason", async () => {
    const observations: StallObservation[] = [];
    const result = await runScheduler(
      nodes([
        ["a", []],
        ["b", ["a"]],
        ["c", ["b"]],
      ]),
      async (node): Promise<NodeOutcome> =>
        node.id === "a" ? { status: "failed", error: "No enabled agent can serve capability x" } : { status: "completed" },
      baseHooks(observations)
    );
    expect(result.status).toBe("failed");
    expect(result.outcomes.get("b")).toEqual({ status: "failed", error: 'Dependency deadlock: waits on "a" (failed)' });
    expect(result.outcomes.get("c")).toEqual({ status: "failed", error: 'Dependency deadlock: waits on "b" (cancelled/blocked)' });
    const deadlocks = observations.filter((observation) => observation.kind === "dependency_deadlock");
    expect(deadlocks.map((observation) => [observation.nodeKey, observation.action, observation.detail?.dependencyState])).toEqual([
      ["b", "fail", "failed"],
      ["c", "fail", "cancelled"],
    ]);
  });

  it("dependency deadlock on a missing dependency names it", async () => {
    const observations: StallObservation[] = [];
    const result = await runScheduler(nodes([["b", ["ghost"]]]), async () => ({ status: "completed" }), baseHooks(observations));
    expect(result.outcomes.get("b")).toEqual({ status: "failed", error: 'Dependency deadlock: depends on "ghost", which does not exist' });
    expect(observations[0]).toMatchObject({ kind: "dependency_deadlock", nodeKey: "b", detail: { dependencyState: "missing" } });
  });

  it("no runnable nodes while nothing runs: validates the DAG and reports the cycle (never a generic timeout)", async () => {
    const observations: StallObservation[] = [];
    const result = await runScheduler(
      nodes([
        ["a", []],
        ["x", ["y"]],
        ["y", ["x"]],
        ["z", ["x"]],
      ]),
      async () => ({ status: "completed" }),
      baseHooks(observations)
    );
    expect(result.status).toBe("failed");
    const report = observations.find((observation) => observation.kind === "no_runnable_nodes");
    expect(report).toMatchObject({ action: "report" });
    expect(report?.reason).toMatch(/dependency cycle (x -> y -> x|y -> x -> y)/);
    expect(report?.detail?.pending).toEqual(["x", "y", "z"]);
    expect((result.outcomes.get("x") as { error: string }).error).toMatch(/^Dependency deadlock: dependency cycle/);
    expect((result.outcomes.get("z") as { error: string }).error).toBe('Dependency deadlock: waits on "x" (cyclic)');
    expect(result.outcomes.get("a")).toEqual({ status: "completed" });
  });

  it("agent stalled: no heartbeat within the threshold → retried once, then escalated", async () => {
    const observations: StallObservation[] = [];
    let attempts = 0;
    const result = await runScheduler(
      nodes([["slow", []]]),
      async (_node, signal) => {
        attempts += 1;
        // Never reports progress; ends only when aborted.
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return { status: "failed", error: "aborted" };
      },
      { ...baseHooks(observations), stallMs: 80, stallRetries: 1 }
    );
    expect(attempts).toBe(2);
    expect(result.status).toBe("failed");
    const error = (result.outcomes.get("slow") as { error: string }).error;
    expect(error).toMatch(/^Escalated \(agent_stalled\): Agent stalled: no output or heartbeat progress for 80ms on 2 attempt\(s\)/);
    expect(observations.filter((o) => o.kind === "agent_stalled").map((o) => o.action)).toEqual(["retry", "escalate"]);
  });

  it("agent with steady progress is not stalled even past the threshold", async () => {
    const observations: StallObservation[] = [];
    const result = await runScheduler(
      nodes([["busy", []]]),
      async (_node, _signal, info) => {
        for (let i = 0; i < 6; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          info.progress();
        }
        return { status: "completed" };
      },
      { ...baseHooks(observations), stallMs: 80 }
    );
    expect(result.status).toBe("completed");
    expect(observations).toEqual([]);
  });

  it("validateDag reports missing deps and a cycle", () => {
    expect(validateDag(nodes([["a", ["b"]], ["b", ["a"]], ["c", ["nope"]]]))).toEqual({
      cycle: ["a", "b", "a"],
      missing: [{ node: "c", dependency: "nope" }],
    });
  });
});

describe("Deadlock & stall detector — repeated output", () => {
  it("stops after N identical consecutive outputs; volatile ports/timings do not hide a repeat", () => {
    const guard = new RepeatedOutputGuard(2);
    expect(guard.observe("qa", "QA failed: console error at http://localhost:5173 after 120ms").repeated).toBe(false);
    const second = guard.observe("qa", "QA failed:  console error at http://localhost:5174 after 98ms");
    expect(second).toMatchObject({ repeated: true, count: 2 });
    expect(guard.observe("qa", "QA failed: a different error").count).toBe(1);
    expect(guard.observe("review", "x").count).toBe(1);
    expect(outputHash("A  b")).toBe(outputHash("a b"));
  });

  it("the fix-loop helper logs stall.repeated_output and returns the stop message", async () => {
    const logEvent = vi.fn(async () => undefined);
    const ctx = {
      repeatGuard: new RepeatedOutputGuard(2),
      deps: { api: { logEvent } },
      taskId: "t1",
      project: { _id: "p1" },
    } as unknown as Parameters<typeof repeatedOutputStop>[0];
    expect(await repeatedOutputStop(ctx, "verification", "typecheck: 3 errors")).toBeNull();
    const stop = await repeatedOutputStop(ctx, "verification", "typecheck: 3 errors");
    expect(stop).toMatch(/^Repeated output: the verification loop produced the same result on unchanged code 2 times/);
    // A fix that changed the staged code is progress, even with the same finding.
    const withState = { ...(ctx as object), repeatGuard: new RepeatedOutputGuard(2), state: { fileChanges: new Map([["a.ts", { filePath: "a.ts", changeType: "modified", newContent: "v1", diff: "" }]]) } } as unknown as Parameters<typeof repeatedOutputStop>[0] & { state: { fileChanges: Map<string, { filePath: string; changeType: string; newContent: string; diff: string }> } };
    expect(await repeatedOutputStop(withState, "review", "same finding")).toBeNull();
    withState.state.fileChanges.set("a.ts", { filePath: "a.ts", changeType: "modified", newContent: "v2", diff: "" });
    expect(await repeatedOutputStop(withState, "review", "same finding")).toBeNull();
    expect(await repeatedOutputStop(withState, "review", "same finding")).toMatch(/^Repeated output: the review loop/);
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "stall.repeated_output",
        payload: expect.objectContaining({ kind: "repeated_output", action: "stop_loop" }),
      })
    );
  });
});

describe("Deadlock & stall detector — provider unavailable", () => {
  const config = { provider: "openai-compatible", model: "m", baseUrl: "https://x", apiKey: "k" };
  const messages = [{ role: "user" as const, content: "hi" }];
  const handle = (id: string, complete: LLMProvider["complete"]): FallbackHandle => ({
    connectionId: id,
    connectionName: id,
    config,
    provider: { complete },
  });
  const httpError = (status: number) => Object.assign(new Error(`LLM request failed (${status}): x`), { status });

  it("classifies connection / 5xx / 429, and nothing else", () => {
    expect(classifyProviderError(httpError(429))).toBe("rate_limited");
    expect(classifyProviderError(httpError(503))).toBe("server_error");
    expect(classifyProviderError(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }))).toBe("connection");
    expect(classifyProviderError(new Error("fetch failed"))).toBe("connection");
    expect(classifyProviderError(httpError(400))).toBeNull();
    expect(classifyProviderError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBeNull();
  });

  it("switches to the fallback provider and emits a provider_unavailable observation", async () => {
    const observations: StallObservation[] = [];
    const result = await runWithObservationScope({ nodeKey: "n1", emit: (o) => observations.push(o) }, () =>
      runLlmCallWithFallback(
        [handle("primary", async () => { throw httpError(429); }), handle("backup", async () => ({ content: "ok" }))],
        messages,
        { retries: 0 }
      )
    );
    expect(result.servedBy.connectionId).toBe("backup");
    expect(observations).toEqual([
      expect.objectContaining({
        kind: "provider_unavailable",
        action: "fallback",
        nodeKey: "n1",
        detail: expect.objectContaining({ class: "rate_limited", provider: "primary", fallbackTo: "backup" }),
      }),
    ]);
  });

  it("fails clearly when no fallback provider is configured", async () => {
    const observations: StallObservation[] = [];
    await expect(
      runWithObservationScope({ emit: (o) => observations.push(o) }, () =>
        runLlmCallWithFallback([handle("only", async () => { throw httpError(503); })], messages, { retries: 0 })
      )
    ).rejects.toThrow(/LLM request failed \(503\).*provider unavailable \(server_error\): no fallback provider configured/);
    expect(observations[0]).toMatchObject({ kind: "provider_unavailable", action: "fail" });
  });
});

describe("Deadlock & stall detector — thresholds", () => {
  it("defaults and env overrides (clamped)", () => {
    expect(stallThresholdsFromEnv({}, 300_000)).toEqual({ agentStallMs: 360_000, agentStallRetries: 1, repeatedOutputLimit: 2 });
    expect(
      stallThresholdsFromEnv(
        { ORCHESTRATOR_STALL_TIMEOUT_MS: "120000", ORCHESTRATOR_STALL_RETRIES: "9", ORCHESTRATOR_REPEAT_OUTPUT_LIMIT: "3" },
        300_000
      )
    ).toEqual({ agentStallMs: 120_000, agentStallRetries: 3, repeatedOutputLimit: 3 });
    expect(stallThresholdsFromEnv({ ORCHESTRATOR_STALL_TIMEOUT_MS: "0" }).agentStallMs).toBe(0);
  });
});
