import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runScheduler, type NodeOutcome, type SchedulerHooks, type SchedulerNode } from "@/scheduler/dagScheduler";

/**
 * P1b phase 4 (scheduler purification): golden traces of the scheduler's
 * retry / stall decisions, recorded with fake timers on the code BEFORE
 * the decisions moved into `orchestrator/decisionEngine/retry.ts`.
 *
 * Each trace is every hook call in order (with the fake clock), the
 * observations the stall watchdog reports and the final result, so a
 * change to a decision, its order, its backoff or a hook the scheduler
 * consults shows up as a snapshot diff under
 * tests/__golden__/decision-engine/scheduler-*.json.
 */

type Step = NodeOutcome | "hang" | "hang-forever";

interface Scenario {
  name: string;
  /** Node id → outcome per attempt (the last one repeats). */
  steps: Record<string, Step[]>;
  nodes?: SchedulerNode[];
  hooks?: Partial<SchedulerHooks>;
  /** Make shouldHaltNewNodes return true from the first settled outcome on. */
  haltAfterOutcome?: boolean;
  /** shouldRetryNode's answer (unset = no veto hook). */
  retryVeto?: boolean;
}

const failed = (error: string): NodeOutcome => ({ status: "failed", error });
const ok: NodeOutcome = { status: "completed", output: "ok" };

const SCENARIOS: Scenario[] = [
  { name: "scheduler-transient-retry-success", steps: { a: [failed("LLM request failed (503): upstream unavailable"), ok] } },
  { name: "scheduler-unknown-retry-success", steps: { a: [failed("transient boom"), failed("transient boom"), ok] }, retryVeto: true },
  { name: "scheduler-permanent-block", steps: { a: [failed("Refusing to modify protected path .env")] } },
  { name: "scheduler-llm-permanent-block", steps: { a: [failed("LLM request failed (400): bad request")] } },
  { name: "scheduler-escalation-block", steps: { a: [failed("Escalated (needs_decision): pick a database")] } },
  { name: "scheduler-retries-exhausted", steps: { a: [failed("transient boom")] } },
  { name: "scheduler-budget-veto", steps: { a: [failed("transient boom")] }, retryVeto: false },
  { name: "scheduler-halt-latched", steps: { a: [failed("Subtask timed out after 300000ms")] }, haltAfterOutcome: true, nodes: [{ id: "a", dependencies: [] }, { id: "b", dependencies: ["a"] }] },
  { name: "scheduler-stall-retry", steps: { a: ["hang", ok] } },
  { name: "scheduler-stall-escalate", steps: { a: ["hang"] } },
  { name: "scheduler-stall-veto-escalates", steps: { a: ["hang", ok] }, retryVeto: false },
  { name: "scheduler-stall-halt-escalates", steps: { a: ["hang", ok] }, haltAfterOutcome: true },
  { name: "scheduler-stall-uncertain", steps: { a: ["hang-forever"] } },
  { name: "scheduler-timeout-retry", steps: { a: ["hang", ok] }, hooks: { stallMs: 0, timeoutMs: 3_000 } },
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

async function run(s: Scenario): Promise<string> {
  const calls: unknown[] = [];
  const at = () => Date.now();
  const attempts = new Map<string, number>();
  let halt = false;
  const execute = (node: SchedulerNode, signal: AbortSignal): Promise<NodeOutcome> => {
    const attempt = attempts.get(node.id) ?? 0;
    attempts.set(node.id, attempt + 1);
    const list = s.steps[node.id] ?? [ok];
    const step = list[Math.min(attempt, list.length - 1)];
    calls.push({ at: at(), call: "execute", node: node.id, attempt: attempt + 1 });
    if (step === "hang") {
      // A real executor settles a little after the abort, never inside it.
      return new Promise((_, reject) => signal.addEventListener("abort", () => setTimeout(() => reject(new Error("aborted")), 10)));
    }
    if (step === "hang-forever") return new Promise(() => undefined);
    return Promise.resolve(step);
  };
  const promise = runScheduler(s.nodes ?? [{ id: "a", dependencies: [] }], execute, {
    maxConcurrency: 1,
    timeoutMs: 60_000,
    retries: 2,
    retryDelayMs: 100,
    stallMs: 1_000,
    stallRetries: 1,
    abortGraceMs: 500,
    shouldHaltNewNodes: () => {
      calls.push({ at: at(), call: "shouldHaltNewNodes", value: halt });
      return halt;
    },
    ...(s.retryVeto !== undefined
      ? {
          shouldRetryNode: (node: SchedulerNode, outcome: NodeOutcome, attempt: number) => {
            calls.push({ at: at(), call: "shouldRetryNode", node: node.id, attempt, error: outcome.status === "failed" ? outcome.error : null });
            return s.retryVeto!;
          },
        }
      : {}),
    onStart: async (node, attempt) => {
      calls.push({ at: at(), call: "onStart", node: node.id, attempt });
    },
    onOutcome: async (node, outcome, attempt) => {
      calls.push({ at: at(), call: "onOutcome", node: node.id, attempt, outcome });
      if (s.haltAfterOutcome) halt = true;
    },
    onBlocked: async (node, reason) => {
      calls.push({ at: at(), call: "onBlocked", node: node.id, reason });
    },
    onStall: async (observation) => {
      calls.push({ at: at(), call: "onStall", observation });
    },
    ...s.hooks,
  });
  await vi.advanceTimersByTimeAsync(120_000);
  const result = await promise;
  return JSON.stringify(
    {
      calls,
      result: {
        status: result.status,
        failed: result.failed,
        outcomes: Object.fromEntries([...result.outcomes.entries()].sort(([a], [b]) => a.localeCompare(b))),
      },
    },
    null,
    2
  );
}

describe("scheduler retry / stall decisions: golden traces (no behaviour change)", () => {
  for (const s of SCENARIOS) {
    it(s.name, async () => {
      const trace = await run(s);
      await expect(`${trace}\n`).toMatchFileSnapshot(`./__golden__/decision-engine/${s.name}.json`);
    });
  }
});
