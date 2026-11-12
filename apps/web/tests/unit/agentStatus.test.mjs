import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AGENT_STATUS_LABEL, agentStatusView, statusFromLeases, teamStatusLabel } from "../../lib/teamStatus.ts";
import { orderTeam } from "../../lib/agentIdentity.ts";
import { FIXED_TEAM_DISPLAY_ORDER, FIXED_TEAM_SEED_ORDER } from "../../../api/convex/lib/roles.ts";

const entry = (status, extra = {}) => ({ status, taskId: "t", taskTitle: "Task", projectName: null, subtaskKey: null, ...extra });

test("one vocabulary: Idle, Queued, Thinking, Working, Testing, Waiting on you, Disabled", () => {
  assert.deepEqual(Object.values(AGENT_STATUS_LABEL), ["Idle", "Queued", "Thinking", "Working", "Testing", "Waiting on you", "Disabled"]);
  const cases = [
    [undefined, {}, "Idle"],
    [undefined, { drafting: true }, "Thinking"],
    [entry("queued"), {}, "Queued"],
    [entry("working"), {}, "Working"],
    [entry("reviewing"), {}, "Working"],
    [entry("elsewhere", { projectName: "Iqbola" }), {}, "Working"],
    [entry("testing"), {}, "Testing"],
    [entry("waiting_on_you"), {}, "Waiting on you"],
    [entry("needs_you"), {}, "Waiting on you"],
    [entry("working"), { isEnabled: false }, "Disabled"],
    [undefined, { isEnabled: false, drafting: true }, "Disabled"],
  ];
  for (const [e, opts, label] of cases) assert.equal(agentStatusView(e, opts).label, label, JSON.stringify([e?.status, opts]));
  assert.equal(agentStatusView(entry("needs_you")).needsYou, true);
  assert.equal(agentStatusView(entry("working")).needsYou, false);
  assert.equal(agentStatusView(entry("elsewhere", { projectName: "Iqbola" })).detail, "Task · in Iqbola");
  assert.equal(teamStatusLabel(entry("queued")), "Queued");
});

test("a queued lease reads Queued (not Thinking) and a QA lease reads Testing", () => {
  const map = statusFromLeases(
    {
      a: { taskId: "t1", projectId: "p", taskTitle: "x", status: "queued" },
      b: { taskId: "t2", projectId: "p", taskTitle: "y", subtaskKey: "qa-1", status: "running" },
      c: { taskId: "t3", projectId: "p", taskTitle: "z", status: "waiting_approval" },
    },
    { otherProjects: "elsewhere", checkFirst: "review" },
  );
  assert.equal(agentStatusView(map.a).label, "Queued");
  assert.equal(agentStatusView(map.b).label, "Testing");
  assert.equal(agentStatusView(map.c).label, "Waiting on you");
});

test("the sidebar row and the agent panel map status through the same helper and the same source", () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  for (const file of ["../../components/sidebar/TeamList.tsx", "../../components/AgentDetailPanel.tsx"]) {
    const src = read(file);
    assert.match(src, /agentStatusView\(/, `${file} does not use agentStatusView`);
    assert.match(src, /<TeamStatusSource\b/, `${file} does not read status through TeamStatusSource`);
    assert.doesNotMatch(src, /statusFromActive|teamStatusLabel\(|api\.executionView\.activeByAgent/, `${file} has its own status mapping or source`);
  }
});

test("team order is fixed by role, never by status; extras follow oldest first", () => {
  assert.deepEqual([...FIXED_TEAM_DISPLAY_ORDER].sort(), [...FIXED_TEAM_SEED_ORDER].sort());
  assert.deepEqual(FIXED_TEAM_DISPLAY_ORDER, ["cto", "designer", "frontend", "backend", "qa", "reviewer", "devops", "researcher", "support"]);
  const agents = [
    { _id: "x2", role: "backend", _creationTime: 90 },
    { _id: "sup", role: "support", _creationTime: 1 },
    { _id: "qa", role: "qa", _creationTime: 2 },
    { _id: "x1", role: "custom", _creationTime: 50 },
    { _id: "cto", role: "cto", _creationTime: 3 },
    { _id: "be", role: "backend", _creationTime: 4 },
  ];
  const fixed = new Set(["sup", "qa", "cto", "be"]);
  assert.deepEqual(orderTeam(agents, fixed, FIXED_TEAM_DISPLAY_ORDER).map((a) => a._id), ["cto", "be", "qa", "sup", "x1", "x2"]);
});
