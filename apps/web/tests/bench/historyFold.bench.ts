// D12 performance gate: folding a long thread's history stays under budget.
// Runs with `npm run --workspace=@fhara/web bench` (node:test, no browser).
//
// Budgets are reviewed constants. Never raise one to make a run pass: find
// the regression instead. CI machines are slower and noisier, so CI uses the
// same constants times CI_SCALE. Each case takes the best of RUNS timings.
import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { mergeSequenced } from "../../../api/convex/lib/eventResume.ts";
import { HISTORY_PAGE_SIZE, mergeHistory } from "../../../api/convex/lib/historyPaging.ts";
import { groupActivity, groupByIndex } from "../../lib/activityGroups.ts";

const EVENT_COUNT = 5000;
const STREAM_BATCH = 100;
const RUNS = 5;
const CI_SCALE = process.env.CI ? 3 : 1;
/** Milliseconds, best of RUNS: about 5× the 2026-11-12 measurement (10 / 2 / 3 ms on a 2-core runner). */
const FOLD_BUDGET_MS = {
  /** 5k events arriving in windows of 100, merged by sequence as the live stream does. */
  eventStream: 50,
  /** 5k messages loaded as 25 "Load earlier" pages of 200, each merged with the live window. */
  historyPages: 15,
  /** 5k messages folded into activity groups for the thread. */
  activityGroups: 15,
} as const;

type Event = { _id: string; _creationTime: number; sequence: number; type: string; payload: Record<string, unknown> };
type Message = { _id: string; _creationTime: number; authorType: "user" | "agent"; agentId?: string; content: string; card?: { kind: string; data: any } };

function syntheticEvents(count: number): Event[] {
  const types = ["tool.started", "tool.completed", "agent.message", "subtask.routed", "file.changed"];
  return Array.from({ length: count }, (_, i) => ({
    _id: `event-${i + 1}`,
    _creationTime: 1_700_000_000_000 + i * 7,
    sequence: i + 1,
    type: types[i % types.length],
    payload: { subtaskKey: `step-${i % 40}`, text: `event ${i + 1}` },
  }));
}

function syntheticMessages(count: number): Message[] {
  const agents = ["agent-coder", "agent-reviewer", "agent-tester"];
  return Array.from({ length: count }, (_, i): Message => {
    const base = { _id: `message-${i + 1}`, _creationTime: 1_700_000_000_000 + i * 11 };
    if (i % 25 === 0) return { ...base, authorType: "user", content: `turn ${i / 25 + 1}: please continue` };
    const agentId = agents[Math.floor(i / 10) % agents.length];
    if (i % 5 === 1) return { ...base, authorType: "agent", agentId, content: "", card: { kind: "changes", data: { files: ["a.ts", "b.ts"] } } };
    if (i % 5 === 2) return { ...base, authorType: "agent", agentId, content: "Read 3 files" };
    if (i % 5 === 3)
      return { ...base, authorType: "agent", agentId, content: "", card: { kind: "verification", data: { outcome: "passed", checks: [{ name: "tsc", status: "passed" }] } } };
    return { ...base, authorType: "agent", agentId, content: `Reply ${i + 1} with some explanation of the change.` };
  });
}

function bestOf(run: () => number): number {
  let best = Infinity;
  for (let i = 0; i < RUNS; i++) {
    const started = performance.now();
    const size = run();
    const elapsed = performance.now() - started;
    assert.ok(size > 0);
    best = Math.min(best, elapsed);
  }
  return best;
}

function gate(name: keyof typeof FOLD_BUDGET_MS, ms: number) {
  const budget = FOLD_BUDGET_MS[name] * CI_SCALE;
  console.log(`  ${name}: ${ms.toFixed(1)} ms (budget ${budget} ms)`);
  assert.ok(ms <= budget, `${name} took ${ms.toFixed(1)} ms, over its ${budget} ms budget`);
}

test(`folding ${EVENT_COUNT} streamed events stays under budget`, () => {
  const events = syntheticEvents(EVENT_COUNT);
  let folded: Event[] = [];
  const ms = bestOf(() => {
    folded = [];
    for (let at = 0; at < events.length; at += STREAM_BATCH) folded = mergeSequenced(folded, events.slice(at, at + STREAM_BATCH));
    return folded.length;
  });
  assert.equal(folded.length, EVENT_COUNT);
  assert.equal(folded[0].sequence, 1);
  gate("eventStream", ms);
});

test(`folding ${EVENT_COUNT} messages from history pages stays under budget`, () => {
  const messages = syntheticMessages(EVENT_COUNT);
  const live = messages.slice(-HISTORY_PAGE_SIZE);
  let merged: Message[] = [];
  const ms = bestOf(() => {
    let earlier: Message[] = [];
    for (let end = messages.length - HISTORY_PAGE_SIZE; end > 0; end -= HISTORY_PAGE_SIZE) {
      earlier = [...messages.slice(Math.max(0, end - HISTORY_PAGE_SIZE), end), ...earlier];
      merged = mergeHistory(earlier, live);
    }
    return merged.length;
  });
  assert.equal(merged.length, EVENT_COUNT);
  assert.equal(merged[0]._id, "message-1");
  gate("historyPages", ms);
});

test(`grouping ${EVENT_COUNT} messages into activity rows stays under budget`, () => {
  const messages = syntheticMessages(EVENT_COUNT);
  let groups = 0;
  const ms = bestOf(() => {
    const index = groupByIndex(groupActivity(messages, { sameBlock: () => true, agentLabel: (id) => id }));
    groups = index.size;
    return messages.length;
  });
  assert.ok(groups > 0);
  gate("activityGroups", ms);
});
