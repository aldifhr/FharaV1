import { test } from "node:test";
import assert from "node:assert/strict";
import { compareThreads, threadHref, threadLinkView } from "../../lib/threadTree.ts";

let seq = 0;
const row = (over = {}) => {
  seq += 1;
  return {
    id: `r${seq}`,
    kind: "task",
    taskId: `t${seq}`,
    conversationId: null,
    ownerTaskId: null,
    title: `Thread ${seq}`,
    status: "running",
    needsYou: false,
    unread: false,
    branchName: null,
    lastActivityAt: 1000 + seq,
    projectId: "p1",
    projectName: "Alpha",
    ...over,
  };
};

test("sort: newest first, ties by title then id, no timestamp sinks", () => {
  const a = row({ id: "a", title: "B", lastActivityAt: 5 });
  const b = row({ id: "b", title: "A", lastActivityAt: 5 });
  const c = row({ id: "c", title: "Z", lastActivityAt: 9 });
  const d = row({ id: "d", title: "A", lastActivityAt: 0 });
  const e = row({ id: "e", title: "A", lastActivityAt: 5 });
  assert.deepEqual([a, b, c, d, e].sort(compareThreads).map((r) => r.id), ["c", "b", "e", "a", "d"]);
  assert.ok(compareThreads(d, a) > 0);
});

test("threadHref: every row opens its thread; the chat falls back to the project page", () => {
  assert.equal(threadHref({ projectId: "p1", taskId: "t9", conversationId: null }), "/project/p1/t9");
  assert.equal(threadHref({ projectId: "p1", taskId: null, conversationId: "c2" }), "/project/p1/c2");
  assert.equal(threadHref({ projectId: "p1", taskId: null, conversationId: null }), "/project/p1");
});

test("deep link view: task, conversation, or not found", async () => {
  const row = (extra) => ({ kind: "task", projectId: "p1", personal: false, taskChat: false, status: "running", ...extra });
  assert.equal(threadLinkView("p1", undefined), "loading");
  assert.equal(threadLinkView("p1", row()), "task");
  assert.equal(threadLinkView("p1", row({ kind: "conversation", status: "active" })), "conversation");
  assert.equal(threadLinkView("p1", row({ kind: "conversation", status: "closed" })), "conversation");
  // Unknown id, another project's thread, a personal chat, a task's own chat.
  assert.equal(threadLinkView("p1", null), "not_found");
  assert.equal(threadLinkView("p1", row({ projectId: null })), "not_found");
  assert.equal(threadLinkView("p1", row({ kind: "conversation", projectId: null })), "not_found");
  assert.equal(threadLinkView("p1", row({ kind: "conversation", personal: true })), "not_found");
  assert.equal(threadLinkView("p1", row({ kind: "conversation", taskChat: true })), "not_found");
});
