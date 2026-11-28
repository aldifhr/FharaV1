import { test } from "node:test";
import assert from "node:assert/strict";
import { deletableRuns, deleteAllCopy } from "../../lib/runDelete.ts";

const runs = [
  { taskId: "a", status: "done" },
  { taskId: "b", status: "running" },
  { taskId: "c", status: "queued" },
  { taskId: "d", status: "failed" },
];

test("bulk delete skips running runs but keeps every other status", () => {
  assert.deepEqual(
    deletableRuns(runs).map((r) => r.taskId),
    ["a", "c", "d"],
  );
  assert.deepEqual(deletableRuns([]), []);
});

test("confirmation says how many runs are deleted and how many are skipped", () => {
  assert.deepEqual(deleteAllCopy(3, 1), {
    title: "Delete 3 runs?",
    message: "1 still running run is skipped. This deletes the runs and their task data. Audit history is kept.",
    confirmLabel: "Delete 3 runs",
  });
  assert.equal(deleteAllCopy(1, 0).title, "Delete 1 run?");
  assert.equal(deleteAllCopy(1, 0).message.includes("skipped"), false);
  assert.equal(deleteAllCopy(2, 2).message.includes("2 still running runs are skipped"), true);
});
