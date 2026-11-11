import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RENAME_TITLE_MAX,
  isRenameKey,
  normaliseRenameTitle,
  renameDraft,
  renameRefOf,
  withRenamedRow,
} from "../../lib/threadRename.ts";

const key = (k, mods = {}) => ({ key: k, altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, ...mods });

test("empty and whitespace titles are refused", () => {
  assert.deepEqual(renameDraft("", "Old"), { kind: "empty" });
  assert.deepEqual(renameDraft("   \t\n ", "Old"), { kind: "empty" });
});

test("a new title is normalised like the server does", () => {
  assert.deepEqual(renameDraft("  Fix   the\tauth  bug ", "Old"), { kind: "save", title: "Fix the auth bug" });
  assert.equal(normaliseRenameTitle("x".repeat(RENAME_TITLE_MAX + 50)).length, RENAME_TITLE_MAX);
});

test("the same title (after normalising) saves nothing", () => {
  assert.deepEqual(renameDraft(" Old ", "Old"), { kind: "unchanged" });
  assert.deepEqual(renameDraft("Old  title", "Old title"), { kind: "unchanged" });
});

test("renameRefOf prefers the task, then the conversation", () => {
  assert.deepEqual(renameRefOf({ taskId: "t1", conversationId: "c1" }), { taskId: "t1" });
  assert.deepEqual(renameRefOf({ taskId: null, conversationId: "c1" }), { conversationId: "c1" });
  assert.equal(renameRefOf({ taskId: null, conversationId: null }), null);
});

test("withRenamedRow replaces only the matching thread", () => {
  const rows = [
    { id: "a", taskId: "t1", conversationId: null, title: "One" },
    { id: "b", taskId: null, conversationId: "c1", title: "Chat" },
  ];
  const byTask = withRenamedRow(rows, { taskId: "t1" }, "New one");
  assert.deepEqual(byTask.map((r) => r.title), ["New one", "Chat"]);
  const byConversation = withRenamedRow(rows, { conversationId: "c1" }, "Planning");
  assert.deepEqual(byConversation.map((r) => r.title), ["One", "Planning"]);
  assert.equal(withRenamedRow(rows, { taskId: "nope" }, "X"), rows, "no match keeps the same array");
  assert.deepEqual(rows.map((r) => r.title), ["One", "Chat"], "input is not mutated");
});

test("F2 always starts a rename; Enter only on the open thread; modifiers never", () => {
  assert.equal(isRenameKey(key("F2"), false), true);
  assert.equal(isRenameKey(key("Enter"), true), true);
  assert.equal(isRenameKey(key("Enter"), false), false);
  assert.equal(isRenameKey(key("F2", { metaKey: true }), true), false);
  assert.equal(isRenameKey(key("Enter", { shiftKey: true }), true), false);
  assert.equal(isRenameKey(key("ArrowDown"), true), false);
});
