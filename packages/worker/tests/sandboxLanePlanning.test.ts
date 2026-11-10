import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { markProgress } from "@/effects/observationContext";

/**
 * Live test 3: a 5-8 min replan was killed as "Task idle exceeded" because
 * only subtasks bumped the task idle watchdog. requestPlan keeps it alive
 * while the planner is in flight and on every LLM call start/finish.
 */
const plannerCall = vi.hoisted(() => ({ impl: async (): Promise<unknown> => ({ plan: null }) }));
vi.mock("@/orchestrator/orchestrator", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createAuthoritativePlan: () => plannerCall.impl() };
});

import { requestPlan, PLANNING_KEEPALIVE_MS } from "@/services/runner/planning";

afterEach(() => vi.useRealTimers());

describe("requestPlan keeps the task idle watchdog alive", () => {
  it("bumps on start, while in flight, on every LLM call, and at the end", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
    const bump = vi.fn();
    const dir = mkdtempSync(path.join(tmpdir(), "fhara-plan-"));
    plannerCall.impl = async () => {
      markProgress(); // runLlmCallWithFallback marks progress on call start
      await new Promise((resolve) => setTimeout(resolve, PLANNING_KEEPALIVE_MS * 3 + 1));
      markProgress(); // ...and on finish
      return { plan: null };
    };
    const pctx = {
      deps: { api: {}, policy: { planningStallMs: 12 * 60_000 }, workspaceRoot: "/tmp" },
      task: { _id: "t1", title: "t", command: "jalankan tes" },
      project: { _id: "p1", workspacePath: dir },
      signal: new AbortController().signal,
      agents: [],
      classification: { kind: "command" },
      bump,
    } as never;
    let settled = false;
    const running = requestPlan(pctx, { stage: "replanning" }).finally(() => {
      settled = true;
    });
    // Real fs reads (workspace layout) run before the planner call starts:
    // advance in steps until the call settles.
    for (let i = 0; i < 400 && !settled; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      await new Promise((resolve) => setImmediate(resolve));
    }
    await running;
    // start + 3 keep-alives + 2 LLM call boundaries + end
    expect(bump.mock.calls.length).toBeGreaterThanOrEqual(7);
  });
});
