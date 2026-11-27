import { test } from "node:test";
import assert from "node:assert/strict";
import { canRetryTask } from "../../lib/taskStatus.ts";

test("retry is offered only for failed tasks", () => {
  assert.equal(canRetryTask("failed"), true);
  for (const status of ["rejected", "cancelled", "done", "needs_approval", "running", "queued", undefined]) {
    assert.equal(canRetryTask(status), false, status);
  }
});
