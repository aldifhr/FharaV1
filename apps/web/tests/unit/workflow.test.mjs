import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaultWorkflow, previewOrder, validateWorkflow } from "../../lib/workflow.ts";

test("workflow module no longer touches localStorage", () => {
  const src = readFileSync(new URL("../../lib/workflow.ts", import.meta.url), "utf8");
  assert.equal(src.includes("localStorage"), false);
});

test("default workflow validates without errors", () => {
  const wf = defaultWorkflow();
  const issues = validateWorkflow(wf);
  assert.equal(issues.filter((i) => i.level === "error").length, 0);
});

test("preview order starts at the start node", () => {
  const wf = defaultWorkflow();
  const order = previewOrder(wf);
  assert.equal(order[0], wf.nodes.find((n) => n.type === "start").id);
});