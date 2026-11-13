import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  REPLY_STOP_WINDOW_MS,
  TASK_STOP_CONFIRM,
  guardStop,
  inFlightReply,
  isReplySettled,
  isTaskStoppable,
  stopLabel,
} from "../../lib/stopControl.ts";

const now = 10_000_000;
const user = (id, replyStatus, at = now - 1_000, extra = {}) => ({ _id: id, _creationTime: at, authorType: "user", replyStatus, ...extra });
const agent = (id, replyTo, streaming, at = now - 500, extra = {}) => ({ _id: id, _creationTime: at, authorType: "agent", replyToMessageId: replyTo, streaming, ...extra });

test("chat Stop shows while the newest message's reply is pending or replying", () => {
  assert.equal(inFlightReply([user("u1", "pending")], now), "u1");
  assert.equal(inFlightReply([user("u1", "replying")], now), "u1");
  // A first teammate already answered; the turn is still replying.
  assert.equal(inFlightReply([user("u1", "replying"), agent("a1", "u1", false)], now), "u1");
});

test("chat Stop shows while a bubble streams, for the message it answers", () => {
  assert.equal(inFlightReply([user("u1", undefined), agent("a1", "u1", true)], now), "u1");
});

test("chat Stop hides once the reply settled, was stopped, or is stale", () => {
  for (const status of ["answered", "failed", "stopped", undefined]) {
    assert.equal(inFlightReply([user("u1", status), agent("a1", "u1", false)], now), null, String(status));
  }
  assert.equal(inFlightReply([user("u1", "replying", now - REPLY_STOP_WINDOW_MS - 1)], now), null);
  assert.equal(inFlightReply([user("u1", undefined), agent("a1", "u1", true, now, { interrupted: true })], now), null);
  assert.equal(inFlightReply([], now), null);
  // An optimistic row has no server id to stop yet.
  assert.equal(inFlightReply([user("optimistic:c1", "pending", now, { optimistic: true })], now), null);
  // An older message's dead reply never brings Stop back for a newer settled one.
  assert.equal(inFlightReply([user("u0", "replying"), user("u1", "answered")], now), null);
});

test("a stopped reply is settled (no typing ghost)", () => {
  assert.equal(isReplySettled("stopped"), true);
  assert.equal(isReplySettled("answered"), true);
  assert.equal(isReplySettled("failed"), true);
  assert.equal(isReplySettled("replying"), false);
  assert.equal(isReplySettled(undefined), false);
});

test("task Stop shows only while the task can still be stopped", () => {
  for (const status of ["queued", "running", "paused", "needs_approval", "waiting_input"]) {
    assert.equal(isTaskStoppable({ status }), true, status);
  }
  for (const status of ["done", "failed", "rejected", "cancelled", undefined]) {
    assert.equal(isTaskStoppable({ status }), false, String(status));
  }
  assert.equal(isTaskStoppable({ status: "waiting_input", mode: "direct" }), false);
  assert.equal(isTaskStoppable(null), false);
});

test("task Stop confirms in English with the stop icon", () => {
  assert.equal(TASK_STOP_CONFIRM.title, "Stop this task?");
  assert.equal(TASK_STOP_CONFIRM.confirmLabel, "Stop task");
  assert.equal(TASK_STOP_CONFIRM.icon, "stop");
  assert.equal(stopLabel(false), "Stop");
  assert.equal(stopLabel(true), "Stopping…");
});

test("a double press calls the stop once; the button is busy meanwhile", async () => {
  const calls = [];
  const busy = [];
  let release;
  const call = (args) => {
    calls.push(args);
    return new Promise((resolve) => (release = resolve));
  };
  const stop = guardStop(call, (b) => busy.push(b));
  const first = stop({ messageId: "u1" });
  assert.equal(await stop({ messageId: "u1" }), false);
  release();
  assert.equal(await first, true);
  assert.deepEqual(calls, [{ messageId: "u1" }]);
  assert.deepEqual(busy, [true, false]);
  // Free again after it settled; a failure frees it too and surfaces.
  const failing = guardStop(() => Promise.reject(new Error("nope")));
  await assert.rejects(failing({}), /nope/);
  await assert.rejects(failing({}), /nope/);
});

const read = (rel) => readFileSync(path.join(import.meta.dirname, "../..", rel), "utf8");

test("chat Stop calls chatReplies.stopReply with the in-flight user message; both chats pass it to the composer", () => {
  const hook = read("components/chat/useReplyStop.ts");
  assert.match(hook, /useMutation\(api\.chatReplies\.stopReply\)/);
  assert.match(hook, /stopReply\(\{ messageId: messageId as any \}\)/);
  assert.match(hook, /inFlightReply\(/);
  for (const panel of ["components/ChatPanel.tsx", "components/chat/PersonalChatPanel.tsx"]) {
    const src = read(panel);
    assert.match(src, /useReplyStop\(timeline\)/, panel);
    assert.match(src, /stop=\{replyStop\}/, panel);
  }
  const composer = read("components/chat/ChatComposer.tsx");
  assert.match(composer, /onClick=\{stop\.onStop\}/);
  assert.match(composer, /disabled=\{stop\.stopping\}/);
  assert.match(composer, /<Square /);
});

test("task Stop calls tasks.cancel behind ConfirmDialog, in the inspector header and the run page", () => {
  const button = read("components/TaskStopButton.tsx");
  assert.match(button, /useMutation\(api\.tasks\.cancel\)/);
  assert.match(button, /<ConfirmDialog/);
  assert.match(button, /TASK_STOP_CONFIRM/);
  assert.doesNotMatch(button, /window\.confirm|\bconfirm\(/);
  assert.match(button, /disabled=\{stopping\}/);
  assert.match(read("components/TaskThreadHeader.tsx"), /<TaskStopButton task=\{task\} \/>/);
  assert.match(read("app/runs/[taskId]/page.tsx"), /<TaskStopButton task=\{run\.task as any\} \/>/);
});
