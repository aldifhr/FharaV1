import { test } from "node:test";
import assert from "node:assert/strict";
import { activityTitleKind, reasoningRowHasLabel } from "../../lib/activityHeading.ts";

// "Reasoning" headings a finished timeline shows: the title plus the row's toggle.
const reasoningHeadings = (stepCount, extrasCount) => {
  const title = activityTitleKind("done", stepCount, extrasCount);
  return (title === "reasoning" ? 1 : 0) + (reasoningRowHasLabel(title) ? 1 : 0);
};

test("reasoning-only reply: the Reasoning heading renders once", () => {
  assert.equal(activityTitleKind("done", 0, 0), "reasoning");
  assert.equal(reasoningHeadings(0, 0), 1);
});

test("with tool steps or extras the title differs and the row keeps its Reasoning toggle", () => {
  assert.equal(activityTitleKind("done", 2, 0), "tools");
  assert.equal(activityTitleKind("done", 0, 1), "worked");
  assert.equal(reasoningHeadings(2, 0), 1);
  assert.equal(reasoningHeadings(0, 1), 1);
});

test("live phases", () => {
  assert.equal(activityTitleKind("thinking", 0, 0), "thinking");
  assert.equal(activityTitleKind("working", 1, 0), "working");
  assert.equal(activityTitleKind("composing", 0, 0), "working");
});
