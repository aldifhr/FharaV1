// Dashboard F4: the dirty-state helpers behind useInspectorDraft and the footer label.
import test from "node:test";
import assert from "node:assert/strict";

import { changedKeys, editedLabel, sameValue } from "../../lib/inspectorDraft.ts";

test("draft values compare by content", () => {
  assert.equal(sameValue(["a", "b"], ["a", "b"]), true);
  assert.equal(sameValue(["a", "b"], ["b", "a"]), false);
  assert.equal(sameValue({ x: 1 }, { x: 1 }), true);
  // a pin cleared back to Latest (undefined) equals a missing pin
  assert.equal(sameValue({ s1: undefined }, {}), true);
  assert.equal(sameValue(null, {}), false);
  assert.equal(sameValue("", null), false);
});

test("changedKeys lists only edited fields", () => {
  const saved = { name: "Ada", tools: ["read"], pins: { s1: 2 } };
  assert.deepEqual(changedKeys(saved, { ...saved }), []);
  assert.deepEqual(changedKeys(saved, { ...saved, tools: ["read", "write"] }), ["tools"]);
  assert.deepEqual(changedKeys(saved, { ...saved, name: "Bea", pins: {} }), ["name", "pins"]);
});

test("edited label", () => {
  assert.equal(editedLabel(null, 0), null);
  assert.equal(editedLabel(1_000, 10_000), "Edited just now");
  assert.equal(editedLabel(0, 5 * 60_000), "Edited 5 min ago");
  assert.equal(editedLabel(0, 3 * 3_600_000), "Edited 3 h ago");
});
