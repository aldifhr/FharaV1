import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chordConflicts,
  chordFromEvent,
  defaultKeybindings,
  formatChord,
  matchesChord,
  normalizeChord,
  parseKeybindings,
} from "../../lib/keybindings.ts";
import { suggestProjectPath } from "../../lib/uiPrefs.ts";

const key = (k, mods = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test("normalizeChord orders modifiers and uppercases the key", () => {
  assert.equal(normalizeChord("shift+mod+k"), "Mod+Shift+K");
  assert.equal(normalizeChord("Cmd+,"), "Mod+,");
  assert.equal(normalizeChord("Alt+Enter"), "Alt+Enter");
  assert.equal(normalizeChord("Mod+Shift"), null);
  assert.equal(normalizeChord("Hyper+K"), null);
  assert.equal(normalizeChord(""), null);
});

test("matchesChord accepts Cmd or Ctrl for Mod and is strict on the rest", () => {
  assert.equal(matchesChord(key("k", { metaKey: true }), "Mod+K"), true);
  assert.equal(matchesChord(key("k", { ctrlKey: true }), "Mod+K"), true);
  assert.equal(matchesChord(key("k"), "Mod+K"), false);
  assert.equal(matchesChord(key("k", { ctrlKey: true, shiftKey: true }), "Mod+K"), false);
  assert.equal(matchesChord(key("Enter", { altKey: true }), "Alt+Enter"), true);
  assert.equal(matchesChord(key("Enter"), "Alt+Enter"), false);
});

test("chordFromEvent ignores bare modifiers", () => {
  assert.equal(chordFromEvent(key("Shift", { shiftKey: true })), null);
  assert.equal(chordFromEvent(key("j", { ctrlKey: true, shiftKey: true })), "Mod+Shift+J");
});

test("parseKeybindings keeps valid overrides and drops junk", () => {
  const parsed = parseKeybindings(JSON.stringify({ commandMenu: "mod+p", composerBold: "Hyper+B", nope: "Mod+X" }));
  assert.equal(parsed.commandMenu, "Mod+P");
  assert.equal(parsed.composerBold, defaultKeybindings().composerBold);
  assert.deepEqual(parseKeybindings("{not json"), defaultKeybindings());
});

test("chordConflicts names the other actions on the same keys", () => {
  const bindings = { ...defaultKeybindings(), openSettings: "Mod+K" };
  assert.deepEqual(chordConflicts(bindings, "commandMenu", "Mod+K"), ["openSettings"]);
  assert.deepEqual(chordConflicts(defaultKeybindings(), "commandMenu", "Mod+K"), []);
});

test("formatChord shows Cmd symbols on macOS and Ctrl elsewhere", () => {
  assert.equal(formatChord("Mod+K", true), "⌘K");
  assert.equal(formatChord("Mod+K", false), "Ctrl+K");
  assert.equal(formatChord("Alt+Enter", true), "⌥Enter");
});

test("suggestProjectPath joins the folder and a slug of the name", () => {
  assert.equal(suggestProjectPath("/home/me/code/", "My App"), "/home/me/code/my-app");
  assert.equal(suggestProjectPath("C:\\code", "Fhara"), "C:\\code\\fhara");
  assert.equal(suggestProjectPath("", "x"), "");
  assert.equal(suggestProjectPath("/code", "  "), "");
});
