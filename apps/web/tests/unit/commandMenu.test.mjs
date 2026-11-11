import { test } from "node:test";
import assert from "node:assert/strict";
import { RECENT_THREADS, newTaskHref, recentThreads } from "../../lib/commandMenu.ts";

const row = (over) => ({
  id: over.id,
  kind: "task",
  taskId: over.id,
  conversationId: null,
  ownerTaskId: null,
  title: `Thread ${over.id}`,
  status: "running",
  needsYou: false,
  unread: false,
  branchName: null,
  lastActivityAt: 0,
  projectId: "p1",
  projectName: "Alpha",
  ...over,
});

test("recentThreads: newest first, capped, with the sidebar href", () => {
  const rows = Array.from({ length: 10 }, (_, i) => row({ id: `t${i}`, lastActivityAt: i * 10 }));
  const out = recentThreads(rows);
  assert.equal(out.length, RECENT_THREADS);
  assert.deepEqual(out.slice(0, 2).map((r) => r.id), ["t9", "t8"]);
  assert.equal(out[0].href, "/chats/p1?task=t9");
});

test("recentThreads: drops nested fix tasks, keeps orphans, names untitled rows", () => {
  const rows = [
    row({ id: "owner", lastActivityAt: 5 }),
    row({ id: "fix", ownerTaskId: "owner", lastActivityAt: 9 }),
    row({ id: "orphan", ownerTaskId: "gone", lastActivityAt: 7, title: "  " }),
    row({ id: "c1", kind: "conversation", taskId: null, lastActivityAt: 1 }),
  ];
  const out = recentThreads(rows);
  assert.deepEqual(out.map((r) => r.id), ["orphan", "owner", "c1"]);
  assert.equal(out[0].title, "Untitled thread");
  assert.equal(out[2].href, "/chats/p1");
});

test("recentThreads: empty and undefined input", () => {
  assert.deepEqual(recentThreads(undefined), []);
  assert.deepEqual(recentThreads([]), []);
});

test("newTaskHref opens the Tasks tab with compose", () => {
  assert.equal(newTaskHref("abc"), "/chats/abc?tab=tasks&compose=1");
});
