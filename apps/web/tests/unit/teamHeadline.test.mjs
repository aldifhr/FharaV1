import { test } from "node:test";
import assert from "node:assert/strict";
import { teamHeadline, teamLoaded } from "../../lib/teamHeadline.ts";

test("server and first client render agree: not hydrated means Loading… even with data", () => {
  const agents = new Array(9).fill({});
  // Server: never hydrated, query undefined.
  assert.equal(teamHeadline(teamLoaded(false, undefined), 0, 0), "Loading…");
  // First client render: the query may already answer, but hydration is pending.
  assert.equal(teamHeadline(teamLoaded(false, agents), agents.length, 0), "Loading…");
});

test("after hydration the summary shows counts", () => {
  const agents = new Array(9).fill({});
  assert.equal(teamHeadline(teamLoaded(true, agents), 9, 0), "9 agents · all idle");
  assert.equal(teamHeadline(teamLoaded(true, agents), 9, 2), "9 agents · 2 working now");
  assert.equal(teamHeadline(true, 1, 0), "1 agent · all idle");
  assert.equal(teamHeadline(teamLoaded(true, undefined), 0, 0), "Loading…");
});
