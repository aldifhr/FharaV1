// Paradev C1 drift test: the composer's slash commands and useProjectSlash's
// runSlash stay in step with the shared registry
// (apps/api/convex/lib/slashCommands.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FHARA_BUILTIN_COMMANDS } from "../../../api/convex/lib/slashCommands.ts";
import { personalSlashNames } from "../../lib/personalChat.ts";
import {
  SKILL_DISABLED_NOTE,
  committedUsage,
  completeSlash,
  filterSlashEntries,
  runsOnEnter,
  skillsUsedBy,
  slashMenuEntries,
} from "../../lib/slashMenu.ts";

// Registry builtins runSlash does not handle in the client: /research goes to
// the server as a message (intent.ts turns it into a task). /memory is wired
// in runSlash since Paradev C2.
const NOT_IN_RUN_SLASH = new Set(["research"]);

test("runSlash handles exactly the registry builtins it owns", () => {
  const src = readFileSync(new URL("../../components/chat/useProjectSlash.ts", import.meta.url), "utf8");
  const m = src.match(/const runSlash[\s\S]*?text\.match\(\/\^\\\/\(([a-z|]+)\)/);
  assert.ok(m, "runSlash's command regex not found in useProjectSlash.ts");
  const handled = new Set(m[1].split("|"));
  const registry = FHARA_BUILTIN_COMMANDS.map((c) => c.name);
  for (const name of handled) assert.ok(registry.includes(name), `runSlash handles /${name}, which is not in the registry`);
  assert.deepEqual(
    registry.filter((n) => !handled.has(n)).sort(),
    [...NOT_IN_RUN_SLASH].sort(),
    "registry builtins not handled by runSlash changed; update runSlash or NOT_IN_RUN_SLASH",
  );
});

test("personal chat slash names come from the registry's personal scope", () => {
  assert.deepEqual(personalSlashNames(false), []);
  assert.deepEqual(personalSlashNames(true), ["task"]);
});

// ---------------------------------------------------------------------------
// Paradev C2: the composer's "/" menu (lib/slashMenu.ts)
// ---------------------------------------------------------------------------

const SKILLS = [
  { name: "frontend-design", description: "Design polished UI" },
  { name: "release-notes", description: "Write release notes" },
];
const project = slashMenuEntries("project", SKILLS);
const names = (state) => state?.matches.map((e) => e.name) ?? null;

test("'/' lists Commands first, then Skills", () => {
  const state = filterSlashEntries("/", project);
  assert.deepEqual(names(state), ["memory", "push", "qa", "research", "review", "task", "frontend-design", "release-notes"]);
  const kinds = state.matches.map((e) => e.entryKind);
  assert.equal(kinds.indexOf("skill"), FHARA_BUILTIN_COMMANDS.length, "skills follow every project builtin");
  assert.ok(kinds.slice(kinds.indexOf("skill")).every((k) => k === "skill"));
  assert.deepEqual(state.matches.slice(0, 6).map((e) => e.name).sort(), FHARA_BUILTIN_COMMANDS.map((c) => c.name).sort());
});

test("'/re' → research then review (prefix rank, then name), skills after", () => {
  assert.deepEqual(names(filterSlashEntries("/re", project)), ["research", "review", "release-notes"]);
  // contains-match ranks below prefix within builtins too: "/sh" hits push only.
  assert.deepEqual(names(filterSlashEntries("/sh", project)), ["push"]);
});

test("menu stays closed for non-slash drafts and unknown words", () => {
  assert.equal(filterSlashEntries("", project), null);
  assert.equal(filterSlashEntries("hello /task", project), null);
  assert.equal(filterSlashEntries("/usr/bin is broken", project), null);
  assert.equal(filterSlashEntries("/zzz", project), null);
  assert.equal(filterSlashEntries("/ hello", project), null);
});

test("opens when '/' is typed in front of existing text; hides once an arg-taking command has a space", () => {
  assert.deepEqual(names(filterSlashEntries("/re fix the login bug", project)), ["research", "review", "release-notes"]);
  assert.equal(filterSlashEntries("/task ", project), null);
  assert.equal(filterSlashEntries("/research 3 why is CI slow", project), null);
  assert.equal(filterSlashEntries("/frontend-design make it nicer", project), null);
  // No space yet: still open on the exact command.
  assert.deepEqual(names(filterSlashEntries("/task", project)), ["task"]);
  // A no-argument command stays open so Enter can run it.
  assert.deepEqual(names(filterSlashEntries("/push ", project)), ["push"]);
});

test("Tab/Enter completion keeps the text after the word", () => {
  assert.equal(completeSlash("/re", "research"), "/research ");
  assert.equal(completeSlash("/re fix the bug", "review"), "/review fix the bug");
  assert.equal(completeSlash("/", "task"), "/task ");
});

test("Enter runs only an exact no-argument command", () => {
  const push = project.find((e) => e.name === "push");
  const task = project.find((e) => e.name === "task");
  assert.equal(runsOnEnter(filterSlashEntries("/push", project), push), true);
  assert.equal(runsOnEnter(filterSlashEntries("/push ", project), push), true);
  assert.equal(runsOnEnter(filterSlashEntries("/pu", project), push), false);
  assert.equal(runsOnEnter(filterSlashEntries("/task", project), task), false);
});

test("skills are listed but disabled until C3; builtin names are never shadowed", () => {
  const entries = slashMenuEntries("project", [...SKILLS, { name: "Push", description: "dup" }, { name: "frontend-design" }]);
  const skills = entries.filter((e) => e.entryKind === "skill");
  assert.deepEqual(skills.map((s) => s.name), ["frontend-design", "release-notes"]);
  assert.ok(skills.every((s) => s.disabled && s.disabledNote === SKILL_DISABLED_NOTE && s.argumentHint === "[request]"));
  assert.ok(entries.filter((e) => e.entryKind === "command").every((e) => !e.disabled));
  const skill = skills[0];
  assert.equal(runsOnEnter(filterSlashEntries("/frontend-design", entries), skill), false);
});

test("personal scope: no commands until a project is attached, then /task", () => {
  assert.deepEqual(slashMenuEntries("personal", []).map((e) => e.name), []);
  assert.deepEqual(slashMenuEntries("personal", [], { attached: true }).map((e) => e.name), ["task"]);
  assert.deepEqual(names(filterSlashEntries("/", slashMenuEntries("personal", SKILLS))), ["frontend-design", "release-notes"]);
});

test("skillsUsedBy keeps skills assigned to the given agents", () => {
  const rows = [
    { name: "a", usedBy: [{ _id: "agent1" }] },
    { name: "b", usedBy: [{ _id: "agent2" }] },
    { name: "c" },
  ];
  assert.deepEqual(skillsUsedBy(rows, ["agent2"]).map((s) => s.name), ["b"]);
  assert.deepEqual(skillsUsedBy(rows, []), []);
  assert.deepEqual(skillsUsedBy(undefined, ["agent1"]), []);
});

test("usage line shows the argument hint once a command is committed", () => {
  assert.equal(committedUsage("/task ", project), "/task <what to do>");
  assert.equal(committedUsage("/research ", project), "/research [2-6] <question>");
  assert.equal(committedUsage("/task do it", project), null);
  assert.equal(committedUsage("/push ", project), null);
  assert.equal(committedUsage("/frontend-design ", project), null);
});

test("composer reads the registry, not a hard-coded list, and Esc keeps the draft", () => {
  const src = readFileSync(new URL("../../components/chat/ChatComposer.tsx", import.meta.url), "utf8");
  assert.ok(!/SLASH_COMMANDS/.test(src), "hard-coded SLASH_COMMANDS is back");
  assert.ok(/filterSlashEntries\(/.test(src));
  assert.ok(!/else onDraftChange\(""\)/.test(src), "Esc must not clear the draft");
});
