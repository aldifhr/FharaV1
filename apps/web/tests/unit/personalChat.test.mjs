import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attachBlockReason,
  attachCandidates,
  conversationKindLabel,
  personalDraftKey,
  personalAgentIdFromPath,
  personalEmptyText,
  personalIndexTarget,
  personalSlashNames,
  plainTextPreview,
  sidebarPersonalRows,
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

const row = (id, name, conversationId, lastMessageAt, role = "frontend") => ({
  agent: { _id: id, name, role },
  conversationId,
  lastMessageAt,
  preview: null,
});

test("sidebar personal rows: only agents with a chat, most recent first, empty chats last by name", () => {
  const rows = [
    row("a", "Ada", "c1", 100),
    row("b", "Bo", null, null),
    row("c", "Cy", "c3", 300),
    row("d", "Di", "c4", null),
    row("e", "Ed", "c5", null),
  ];
  assert.deepEqual(sidebarPersonalRows(rows).map((r) => r.agent._id), ["c", "a", "d", "e"]);
  // input is not mutated
  assert.equal(rows[0].agent._id, "a");
});

test("sidebar personal rows: search matches name or role label", () => {
  const rows = [row("a", "Ada", "c1", 1, "qa"), row("c", "Cy", "c3", 2, "devops")];
  const label = (role) => role.toUpperCase();
  assert.deepEqual(sidebarPersonalRows(rows, "ad").map((r) => r.agent._id), ["a"]);
  assert.deepEqual(sidebarPersonalRows(rows, " DEV ", label).map((r) => r.agent._id), ["c"]);
  assert.deepEqual(sidebarPersonalRows(undefined), []);
});

test("personal path parsing and index redirect target", () => {
  assert.equal(personalAgentIdFromPath("/chats/personal/ag1"), "ag1");
  assert.equal(personalAgentIdFromPath("/chats/personal"), null);
  assert.equal(personalAgentIdFromPath("/chats/p1"), null);
  assert.equal(personalIndexTarget([row("a", "Ada", "c1", 1), row("c", "Cy", "c3", 9)]), "/chats/personal/c");
  assert.equal(personalIndexTarget([row("b", "Bo", null, null)]), "/chats");
});

test("plainTextPreview strips markdown to one plain line", () => {
  assert.equal(
    plainTextPreview("```python\n# SELECT related\nqs = Book.objects.select_related('author')\n```"),
    "SELECT related qs = Book.objects.select_related('author')"
  );
  assert.equal(plainTextPreview("Pakai **unit kerja** dan `prefetch_related`."), "Pakai unit kerja dan prefetch_related.");
  assert.equal(plainTextPreview("## Plan\n- *one*\n- __two__\n1. ~~three~~"), "Plan one two three");
  assert.equal(plainTextPreview("See [the docs](https://x.dev) and ![logo](a.png)"), "See the docs and logo");
  assert.equal(plainTextPreview("> quoted\n\n| a | b |\n|---|---|\n| 1 | 2 |"), "quoted a b 1 2");
  assert.equal(plainTextPreview("snake_case_name stays"), "snake_case_name stays");
  assert.equal(plainTextPreview(null), "");
  assert.equal(plainTextPreview("x".repeat(200), 10), `${"x".repeat(9)}…`);
});
