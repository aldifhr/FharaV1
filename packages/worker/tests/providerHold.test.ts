import { describe, expect, it, vi } from "vitest";
import { failTaskWithError } from "@/services/runner/terminal";

/** O3 + L7: the worker's failure path logs a provider hold instead of a failure. */
function deps() {
  const events: any[] = [];
  const completed: any[] = [];
  const lifecycle: any[] = [];
  const api = {
    logEvent: vi.fn(async (input: any) => {
      events.push(input);
    }),
    completeTask: vi.fn(async (input: any) => {
      completed.push(input);
      return { applied: true, status: "paused", held: true };
    }),
    recordLifecycle: vi.fn(async (input: any) => {
      lifecycle.push(input);
    }),
  };
  return { deps: { api } as any, events, completed, lifecycle };
}

describe("failTaskWithError and provider holds", () => {
  it("a 429 from the LLM is reported as a hold: no task.error, no FAILED transition", async () => {
    const h = deps();
    const message = 'LLM request failed (429) for model "m" at https://p/v1/chat/completions: rate limit';
    await failTaskWithError({ deps: h.deps, taskId: "t1", projectId: "p1", message });
    expect(h.events.map((e) => e.type)).toEqual(["llm.provider_hold"]);
    expect(h.events[0].payload).toMatchObject({ kind: "rate_limit" });
    expect(h.lifecycle).toHaveLength(0);
    // The backend's completeTask turns this into the hold (paused, pausedBy "held").
    expect(h.completed).toEqual([{ taskId: "t1", status: "failed", errorMessage: message }]);
  });

  it("an offline provider (circuit breaker) is a hold too", async () => {
    const h = deps();
    await failTaskWithError({
      deps: h.deps,
      taskId: "t1",
      projectId: "p1",
      message: "No LLM provider available: every candidate connection is temporarily excluded by the circuit breaker after repeated transient failures. Candidates: a.",
    });
    expect(h.events[0]).toMatchObject({ type: "llm.provider_hold", payload: { kind: "offline" } });
  });

  it("an ordinary failure keeps the failure path", async () => {
    const h = deps();
    await failTaskWithError({ deps: h.deps, taskId: "t1", projectId: "p1", message: "Verification failed: 2 tests" });
    expect(h.events.map((e) => e.type)).toEqual(["task.error"]);
    expect(h.lifecycle).toEqual([expect.objectContaining({ state: "FAILED" })]);
  });
});
