import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canReplyTo,
  heldStopReason,
  isSystemLine,
  legacyHandoffText,
  systemLineText,
  threadBlockOf,
} from "../../lib/systemLine.ts";

test("a voice:system row is a System line and shows its own text", () => {
  const row = { authorType: "agent", voice: "system", content: "Sent to Backend" };
  assert.equal(isSystemLine(row), true);
  assert.equal(systemLineText(row), "Sent to Backend");
  assert.equal(canReplyTo(row), false);
});

test("a legacy handoff line shows as Sent to X, in English and Indonesian", () => {
  assert.equal(legacyHandoffText({ authorType: "agent", content: "Handing this to @Frontend for the frontend side." }), "Sent to Frontend");
  assert.equal(systemLineText({ authorType: "agent", content: "Saya serahkan ke @QA untuk pengecekan tes ini." }), "Sent to QA");
  assert.equal(canReplyTo({ authorType: "agent", content: "Handing this to @Frontend for the frontend side." }), false);
});

test("ordinary replies stay ordinary and replyable", () => {
  const row = { authorType: "agent", content: "HTML is markup." };
  assert.equal(systemLineText(row), null);
  assert.equal(canReplyTo(row), true);
  assert.equal(systemLineText({ authorType: "agent", content: "Handing this to @Frontend for the UI.\nAlso, HTML is markup." }), null);
  assert.equal(systemLineText({ authorType: "user", content: "Handing this to @Frontend for the UI." }), null);
  assert.equal(canReplyTo({ authorType: "agent", content: "  " }), false);
});

test("a held CTO stop yields the reason; other questions do not", () => {
  const question = "The CTO recommends stopping before the gated work: the auth rewrite needs a migration plan first.\n\nResume the plan anyway, or cancel the task?";
  assert.equal(heldStopReason({ status: "waiting_input", pendingQuestion: question }), "the auth rewrite needs a migration plan first.");
  assert.equal(heldStopReason({ status: "running", pendingQuestion: question }), null);
  assert.equal(heldStopReason({ status: "waiting_input", pendingQuestion: "Which color?" }), null);
  assert.equal(heldStopReason(null), null);
});

test("the final report pins under the Response Owner; CTO only for architecture decisions", () => {
  const report = { authorType: "agent", content: "Done.\n\nVerification: passed." };
  assert.equal(threadBlockOf(report, "backend", "backend"), "report");
  assert.equal(threadBlockOf(report, undefined, "backend"), "report");
  assert.equal(threadBlockOf({ authorType: "agent", content: "Decision: go. The schema change is fine." }, "cto", "backend"), "decision");
  assert.equal(threadBlockOf({ authorType: "agent", content: "I looked at the files." }, "cto", "backend"), null);
  assert.equal(threadBlockOf({ authorType: "agent", content: "Looks good." }, "reviewer", "backend"), "review");
  assert.equal(threadBlockOf({ authorType: "agent", voice: "system", content: "Done." }, undefined, "backend"), null);
  assert.equal(threadBlockOf(report, "frontend", "backend"), null);
});
