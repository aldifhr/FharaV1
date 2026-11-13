import { test } from "node:test";
import assert from "node:assert/strict";
import { failureKindLabel, latestFailureKind } from "../../lib/failureKind.ts";

test("every failure kind has its own label; unknown or missing kinds read as Agent error", () => {
  const kinds = ["review_rejected", "verify_failed", "qa_failed", "budget_exhausted", "approval_rejected", "apply_conflict", "provider_hold", "no_change", "cancelled"];
  const labels = kinds.map(failureKindLabel);
  assert.equal(new Set(labels).size, kinds.length);
  assert.ok(!labels.includes("Agent error"));
  assert.equal(failureKindLabel("error"), "Agent error");
  assert.equal(failureKindLabel(undefined), "Agent error");
  assert.equal(failureKindLabel("something_new"), "Agent error");
});

test("the latest terminal event with a known failure kind wins (events are oldest-first)", () => {
  const events = [
    { type: "task.stage", payload: { stage: "verifying" } },
    { type: "task.error", payload: { message: "x", failureKind: "verify_failed" } },
    { type: "llm.provider_hold", payload: { failureKind: "provider_hold" } },
    { type: "task.error", payload: { message: "old event, no kind" } },
  ];
  assert.equal(latestFailureKind(events), "provider_hold");
  assert.equal(latestFailureKind([{ payload: { failureKind: "bogus" } }]), null);
  assert.equal(latestFailureKind(undefined), null);
  assert.equal(latestFailureKind([]), null);
});
