import { test } from "node:test";
import assert from "node:assert/strict";
import { CHARACTER_TABLE } from "../../components/office/characters.ts";
import {
  assignCharacters,
  approvalCard,
  boardColumn,
  buildOfficeSnapshot,
  diffOfficeSnapshots,
  RECENT_MS,
} from "../../components/office/feed.ts";

const NOW = 1_800_000_000_000;

const TEAM = [
  { _id: "a1", name: "CTO", role: "cto" },
  { _id: "a2", name: "Designer", role: "designer" },
  { _id: "a3", name: "Frontend", role: "frontend" },
  { _id: "a4", name: "Backend", role: "backend" },
  { _id: "a5", name: "QA", role: "qa" },
  { _id: "a6", name: "Support", role: "support" },
  { _id: "a7", name: "DevOps", role: "devops" },
  { _id: "a8", name: "Reviewer", role: "reviewer" },
  { _id: "a9", name: "Researcher", role: "researcher" },
];

function snap(over = {}) {
  return buildOfficeSnapshot({
    agents: TEAM,
    tasks: [],
    subtasks: [],
    approvals: [],
    pushes: [],
    usage: null,
    characters: CHARACTER_TABLE,
    now: NOW,
    ...over,
  });
}

// ---------------------------------------------------------------- roles

test("role mapping: each fixed-team role gets its own character", () => {
  const map = assignCharacters(TEAM, CHARACTER_TABLE);
  const base = (id) => map.get(id).base;
  assert.equal(base("a1"), "Me-1");
  assert.equal(base("a2"), "Designer-1");
  assert.equal(base("a3"), "Frontend-dev-1");
  assert.equal(base("a4"), "dev-2");
  assert.equal(base("a5"), "employee-2");
  assert.equal(base("a6"), "Support-1");
  assert.equal(base("a7"), "employee-3");
  assert.equal(base("a8"), "employee-1");
  assert.equal(base("a9"), "Researcher-1");
  assert.equal(new Set([...map.values()].map((r) => r.base)).size, TEAM.length);
});

test("role mapping: ui-ux, data-scientist, growth fallback", () => {
  const map = assignCharacters(
    [
      { _id: "x1", role: "ui-ux" },
      { _id: "x2", role: "data-scientist" },
      { _id: "x3", role: "growth" },
    ],
    CHARACTER_TABLE,
  );
  assert.equal(map.get("x1").base, "Designer-1");
  assert.equal(map.get("x2").base, "Data-scientist-1");
  assert.equal(map.get("x3").base, "Support-1");
});

test("role mapping: a second agent of a role gets a different character, unknown roles hash into the pool", () => {
  const agents = [...TEAM, { _id: "b1", role: "frontend" }, { _id: "b2", role: "wizard" }];
  const map = assignCharacters(agents, CHARACTER_TABLE);
  assert.notEqual(map.get("b1").base, "Frontend-dev-1");
  const bases = [...map.values()].map((r) => r.base);
  assert.equal(new Set(bases).size, agents.length, "distinct while the table has room");
});

test("role mapping: deterministic, and repeats only once every character is used", () => {
  const many = Array.from({ length: CHARACTER_TABLE.length + 5 }, (_, i) => ({ _id: `id${i}`, role: "x" }));
  const first = assignCharacters(many, CHARACTER_TABLE);
  const again = assignCharacters([...many].reverse(), CHARACTER_TABLE);
  for (const a of many) assert.equal(first.get(a._id).base, again.get(a._id).base);
  assert.equal(new Set([...first.values()].map((r) => r.base)).size, CHARACTER_TABLE.length);
});

test("disabled agents are not drawn", () => {
  const s = snap({ agents: [...TEAM, { _id: "off", name: "Old", role: "lead", isEnabled: false }] });
  assert.equal(s.agents.some((a) => a.id === "off"), false);
});

// ---------------------------------------------------------------- status

test("status mapping: running subtask -> working with the activity line", () => {
  const s = snap({
    tasks: [{ _id: "t1", title: "Login page", status: "running" }],
    subtasks: [{ taskId: "t1", key: "ui", title: "Build form", status: "running", assignedAgentId: "a3", activity: "Running npm test", activityAt: NOW - 5 }],
  });
  const fe = s.agents.find((a) => a.id === "a3");
  assert.equal(fe.work, "working");
  assert.equal(fe.statusText, "Running npm test");
  assert.equal(fe.taskTitle, "Login page");
  assert.equal(fe.subtaskKey, "ui");
});

test("status mapping: falls back to the subtask title without activity", () => {
  const s = snap({ subtasks: [{ taskId: "t1", key: "k", title: "Write API", status: "running", assignedAgentId: "a4" }] });
  assert.equal(s.agents.find((a) => a.id === "a4").statusText, "Write API");
});

test("status mapping: recently completed / failed, then idle (coffee break)", () => {
  const done = { taskId: "t1", key: "k", title: "Tests", status: "completed", assignedAgentId: "a5", completedAt: NOW - 1000 };
  assert.equal(snap({ subtasks: [done] }).agents.find((a) => a.id === "a5").work, "completed");
  const failed = { ...done, status: "failed", error: "2 failing" };
  const f = snap({ subtasks: [failed] }).agents.find((a) => a.id === "a5");
  assert.equal(f.work, "failed");
  assert.equal(f.statusText, "2 failing");
  const old = { ...done, completedAt: NOW - RECENT_MS - 1 };
  const idle = snap({ subtasks: [old] }).agents.find((a) => a.id === "a5");
  assert.equal(idle.work, "idle");
  assert.equal(idle.statusText, "rehat kopi");
});

test("status mapping: agent.status thinking without a subtask -> working", () => {
  const s = snap({ agents: TEAM.map((a) => (a._id === "a1" ? { ...a, status: "thinking" } : a)) });
  assert.equal(s.agents.find((a) => a.id === "a1").work, "working");
});

test("board columns", () => {
  assert.equal(boardColumn("queued"), "todo");
  assert.equal(boardColumn("paused"), "todo");
  assert.equal(boardColumn("running"), "in_progress");
  assert.equal(boardColumn("done"), "done");
  assert.equal(boardColumn("needs_approval"), "blocked");
  assert.equal(boardColumn("waiting_input"), "blocked");
  assert.equal(boardColumn("failed"), "blocked");
  assert.equal(boardColumn("cancelled"), null);
  assert.equal(boardColumn("rejected"), null);
});

test("incident: recent failed task or push turns it on; a later success clears it", () => {
  const failed = { _id: "t1", title: "Deploy", status: "failed", completedAt: NOW - 60_000 };
  assert.equal(snap({ tasks: [failed] }).incident.active, true);
  const fixed = { _id: "t2", title: "Deploy again", status: "done", completedAt: NOW - 1000 };
  assert.equal(snap({ tasks: [failed, fixed] }).incident.active, false);
  const push = { _id: "p1", taskId: "t2", status: "failed", updatedAt: NOW - 1000, branchName: "fhara/x" };
  const s = snap({ tasks: [fixed], pushes: [push] });
  assert.equal(s.incident.active, true);
  assert.match(s.incident.reason, /Push gagal/);
});

// ---------------------------------------------------------------- approvals

test("approval mapping: run_command offers always only when the server did and it is not dangerous", () => {
  const base = { _id: "ap1", taskId: "t1", kind: "run_command", summary: "npm test", status: "pending", payload: { command: "npm test" } };
  assert.equal(approvalCard({ ...base, offerAlways: true }, null, null).offerAlways, true);
  assert.equal(approvalCard({ ...base, offerAlways: false }, null, null).offerAlways, false);
  assert.equal(approvalCard({ ...base, offerAlways: true, payload: { command: "rm -rf dist", danger: true } }, null, null).offerAlways, false);
  assert.equal(approvalCard({ ...base, offerAlways: true, payload: { command: "git push origin main" } }, null, null).offerAlways, false);
  assert.equal(approvalCard(base, null, null).channel, "command");
});

test("approval mapping: push / plan never offer always and use approve/reject", () => {
  for (const kind of ["git_push", "plan", "apply_changes", "merge_pr"]) {
    const card = approvalCard({ _id: "x", taskId: "t", kind, summary: "s", status: "pending", offerAlways: true }, null, null);
    assert.equal(card.channel, "approval");
    assert.equal(card.offerAlways, false);
  }
});

test("approval mapping: the requesting agent raises its hand; unattributed goes to the subtask owner, then the CTO", () => {
  const s = snap({
    subtasks: [{ taskId: "t1", key: "be", title: "API", status: "waiting_approval", assignedAgentId: "a4" }],
    approvals: [
      { _id: "ap1", taskId: "t1", kind: "run_command", summary: "npm test", status: "pending", requestedByAgentId: "a5" },
      { _id: "ap2", taskId: "t1", kind: "run_command", summary: "npm run build", status: "pending", subtaskKey: "be" },
      { _id: "ap3", taskId: "t9", kind: "git_push", summary: "Push fhara/x", status: "pending" },
    ],
  });
  const by = (id) => s.agents.find((a) => a.id === id);
  assert.equal(by("a5").work, "needs_you");
  assert.equal(by("a5").needsYou.approvalId, "ap1");
  assert.equal(by("a4").needsYou.approvalId, "ap2");
  assert.equal(by("a1").needsYou.approvalId, "ap3");
  assert.deepEqual(s.approvals.map((c) => c.agentId), ["a5", "a4", "a1"]);
  assert.equal(s.approvals[2].agentName, "CTO");
});

// ---------------------------------------------------------------- diff

test("diff: first snapshot hires everyone, no celebration for old pushes", () => {
  const s = snap({ pushes: [{ _id: "p1", taskId: "t", status: "pushed", pushedAt: NOW - 10 }] });
  const actions = diffOfficeSnapshots(null, s);
  assert.equal(actions.filter((a) => a.type === "hire").length, TEAM.length);
  assert.equal(actions.some((a) => a.type === "celebrate"), false);
  assert.equal(actions.some((a) => a.type === "incident"), false);
});

test("diff: status change, leave, new push celebrates, incident toggles", () => {
  const a = snap();
  const b = snap({
    agents: TEAM.filter((x) => x._id !== "a9"),
    subtasks: [{ taskId: "t1", key: "k", title: "Build", status: "running", assignedAgentId: "a3" }],
    tasks: [{ _id: "t0", title: "Old", status: "failed", completedAt: NOW - 1000 }],
    pushes: [{ _id: "p2", taskId: "t1", status: "pushed", pushedAt: NOW }],
  });
  const actions = diffOfficeSnapshots(a, b);
  assert.deepEqual(actions.find((x) => x.type === "leave"), { type: "leave", agentId: "a9" });
  const st = actions.find((x) => x.type === "status");
  assert.equal(st.agent.id, "a3");
  assert.equal(st.agent.work, "working");
  assert.deepEqual(actions.find((x) => x.type === "celebrate"), { type: "celebrate", pushId: "p2" });
  assert.equal(actions.find((x) => x.type === "incident").active, true);
  assert.deepEqual(diffOfficeSnapshots(b, b), []);
});
