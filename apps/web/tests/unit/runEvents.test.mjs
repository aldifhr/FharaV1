import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeRawEvents, oldestSequence, toRawEvent } from "../../lib/runEvents.ts";

const ev = (id, sequence) => ({ _id: id, sequence, type: "t", level: "info", message: null, subtaskKey: null, payload: null, createdAt: sequence ?? 0 });

test("a pageEarlier doc takes the Raw events shape", () => {
  const row = toRawEvent({ _id: "e1", _creationTime: 5, sequence: 3, type: "task.created", payload: { a: 1 } });
  assert.deepEqual(row, { _id: "e1", sequence: 3, type: "task.created", level: "info", message: null, subtaskKey: null, payload: '{"a":1}', createdAt: 5 });
  assert.equal(toRawEvent({ _id: "e2", _creationTime: 1, type: "x", payload: "y".repeat(3000) }).payload.length, 2001);
});

test("earlier pages merge before the live window without duplicates; the cursor is the lowest sequence", () => {
  const live = [ev("c", 3), ev("d", 4)];
  const merged = mergeRawEvents([ev("a", 1), ev("b", 2), ev("c", 3)], live);
  assert.deepEqual(merged.map((r) => r._id), ["a", "b", "c", "d"]);
  assert.equal(oldestSequence(merged), 1);
  assert.equal(oldestSequence([ev("z", null)]), null);
  assert.deepEqual(mergeRawEvents([ev("legacy", null)], live).map((r) => r._id), ["legacy", "c", "d"]);
  assert.equal(mergeRawEvents([], live), live);
});
