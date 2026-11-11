// Threadbear N8: approve / deny / option hotkeys for the card waiting on the user.
import test from "node:test";
import assert from "node:assert/strict";

import { chordConflicts, decisionKey, defaultKeybindings, focusedBoxHasText, KEYBINDING_ACTIONS } from "../../lib/keybindings.ts";

const bindings = defaultKeybindings();
const key = (k, mods = {}) => ({ key: k, code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
const mac = { typing: false, mac: true };
const pc = { typing: false, mac: false };

test("⌘↵ allows and ⌘⌫ denies when no box holds text", () => {
  assert.deepEqual(decisionKey(key("Enter", { metaKey: true }), bindings, mac), { kind: "approve" });
  assert.deepEqual(decisionKey(key("Backspace", { metaKey: true }), bindings, mac), { kind: "deny" });
  assert.deepEqual(decisionKey(key("Enter", { ctrlKey: true }), bindings, pc), { kind: "approve" });
  assert.deepEqual(decisionKey(key("Backspace", { ctrlKey: true }), bindings, pc), { kind: "deny" });
});

test("⌘⌫ in a non-empty box still deletes (no decision)", () => {
  assert.equal(decisionKey(key("Backspace", { metaKey: true }), bindings, { typing: true, mac: true }), null);
  assert.equal(decisionKey(key("Backspace", { ctrlKey: true }), bindings, { typing: true, mac: false }), null);
  // ⌘↵ in a box with text stays the composer's.
  assert.equal(decisionKey(key("Enter", { metaKey: true }), bindings, { typing: true, mac: true }), null);
});

test("plain keys, Shift and composition never decide", () => {
  assert.equal(decisionKey(key("Enter"), bindings, mac), null);
  assert.equal(decisionKey(key("Backspace"), bindings, mac), null);
  assert.equal(decisionKey(key("Enter", { metaKey: true, shiftKey: true }), bindings, mac), null);
  assert.equal(decisionKey({ ...key("Enter", { metaKey: true }), isComposing: true }, bindings, mac), null);
});

test("⌥⌘1–9 picks an option by the physical key; AltGr text off macOS is left alone", () => {
  // macOS: ⌥ turns "3" into "£", the code still reads Digit3.
  assert.deepEqual(decisionKey(key("£", { code: "Digit3", metaKey: true, altKey: true }), bindings, mac), { kind: "option", index: 2 });
  assert.deepEqual(decisionKey(key("1", { code: "Digit1", ctrlKey: true, altKey: true }), bindings, pc), { kind: "option", index: 0 });
  assert.equal(decisionKey(key("³", { code: "Digit3", ctrlKey: true, altKey: true }), bindings, pc), null, "AltGr+3 types ³");
  assert.equal(decisionKey(key("0", { code: "Digit0", metaKey: true, altKey: true }), bindings, mac), null);
  assert.equal(decisionKey(key("3", { code: "Digit3", metaKey: true }), bindings, mac), null, "⌘3 without ⌥ is not an option");
  assert.deepEqual(decisionKey(key("£", { code: "Digit3", metaKey: true, altKey: true }), bindings, { typing: true, mac: true }), { kind: "option", index: 2 });
});

test("the new actions are registered and clash with no default", () => {
  for (const id of ["approveCard", "denyCard", "pickOption"]) {
    assert.ok(KEYBINDING_ACTIONS.some((a) => a.id === id));
    assert.deepEqual(chordConflicts(bindings, id, bindings[id]), []);
  }
});

test("a rebound approve chord is honoured", () => {
  const custom = { ...bindings, approveCard: "Alt+Enter" };
  assert.deepEqual(decisionKey(key("Enter", { altKey: true }), custom, mac), { kind: "approve" });
  assert.equal(decisionKey(key("Enter", { metaKey: true }), custom, mac), null);
});

test("focusedBoxHasText is false with nothing focused (node has no DOM)", () => {
  assert.equal(focusedBoxHasText(null), false);
});
