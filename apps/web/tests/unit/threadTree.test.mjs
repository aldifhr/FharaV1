import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adjacentThreadId,
  buildThreadTree,
  compareThreads,
  filterThreadGroups,
  groupThreads,
  matchesThreadFilter,
  matchesThreadQuery,
  sortThreads,
  statusBucket,
  threadHref,
  visibleThreadIds,
} from "../../lib/threadTree.ts";

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
  assert.deepEqual(sortThreads([a, b, c, d, e]).map((r) => r.id), ["c", "b", "e", "a", "d"]);
  assert.ok(compareThreads(d, a) > 0);
});

test("sort: fix tasks nest under their owner, orphans stay top-level", () => {
  const owner = row({ id: "owner", taskId: "T", lastActivityAt: 10 });
  const fix1 = row({ id: "fix1", ownerTaskId: "T", lastActivityAt: 50 });
  const other = row({ id: "other", lastActivityAt: 30 });
  const fix2 = row({ id: "fix2", ownerTaskId: "T", lastActivityAt: 20 });
  const orphan = row({ id: "orphan", ownerTaskId: "gone", lastActivityAt: 40 });
  const out = sortThreads([owner, fix1, other, fix2, orphan]);
  assert.deepEqual(out.map((r) => r.id), ["orphan", "other", "owner", "fix1", "fix2"]);
  assert.deepEqual(out.map((r) => r.nested), [false, false, false, true, true]);
});

test("group by project: one group per project, newest project first", () => {
  const rows = [
    row({ projectId: "p1", projectName: "Alpha", lastActivityAt: 5 }),
    row({ projectId: "p2", projectName: "Beta", lastActivityAt: 9 }),
    row({ projectId: "p1", projectName: "Alpha", lastActivityAt: 7 }),
  ];
  const groups = groupThreads(rows, "project");
  assert.deepEqual(groups.map((g) => g.label), ["Beta", "Alpha"]);
  assert.equal(groups[1].rows.length, 2);
  assert.equal(groups[1].lastActivityAt, 7);
});

test("group by project: owner + 2 fix tasks stay one block", () => {
  const owner = row({ taskId: "OWN" });
  const rows = [owner, row({ ownerTaskId: "OWN" }), row({ ownerTaskId: "OWN" })];
  const [group] = groupThreads(rows, "project");
  assert.equal(group.rows[0].taskId, "OWN");
  assert.equal(group.rows.filter((r) => r.nested).length, 2);
});

test("group by kind and status: fixed order, empty groups dropped", () => {
  const rows = [
    row({ kind: "conversation", taskId: null, conversationId: "c1", status: "idle" }),
    row({ kind: "task", status: "done" }),
    row({ kind: "task", status: "waiting_input", needsYou: true }),
    row({ kind: "task", status: "queued" }),
  ];
  assert.deepEqual(groupThreads(rows, "kind").map((g) => g.label), ["Tasks", "Conversations"]);
  assert.deepEqual(groupThreads(rows, "status").map((g) => g.label), ["Needs you", "Active", "Idle", "Done"]);
  assert.deepEqual(groupThreads([row({ status: "failed" })], "status").map((g) => g.label), ["Done"]);
});

test("statusBucket: needsYou wins; unknown words are idle", () => {
  assert.equal(statusBucket({ status: "running", needsYou: true }), "needsYou");
  assert.equal(statusBucket({ status: "held", needsYou: false }), "active");
  assert.equal(statusBucket({ status: "closed", needsYou: false }), "done");
  assert.equal(statusBucket({ status: "something", needsYou: false }), "idle");
});

test("filter select: all / needs you / unread", () => {
  const r = { needsYou: true, unread: false };
  assert.equal(matchesThreadFilter(r, "all"), true);
  assert.equal(matchesThreadFilter(r, "needsYou"), true);
  assert.equal(matchesThreadFilter(r, "unread"), false);
});

test("text filter: title and branch, case-insensitive; empty matches all", () => {
  assert.equal(matchesThreadQuery({ title: "Fix Auth flow", branchName: null }, "auth"), true);
  assert.equal(matchesThreadQuery({ title: "Docs", branchName: "fhara/AUTH-12" }, "auth"), true);
  assert.equal(matchesThreadQuery({ title: "Docs", branchName: null }, "auth"), false);
  assert.equal(matchesThreadQuery({ title: "Docs", branchName: null }, "  "), true);
});

test("filterThreadGroups: label match keeps the group whole, else prune, drop empty", () => {
  const groups = groupThreads(
    [
      row({ projectId: "p1", projectName: "Auth service", title: "Logging" }),
      row({ projectId: "p1", projectName: "Auth service", title: "Metrics" }),
      row({ projectId: "p2", projectName: "Web", title: "auth page" }),
      row({ projectId: "p2", projectName: "Web", title: "Footer" }),
      row({ projectId: "p3", projectName: "Docs", title: "Intro" }),
    ],
    "project",
  );
  const out = filterThreadGroups(groups, "AUTH");
  const byLabel = Object.fromEntries(out.map((g) => [g.label, g.rows.map((r) => r.title).sort()]));
  assert.deepEqual(byLabel, { "Auth service": ["Logging", "Metrics"], Web: ["auth page"] });
  assert.equal(filterThreadGroups(groups, "").length, 3);
});

test("buildThreadTree: status filter, grouping, text filter; 30 rows", () => {
  const rows = Array.from({ length: 30 }, (_, i) =>
    row({
      projectId: `p${i % 3}`,
      projectName: `Project ${i % 3}`,
      title: i % 5 === 0 ? `auth ${i}` : `task ${i}`,
      needsYou: i % 4 === 0,
      unread: i % 2 === 0,
    }),
  );
  const all = buildThreadTree(rows, { groupBy: "project", filter: "all", query: "" });
  assert.equal(all.reduce((n, g) => n + g.rows.length, 0), 30);
  const auth = buildThreadTree(rows, { groupBy: "project", filter: "all", query: "auth" });
  assert.equal(auth.reduce((n, g) => n + g.rows.length, 0), 6);
  assert.ok(auth.every((g) => g.rows.every((r) => r.title.startsWith("auth"))));
  const needs = buildThreadTree(rows, { groupBy: "status", filter: "needsYou", query: "" });
  assert.deepEqual(needs.map((g) => g.label), ["Needs you"]);
  assert.equal(needs[0].rows.length, 8);
  const unread = buildThreadTree(rows, { groupBy: "kind", filter: "unread", query: "" });
  assert.equal(unread[0].rows.length, 15);
});

test("visibleThreadIds skips collapsed groups unless forced open", () => {
  const groups = groupThreads(
    [row({ id: "x", projectId: "p1", lastActivityAt: 9 }), row({ id: "y", projectId: "p2", projectName: "B", lastActivityAt: 1 })],
    "project",
  );
  assert.deepEqual(visibleThreadIds(groups, new Set()), ["x", "y"]);
  assert.deepEqual(visibleThreadIds(groups, new Set(["project:p1"])), ["y"]);
  assert.deepEqual(visibleThreadIds(groups, new Set(["project:p1"]), true), ["x", "y"]);
});

test("adjacentThreadId: start at an end, step, stop at the ends", () => {
  const ids = ["a", "b", "c"];
  assert.equal(adjacentThreadId(ids, null, 1), "a");
  assert.equal(adjacentThreadId(ids, null, -1), "c");
  assert.equal(adjacentThreadId(ids, "gone", 1), "a");
  assert.equal(adjacentThreadId(ids, "b", 1), "c");
  assert.equal(adjacentThreadId(ids, "c", 1), "c");
  assert.equal(adjacentThreadId(ids, "a", -1), "a");
  assert.equal(adjacentThreadId([], "a", 1), null);
});

test("threadHref: every row opens its thread; the chat falls back to the project page", () => {
  assert.equal(threadHref({ projectId: "p1", taskId: "t9", conversationId: null }), "/project/p1/t9");
  assert.equal(threadHref({ projectId: "p1", taskId: null, conversationId: "c2" }), "/project/p1/c2");
  assert.equal(threadHref({ projectId: "p1", taskId: null, conversationId: null }), "/project/p1");
});
