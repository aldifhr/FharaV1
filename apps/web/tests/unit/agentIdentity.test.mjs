import { test } from "node:test";
import assert from "node:assert/strict";
import { agentDisplayName, agentRoleCaption, fixedAgentIds } from "../../lib/agentIdentity.ts";

const label = (role) => role.charAt(0).toUpperCase() + role.slice(1);

test("display name is the agent's own name, falling back to the role label", () => {
  assert.equal(agentDisplayName({ _id: "a", name: "Reviewer 2", role: "reviewer" }, label), "Reviewer 2");
  assert.equal(agentDisplayName({ _id: "a", name: "  ", role: "reviewer" }, label), "Reviewer");
});

test("role caption only when it differs from the name", () => {
  assert.equal(agentRoleCaption({ _id: "a", name: "Reviewer", role: "reviewer" }, label), null);
  assert.equal(agentRoleCaption({ _id: "a", name: "Reviewer 2", role: "reviewer" }, label), "Reviewer");
});

test("fixed agents: the oldest per fixed role; extras and custom roles are removable", () => {
  const agents = [
    { _id: "r2", name: "Reviewer 2", role: "reviewer", _creationTime: 30 },
    { _id: "r1", name: "Reviewer", role: "reviewer", _creationTime: 10 },
    { _id: "cto", name: "CTO", role: "cto", _creationTime: 5 },
    { _id: "sec", name: "Security", role: "security", _creationTime: 40 },
    { _id: "old", name: "Lead", role: "lead", _creationTime: 1 },
  ];
  const ids = fixedAgentIds(agents, ["cto", "reviewer"], ["lead"]);
  assert.deepEqual([...ids].sort(), ["cto", "r1"]);
  assert.equal(fixedAgentIds(undefined, ["cto"]).size, 0);
});
