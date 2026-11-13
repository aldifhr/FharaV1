import { test } from "node:test";
import assert from "node:assert/strict";
import { dockTasks, taskRef } from "../../lib/taskDock.ts";

const task = (id, status, at, conversationId) => ({ _id: id, _creationTime: at, title: id, status, conversationId });

test("the dock lists open tasks oldest first and drops closed ones", () => {
  const rows = dockTasks([task("c", "running", 3), task("a", "queued", 1), task("d", "done", 4), task("b", "paused", 2), task("e", "cancelled", 5)], null);
  assert.deepEqual(rows.map((t) => t._id), ["a", "b", "c"]);
});

test("the dock keeps this conversation's tasks and unscoped ones", () => {
  const rows = dockTasks([task("a", "running", 1, "conv1"), task("b", "running", 2, "conv2"), task("c", "queued", 3)], "conv1");
  assert.deepEqual(rows.map((t) => t._id), ["a", "c"]);
  assert.deepEqual(dockTasks(undefined, "conv1"), []);
});

test("a task ref is the id's last four characters", () => {
  assert.equal(taskRef("jd7abc123k3x9"), "#k3x9");
});
