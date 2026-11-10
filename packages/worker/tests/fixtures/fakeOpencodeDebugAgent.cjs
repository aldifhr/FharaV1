#!/usr/bin/env node
// Test double for `opencode debug agent <name>` (L1): prints the agent's
// flattened permission rules the way opencode 1.19.5 does, built from
// OPENCODE_CONFIG_CONTENT. A config-level block comes first, the agent's own
// rules last (as the real CLI orders them). Optional FAKE_EXTRA_RULES (JSON
// rows) are appended to simulate a looser loaded ruleset.
const name = process.argv[2];
const content = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}");
const flatten = (block) => {
  const rows = [];
  if (!block || typeof block !== "object") return rows;
  for (const [permission, value] of Object.entries(block)) {
    if (typeof value === "string") rows.push({ permission, action: value, pattern: "*" });
    else for (const [pattern, action] of Object.entries(value)) rows.push({ permission, pattern, action });
  }
  return rows;
};
const agent = (content.agent || {})[name];
if (!agent) {
  process.stderr.write(`agent ${name} not found\n`);
  process.exit(1);
}
const rows = [
  { permission: "*", action: "allow", pattern: "*" },
  ...flatten(content.permission),
  ...flatten(agent.permission),
  ...JSON.parse(process.env.FAKE_EXTRA_RULES || "[]"),
];
process.stdout.write(JSON.stringify({ name, mode: agent.mode, permission: rows }, null, 2));
