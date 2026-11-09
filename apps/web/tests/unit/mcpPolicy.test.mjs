import { test } from "node:test";
import assert from "node:assert/strict";
import { setsLocalCommand } from "../../lib/mcpPolicy.ts";

test("flags caller-chosen local commands only", () => {
  assert.equal(setsLocalCommand("add", { type: "local", command: "sh" }), true);
  assert.equal(setsLocalCommand("add", { type: "remote", url: "https://x" }), false);
  assert.equal(setsLocalCommand("add", { type: "remote", command: "sh" }), true);
  assert.equal(setsLocalCommand("create", { presetId: "custom", type: "local", command: "sh" }), true);
  assert.equal(setsLocalCommand("create", { presetId: "custom" }), true);
  assert.equal(setsLocalCommand("create", { presetId: "custom", type: "remote", url: "https://x" }), false);
  assert.equal(setsLocalCommand("create", { presetId: "filesystem", fields: { dirs: "/w" } }), false);
  assert.equal(setsLocalCommand("update", { serverId: "s", command: "sh" }), true);
  assert.equal(setsLocalCommand("update", { serverId: "s", commandArgs: [] }), true);
  assert.equal(setsLocalCommand("update", { serverId: "s", name: "x" }), false);
  assert.equal(setsLocalCommand("toggle", { serverId: "s", enabled: true }), false);
});
