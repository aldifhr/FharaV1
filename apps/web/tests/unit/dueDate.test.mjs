import { test } from "node:test";
import assert from "node:assert/strict";
import { dueDateLabel, isOverdue } from "../../lib/runFormat.ts";

// Plan 063: the label is English copy and stable for a local-noon value; the
// overdue flag only fires while the task is not finished.
test("dueDateLabel renders the calendar day in English", () => {
  const noon = Date.parse("2026-11-20T12:00:00");
  assert.match(dueDateLabel(noon), /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2}$/);
});

test("isOverdue: past due and unfinished only", () => {
  const now = Date.parse("2026-11-17T10:00:00");
  const due = Date.parse("2026-11-16T12:00:00");
  const future = Date.parse("2026-11-20T12:00:00");
  assert.equal(isOverdue(due, false, now), true);
  assert.equal(isOverdue(due, true, now), false);
  assert.equal(isOverdue(future, false, now), false);
});
