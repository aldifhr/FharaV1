import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RENAME_TITLE_MAX,
  normaliseRenameTitle,
  renameDraft,
  withRenamedRow,
} from "../../lib/threadRename.ts";

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
