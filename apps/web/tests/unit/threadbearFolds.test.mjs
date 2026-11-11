// Threadbear N8: the direct transcript folds (activity, turn), repeated failures,
// the retry prompt, and the interruption wording of a tool that never finished.
import test from "node:test";
import assert from "node:assert/strict";

import { reduceTranscript } from "../../lib/threadbear/reducer.ts";
import { foldActivity, presentedRows } from "../../lib/threadbear/activityFold.ts";
import { presentTranscript, turnFoldSplit } from "../../lib/threadbear/turnFold.ts";
import { collapseRepeatedFailures, retryablePrompt } from "../../lib/threadbear/repeatedFailures.ts";
import { INCOMPLETE_TOOL_TEXT, INTERRUPTED_TOOL_TEXT, STOPPED_TOOL_TEXT, toolInterruption } from "../../lib/threadbear/toolBody.ts";

let n = 0;
const ev = (type, payload = {}) => ({ sequence: ++n, type, payload });
const reset = () => (n = 0);
const rowsOf = (events, extra = {}) => reduceTranscript({ events, ...extra });
const folded = (items) => items.flatMap((i) => (i.kind === "fold" ? i.rows : []));
const visible = (items) => items.flatMap((i) => (i.kind === "row" ? [i.row] : []));
const tool = (id, ok = true, input = { command: "ls" }) => [
  ev("tool.call", { itemId: id, name: "bash", kind: "command", title: "Run", input }),
  ...(ok === null ? [] : [ev("tool.result", { itemId: id, ok, text: ok ? "fine" : "boom" })]),
];

/** A clean finished turn: reasoning, two good tools, commentary, the answer, the footer. */
function cleanTurn() {
  reset();
  return [
    ev("user.message", { text: "Tidy the repo" }),
    ev("turn.started", { turnId: "t1" }),
    ev("reasoning", { itemId: "r1", text: "Look first." }),
    ...tool("k1"),
    ev("assistant.text", { itemId: "x1", text: "Found two stale files." }),
    ...tool("k2"),
    ev("assistant.text", { itemId: "x2", text: "Done: removed both." }),
    ev("turn.completed", { turnId: "t1", outcome: "completed", durationMs: 9_000 }),
  ];
}

test("a clean finished turn folds down to its answer and footer", () => {
  const rows = rowsOf(cleanTurn());
  const items = presentTranscript(rows);
  assert.deepEqual(items.map((i) => (i.kind === "row" ? i.row.kind : `fold:${i.fold}`)), ["user", "fold:turn", "assistant", "turn"]);
  const answer = items[2].row;
  assert.equal(answer.text, "Done: removed both.");
  assert.equal(items[1].durationMs, 9_000);
  assert.deepEqual(presentedRows(items), rows, "folding only moves rows, it never drops or edits one");
});

test("a turn with a failed tool or a card does not fold whole; the failure and the card stay rows", () => {
  reset();
  const events = [
    ev("user.message", { text: "Fix the test" }),
    ev("turn.started", { turnId: "t1" }),
    ev("reasoning", { itemId: "r1", text: "Run it." }),
    ...tool("k1"),
    ...tool("k2"),
    ev("tool.call", { itemId: "k3", name: "bash", kind: "command", title: "npm test", input: { command: "npm test" } }),
    ev("approval.requested", { approvalId: "a1", itemId: "k3", title: "npm test", input: "npm test", kind: "run_command" }),
    ev("approval.resolved", { approvalId: "a1", decision: "allow" }),
    ev("tool.result", { itemId: "k3", ok: false, text: "1 failing" }),
    ...tool("k4"),
    ...tool("k5"),
    ev("assistant.text", { itemId: "x1", text: "One test still fails." }),
    ev("turn.completed", { turnId: "t1", outcome: "completed", durationMs: 4_000 }),
  ];
  const rows = rowsOf(events);
  assert.equal(turnFoldSplit(rows.slice(1)), -1);
  const items = presentTranscript(rows);
  const hidden = folded(items);
  assert.ok(!hidden.some((r) => r.kind === "approval"), "the card is never folded");
  assert.ok(!hidden.some((r) => r.kind === "tool" && !r.result?.ok), "the failure is never folded");
  assert.ok(visible(items).some((r) => r.kind === "approval"));
  assert.ok(visible(items).some((r) => r.kind === "tool" && r.itemId === "k3"));
  // Routine work around them still folds into Activity rows.
  assert.ok(items.some((i) => i.kind === "fold" && i.fold === "activity"));
});

test("a live turn keeps its newest text and newest row visible; earlier commentary folds", () => {
  reset();
  const events = [
    ev("user.message", { text: "Go" }),
    ev("turn.started", { turnId: "t1" }),
    ev("assistant.text", { itemId: "x1", text: "Starting." }),
    ...tool("k1"),
    ev("assistant.text", { itemId: "x2", text: "Halfway." }),
    ...tool("k2"),
    ...tool("k3"),
  ];
  const rows = rowsOf(events, { streams: [{ itemId: "x3", kind: "text", text: "Almost", seq: 1 }] });
  const items = presentTranscript(rows);
  const shown = visible(items);
  assert.equal(shown.at(-1).kind, "assistant");
  assert.equal(shown.at(-1).text, "Almost", "the streaming text is the newest text and stays visible");
  assert.ok(folded(items).some((r) => r.kind === "assistant" && r.text === "Starting."));
  // Without the stream, the newest persisted text stays out of the fold.
  const quiet = presentTranscript(rowsOf(events));
  assert.ok(visible(quiet).some((r) => r.kind === "assistant" && r.text === "Halfway."));
  assert.equal(visible(quiet).at(-1).kind, "tool", "the newest row of all stays visible");
});

test("fold rules hold on random transcripts: no failure or card folded, newest text visible", () => {
  let seed = 7;
  const rand = (k) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % k);
  for (let round = 0; round < 300; round++) {
    reset();
    const events = [];
    let turn = 0;
    const steps = 3 + rand(25);
    for (let s = 0; s < steps; s++) {
      const pick = rand(9);
      const id = `i${s}`;
      if (pick === 0) {
        events.push(ev("user.message", { text: `m${s}` }), ev("turn.started", { turnId: `t${++turn}` }));
      } else if (pick === 1) events.push(ev("reasoning", { itemId: id, text: "hm" }));
      else if (pick === 2) events.push(ev("assistant.text", { itemId: id, text: `say ${s}` }));
      else if (pick === 3) events.push(...tool(id, true));
      else if (pick === 4) events.push(...tool(id, false));
      else if (pick === 5) events.push(...tool(id, null));
      else if (pick === 6) events.push(ev("approval.requested", { approvalId: id, title: "x", input: "x", kind: "run_command" }));
      else if (pick === 7) events.push(ev("approval.requested", { kind: "question", questionId: id, question: "Which?", options: ["a", "b"] }));
      else events.push(ev("turn.completed", { turnId: `t${turn}`, outcome: ["completed", "failed", "interrupted"][rand(3)], durationMs: 1000 }));
    }
    const rows = rowsOf(events);
    for (const items of [presentTranscript(rows), foldActivity(rows)]) {
      assert.deepEqual(presentedRows(items), rows);
      for (const r of folded(items)) {
        assert.ok(r.kind !== "approval" && r.kind !== "question", "a card is never folded");
        assert.ok(!(r.kind === "tool" && !r.result?.ok), "a failed or unfinished tool is never folded");
        assert.ok(!(r.kind === "turn"), "a footer is never folded");
      }
      const texts = rows.filter((r) => r.kind === "assistant" && r.text.trim());
      if (texts.length) assert.ok(visible(items).includes(texts.at(-1)), "the newest text is visible");
      if (rows.length) assert.ok(visible(items).includes(rows.at(-1)), "the newest row is visible");
    }
  }
});

test("identical failure-only turns collapse to the latest with a count; every message stays", () => {
  reset();
  const fail = (error) => ev("turn.completed", { outcome: "failed", durationMs: 1000, error });
  const events = [
    ev("user.message", { text: "one" }), fail("Out of credits"),
    ev("user.message", { text: "two" }), fail("Out of credits"),
    ev("user.message", { text: "three" }), fail("Out of credits"),
    ev("user.message", { text: "four" }), fail("Signed out"),
  ];
  const out = collapseRepeatedFailures(rowsOf(events));
  assert.deepEqual(out.map((r) => r.kind), ["user", "user", "user", "turn", "user", "turn"]);
  assert.equal(out[3].repeats, 3);
  assert.equal(out[3].error, "Out of credits");
  assert.equal(out[5].repeats, undefined);
});

test("a turn that did work ends a run of repeated failures", () => {
  reset();
  const events = [
    ev("user.message", { text: "one" }), ev("turn.completed", { outcome: "failed", durationMs: 1, error: "E" }),
    ev("user.message", { text: "two" }), ev("assistant.text", { itemId: "x", text: "hi" }), ev("turn.completed", { outcome: "failed", durationMs: 1, error: "E" }),
    ev("user.message", { text: "three" }), ev("turn.completed", { outcome: "failed", durationMs: 1, error: "E" }),
  ];
  const out = collapseRepeatedFailures(rowsOf(events));
  assert.equal(out.filter((r) => r.kind === "turn").length, 3);
  assert.ok(out.every((r) => r.repeats === undefined));
});

test("Retry last prompt offers the prompt behind the newest failed turn only", () => {
  reset();
  const failed = rowsOf([ev("user.message", { text: "Build it" }), ...tool("k1"), ev("turn.completed", { outcome: "timed_out", durationMs: 1 })]);
  assert.equal(retryablePrompt(failed, false), "Build it");
  assert.equal(retryablePrompt(failed, true), null, "not while a turn runs");
  reset();
  assert.equal(retryablePrompt(rowsOf([ev("user.message", { text: "Go" }), ev("turn.completed", { outcome: "interrupted", durationMs: 1 })]), false), null, "not a stopped turn");
  reset();
  assert.equal(retryablePrompt(rowsOf([ev("user.message", { text: "/goal ship" }), ev("turn.completed", { outcome: "failed", durationMs: 1 })]), false), null, "not a slash command");
  reset();
  assert.equal(retryablePrompt(rowsOf([ev("user.message", { text: "Go" }), ev("turn.completed", { outcome: "completed", durationMs: 1 })]), false), null);
});

test("interruption wording tells stopped, interrupted and never-written calls apart", () => {
  const started = { input: { command: "npm test" } };
  assert.equal(toolInterruption(started, true), null, "a running tool says nothing");
  assert.equal(toolInterruption({ ...started, result: { ok: false } }, false), null, "a tool with a result says nothing");
  assert.equal(toolInterruption(started, false, "interrupted").text, STOPPED_TOOL_TEXT);
  assert.equal(toolInterruption(started, false, "failed").text, INTERRUPTED_TOOL_TEXT);
  assert.equal(toolInterruption({ input: {} }, false, "timed_out").text, INCOMPLETE_TOOL_TEXT);
  assert.equal(toolInterruption({ input: {}, liveOutput: "partial" }, false).text, INTERRUPTED_TOOL_TEXT);
});
