// Threadbear T3: the direct-thread transcript reducer and the tail/page merge.
import test from "node:test";
import assert from "node:assert/strict";

import { reduceTranscript, turnRunning } from "../../lib/threadbear/reducer.ts";
import { DIRECT_TAIL_LIMIT, mergeTail, olderCursor, prependPage } from "../../lib/threadbear/transcriptMerge.ts";
import { turnFooterText } from "../../lib/threadbear/eventText.ts";
import { DIFF_PREVIEW_LINES, diffLines, diffStat, toolStatus, toolSubject } from "../../lib/threadbear/toolBody.ts";

let n = 0;
const ev = (type, payload = {}) => ({ sequence: ++n, type, payload });
const reset = () => (n = 0);

/** One recorded turn: message, reasoning, a tool with a card, a diff, the answer, the footer. */
function recordedTurn() {
  reset();
  return [
    ev("thread.created", { mode: "direct", role: "backend" }),
    ev("user.message", { text: "Fix the test", clientId: "c1" }),
    ev("turn.started", { turnId: "t1", messageSeq: 2 }),
    ev("reasoning", { itemId: "r1", text: "Look at the test first." }),
    ev("tool.call", { itemId: "k1", name: "bash", kind: "command", title: "Run tests", input: { command: "npm test" } }),
    ev("approval.requested", { approvalId: "a1", itemId: "k1", title: "npm test", input: "npm test", kind: "run_command", options: ["allow", "deny"] }),
    ev("approval.resolved", { approvalId: "a1", decision: "allow" }),
    ev("tool.result", { itemId: "k1", ok: false, text: "1 failing", truncated: false }),
    ev("edit.diff", { itemId: "d1", path: "src/a.ts", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }] }),
    ev("assistant.text", { itemId: "x1", text: "Fixed." }),
    ev("turn.completed", { turnId: "t1", outcome: "completed", durationMs: 72_000, usage: { inputTokens: 100, outputTokens: 20 } }),
  ];
}

test("a recorded turn becomes the expected rows (golden)", () => {
  const rows = reduceTranscript({ events: recordedTurn() });
  assert.deepEqual(
    rows.map((r) => r.kind),
    ["user", "reasoning", "tool", "approval", "diff", "assistant", "turn"],
  );
  const tool = rows.find((r) => r.kind === "tool");
  assert.equal(tool.result.ok, false);
  assert.equal(tool.turnId, "t1");
  assert.equal(toolSubject(tool), "npm test");
  assert.equal(rows.find((r) => r.kind === "approval").state, "allowed");
  const footer = rows.at(-1);
  assert.equal(footer.tokens, 120);
  assert.equal(turnFooterText(footer.outcome, footer.durationMs), "Worked for 1m 12s");
});

test("event order: shuffled and duplicated input gives the same rows", () => {
  const events = recordedTurn();
  const shuffled = [...events].reverse();
  shuffled.splice(3, 0, { ...events[4] }); // a duplicate of one sequence
  const a = reduceTranscript({ events });
  const b = reduceTranscript({ events: shuffled });
  assert.deepEqual(b, a);
  const seqs = a.map((r) => r.seq);
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));
});

test("approvals are never dropped", () => {
  reset();
  // The request fell outside the window: only the resolution is loaded.
  const lonely = reduceTranscript({ events: [ev("approval.resolved", { approvalId: "a9", decision: "cancelled", reason: "interrupt", message: "Stopped by the user." })] });
  assert.equal(lonely.length, 1);
  assert.equal(lonely[0].kind, "approval");
  assert.equal(lonely[0].state, "cancelled");
  assert.equal(lonely[0].message, "Stopped by the user.");

  // A pending card older than the live window comes from the pending list.
  reset();
  const tail = [ev("assistant.text", { itemId: "x", text: "Waiting." })];
  const pendingCards = [
    { _id: "a1", kind: "run_unconfined", summary: "Run make", status: "pending", payload: { title: "make", input: "make all", reason: "sandbox refused" } },
    { _id: "a2", kind: "run_command", summary: "old", status: "approved", payload: {} },
  ];
  const rows = reduceTranscript({ events: tail, pendingCards });
  const cards = rows.filter((r) => r.kind === "approval");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].approvalKind, "run_unconfined");
  assert.equal(cards[0].state, "pending");
  assert.equal(rows[0].kind, "approval", "an out-of-window card sorts before the window");

  // The same card in the window and in the pending list shows once.
  reset();
  const both = reduceTranscript({
    events: [ev("approval.requested", { approvalId: "a1", title: "make", input: "make all", kind: "run_unconfined" })],
    pendingCards,
  });
  assert.equal(both.filter((r) => r.kind === "approval").length, 1);

  // Every request and resolution in a long run keeps its card.
  reset();
  const many = [];
  for (let i = 0; i < 30; i++) {
    many.push(ev("approval.requested", { approvalId: `c${i}`, title: `cmd ${i}`, input: "x", kind: "tool_call" }));
    if (i % 3) many.push(ev("approval.resolved", { approvalId: `c${i}`, decision: i % 2 ? "allow" : "deny" }));
  }
  const cardRows = reduceTranscript({ events: many }).filter((r) => r.kind === "approval");
  assert.equal(cardRows.length, 30);
  assert.equal(cardRows.filter((r) => r.state === "pending").length, 10);
});

test("question cards: open, re-shown for the user, answered", () => {
  reset();
  const asked = ev("approval.requested", { kind: "question", questionId: "q1", itemId: "i1", question: "Which DB?", options: ["Postgres", "SQLite"], answerer: "cto" });
  const reshown = ev("approval.requested", { kind: "question", questionId: "q1", itemId: "i1", question: "Which DB?", options: ["Postgres", "SQLite"], answerer: "user", reason: "The CTO handed this to the user" });
  let rows = reduceTranscript({ events: [asked, reshown] });
  const q = rows.filter((r) => r.kind === "question");
  assert.equal(q.length, 1);
  assert.equal(q[0].answerer, "user");
  assert.equal(q[0].state, "open");
  assert.deepEqual(q[0].options, ["Postgres", "SQLite"]);
  const answered = ev("approval.resolved", { kind: "question", questionId: "q1", itemId: "i1", decision: "answered", answer: "SQLite", by: "user" });
  rows = reduceTranscript({ events: [asked, reshown, answered] });
  const done = rows.find((r) => r.kind === "question");
  assert.equal(done.state, "answered");
  assert.equal(done.answer, "SQLite");
});

test("newest text is visible: a hot stream shows until its item is persisted", () => {
  reset();
  const events = [ev("user.message", { text: "hi", clientId: "c1" }), ev("turn.started", { turnId: "t1" })];
  const streams = [{ itemId: "x1", kind: "text", text: "Hel", seq: 2 }];
  let rows = reduceTranscript({ events, streams });
  assert.equal(rows.at(-1).kind, "assistant");
  assert.equal(rows.at(-1).text, "Hel");
  assert.equal(rows.at(-1).streaming, true);
  assert.equal(turnRunning(events), true);

  // Persisted: the stored text replaces the stream (one row, not two).
  const persisted = [...events, ev("assistant.text", { itemId: "x1", text: "Hello there." })];
  rows = reduceTranscript({ events: persisted, streams });
  const texts = rows.filter((r) => r.kind === "assistant");
  assert.equal(texts.length, 1);
  assert.equal(texts[0].text, "Hello there.");
  assert.equal(texts[0].streaming, undefined);

  // A second item still streaming comes after the persisted one.
  rows = reduceTranscript({ events: persisted, streams: [...streams, { itemId: "x2", kind: "text", text: "More", seq: 3 }] });
  assert.equal(rows.at(-1).text, "More");
});

test("tool output streams onto its running tool row", () => {
  reset();
  const events = [ev("turn.started", { turnId: "t" }), ev("tool.call", { itemId: "k", name: "bash", kind: "command", title: "Build", input: { argv: ["npm", "run", "build"] } })];
  const rows = reduceTranscript({ events, streams: [{ itemId: "k", kind: "output", text: "compiling…", seq: 2 }] });
  const tool = rows.find((r) => r.kind === "tool");
  assert.equal(tool.liveOutput, "compiling…");
  assert.equal(toolSubject(tool), "npm run build");
  assert.equal(toolStatus(tool, true), "running");
  assert.equal(toolStatus(tool, false), "interrupted");
});

test("optimistic messages show until the tail returns them; steers get a receipt", () => {
  reset();
  const events = [ev("user.message", { text: "one", clientId: "c1" }), ev("turn.started", { turnId: "t" }), ev("user.message", { text: "two", clientId: "c2" })];
  events.push(ev("turn.steered", { turnId: "t", messageSeq: 3 }));
  const rows = reduceTranscript({ events, optimistic: [{ clientId: "c2", text: "two" }, { clientId: "c3", text: "three" }] });
  const users = rows.filter((r) => r.kind === "user");
  assert.deepEqual(users.map((u) => u.text), ["one", "two", "three"]);
  assert.equal(users[1].steered, true);
  assert.equal(users[2].sending, true);
  assert.equal(rows.at(-1).text, "three");
});

test("notes: goal changes, system notes; session.restore is silent", () => {
  reset();
  const rows = reduceTranscript({
    events: [
      ev("session.restore", { op: "load" }),
      ev("goal.updated", { action: "set", by: "user", objective: "Green CI", round: 0, maxRounds: 5 }),
      ev("goal.prompt", { kind: "round", round: 1, text: "…" }),
      ev("system.note", { text: "Stopped. 1 queued message(s) were not sent." }),
      ev("goal.updated", { action: "blocked", by: "agent", round: 5, maxRounds: 5, blockedReason: { code: "round-limit", message: "Out of rounds" } }),
    ],
  });
  assert.deepEqual(rows.map((r) => r.text), ["Goal set: Green CI", "Goal round 1", "Stopped. 1 queued message(s) were not sent.", "Goal blocked: Out of rounds (round 5/5)"]);
  assert.equal(rows.at(-1).tone, "danger");
});

test("turn footer wording", () => {
  assert.equal(turnFooterText("interrupted", 8000), "Stopped after 8s");
  assert.equal(turnFooterText("failed", 3000, "Budget: spent"), "Failed after 3s: Budget: spent");
  assert.equal(turnFooterText("timed_out", 3_723_000), "Timed out after 1h 2m");
});

test("tail merge: keeps scrolled rows, resets on a gap, reads at most 80 live", () => {
  assert.equal(DIRECT_TAIL_LIMIT, 80);
  const thread = Array.from({ length: 1000 }, (_, i) => ({ sequence: i + 1, type: "system.note", payload: { text: `n${i + 1}` } }));
  // Open: only the newest window is live.
  let held = mergeTail([], thread.slice(-DIRECT_TAIL_LIMIT)).events;
  assert.equal(held.length, 80);
  assert.equal(olderCursor(held), 921);
  // Load earlier, then the tail moves on by 5: the scrolled page stays.
  held = prependPage(held, thread.slice(820, 920));
  assert.equal(held[0].sequence, 821);
  const next = [...thread, ...Array.from({ length: 5 }, (_, i) => ({ sequence: 1001 + i, type: "system.note", payload: {} }))];
  const moved = mergeTail(held, next.slice(-DIRECT_TAIL_LIMIT));
  assert.equal(moved.reset, false);
  assert.equal(moved.events[0].sequence, 821);
  assert.equal(moved.events.at(-1).sequence, 1005);
  // A gap (missed more than a window): start again from the tail.
  const far = Array.from({ length: 80 }, (_, i) => ({ sequence: 2000 + i, type: "system.note", payload: {} }));
  const gap = mergeTail(moved.events, far);
  assert.equal(gap.reset, true);
  assert.equal(gap.events.length, 80);
  // A page that does not reach what we hold is ignored; the first event ends paging.
  assert.equal(prependPage(far, thread.slice(0, 10)).length, 80);
  assert.equal(olderCursor(thread.slice(0, 5)), null);
});

test("diff preview helpers", () => {
  const hunks = [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [" a", "-b", "+c", "+d"] }];
  assert.deepEqual(diffStat(hunks), { added: 2, removed: 1 });
  const lines = diffLines(hunks);
  assert.equal(lines[0].tag, "@");
  assert.deepEqual(lines.slice(1).map((l) => l.tag), [" ", "-", "+", "+"]);
  assert.equal(DIFF_PREVIEW_LINES, 12);
});
