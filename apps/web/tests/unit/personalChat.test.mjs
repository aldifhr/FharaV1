import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attachBlockReason,
  attachCandidates,
  conversationKindLabel,
  personalDraftKey,
  personalEmptyText,
  personalSlashNames,
} from "../../lib/personalChat.ts";

test("kind label is plain text: Personal, Project: <name>, Team", () => {
  assert.equal(conversationKindLabel("personal", null), "Personal");
  assert.equal(conversationKindLabel("personal", "Fhara"), "Project: Fhara");
  assert.equal(conversationKindLabel("project", "Fhara"), "Project: Fhara");
  assert.equal(conversationKindLabel("team", "Fhara"), "Team");
});

test("empty state says what the agent cannot do without a project", () => {
  assert.match(personalEmptyText("Ada", null), /No project is attached, so Ada can't read files or run tasks here\./);
  assert.match(personalEmptyText("Ada", "Fhara"), /attached to Fhara/);
});

test("draft key is per conversation", () => {
  assert.notEqual(personalDraftKey("a"), personalDraftKey("b"));
  assert.equal(personalDraftKey("a"), "fhara-personal-draft-a");
});

test("attach is blocked for a project whose team lacks the agent; nothing is preselected", () => {
  const agent = { _id: "ag1", name: "Quinn" };
  assert.equal(attachBlockReason({ agentIds: ["ag1"] }, agent), null);
  assert.equal(attachBlockReason({ agentIds: [] }, agent), "Quinn is not on this project's team");
  assert.equal(attachBlockReason({}, agent), "Quinn is not on this project's team");
});

test("/task only after attach", () => {
  assert.deepEqual(personalSlashNames(false), []);
  assert.deepEqual(personalSlashNames(true), ["task"]);
});

test("attach candidates: members first, others carry the reason, nothing preselected", () => {
  const agent = { _id: "ag1", name: "Quinn" };
  const rows = attachCandidates(
    [
      { _id: "p1", name: "Zeta", agentIds: ["ag1"] },
      { _id: "p2", name: "Alpha", agentIds: [] },
      { _id: "p3", name: "Beta", agentIds: ["ag1"] },
    ],
    agent
  );
  assert.deepEqual(rows.map((r) => r.project._id), ["p3", "p1", "p2"]);
  assert.equal(rows[2].blocked, "Quinn is not on this project's team");
  assert.ok(rows.every((r) => !("selected" in r)));
});
