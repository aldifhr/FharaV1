#!/usr/bin/env node
// Test double for `opencode debug agent <name>` (L1): prints the agent's
// flattened permission rules the way opencode 1.19.5 does, built from
// OPENCODE_CONFIG_CONTENT. A config-level block comes first, the agent's own
// rules last (as the real CLI orders them). Optional FAKE_EXTRA_RULES (JSON
// rows) are appended to simulate a looser loaded ruleset.
//
// `opencode debug skill` reaches this script with an empty name (the test
// shims pass "$3"): it prints OpenCode's one built-in skill plus the rows in
// FAKE_SKILLS (JSON array of {name, location}), and only when
// OPENCODE_DISABLE_EXTERNAL_SKILLS is unset FAKE_REPO_SKILLS too (the
// repo's .claude/.agents skills, as 1.19.5 does).
const name = process.argv[2];
if (!name || name === "skill") {
  const skills = [
    { name: "customize-opencode", description: "built-in", location: "<built-in>", content: "" },
    ...JSON.parse(process.env.FAKE_SKILLS || "[]"),
    ...(process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS === "1" ? [] : JSON.parse(process.env.FAKE_REPO_SKILLS || "[]")),
  ];
  process.stdout.write(JSON.stringify(skills, null, 2));
  process.exit(0);
}
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
