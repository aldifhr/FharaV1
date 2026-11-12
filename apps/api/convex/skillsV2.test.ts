/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { loadPromptSkills } from "./skillLibrary";
import {
  formatSkillsSection,
  LOAD_SKILL_MAX_CALLS,
  SKILLS_PROMPT_BUDGET,
  type PromptSkill,
} from "./lib/skills";
import {
  appendAgentSkills,
  createSkillLoader,
  formatSkillsIndex,
  skillsSectionFor,
  wantsLoadSkillTool,
} from "./lib/skillRuntime";
import {
  agentPermissions,
  brokenDependencies,
  createsDependencyCycle,
  diffLines,
  expandWithDependencies,
  missingPermissions,
  normalizeSkillPermission,
} from "./lib/skillGraph";
import { parseFrontMatterList, parseSkillMarkdown } from "./lib/githubSkills";
import { runRepoToolLoop } from "./lib/chat/repoTools";
import { buildRepoToolProtocol } from "./lib/prompts/chat";

const modules = import.meta.glob("./**/*.ts");

type T = ReturnType<typeof convexTest>;

async function agent(t: T, role: string, extra: Record<string, unknown> = {}) {
  return await t.run((ctx) =>
    ctx.db.insert("agents", { name: role, role, status: "idle", isEnabled: true, ...extra } as never)
  );
}

async function promptSkills(t: T, agentId: string) {
  return await t.run(async (ctx) => loadPromptSkills(ctx, (await ctx.db.get(agentId as never))! as never));
}

describe("versions", () => {
  test("create → v1, edit → v2, no-op edit → no version, history newest first", async () => {
    const t = convexTest(schema, modules);
    const skillId = await t.mutation(api.skills.create, { name: "Lint", instructions: "run lint" });
    expect((await t.query(api.skills.get, { skillId }))?.version).toBe(1);

    const edit = await t.mutation(api.skills.update, { skillId, instructions: "run lint\nthen fix", note: "add fix" });
    expect(edit.version).toBe(2);
    expect(await t.mutation(api.skills.update, { skillId, instructions: "run lint\nthen fix" })).toEqual({
      version: null,
      warnings: [],
    });

    const history = await t.query(api.skills.versions, { skillId });
    expect(history.map((h) => [h.version, h.kind, h.note ?? null])).toEqual([
      [2, "edit", "add fix"],
      [1, "create", null],
    ]);
    expect(history[0].author).toBe("user");
    expect(history[0]).not.toHaveProperty("instructions");
    expect(history[0].size).toBe("run lint\nthen fix".length);
  });

  test("diff between versions and against current", async () => {
    const t = convexTest(schema, modules);
    const skillId = await t.mutation(api.skills.create, { name: "D", instructions: "a\nb\nc" });
    await t.mutation(api.skills.update, { skillId, instructions: "a\nB\nc\nd", description: "new" });
    const diff = await t.query(api.skills.diff, { skillId, from: 1, to: 2 });
    expect(diff.stats).toEqual({ added: 2, removed: 1 });
    expect(diff.fields).toEqual(["description"]);
    expect(diff.lines).toEqual([
      { op: "same", text: "a" },
      { op: "del", text: "b" },
      { op: "add", text: "B" },
      { op: "same", text: "c" },
      { op: "add", text: "d" },
    ]);
    const current = await t.query(api.skills.diff, { skillId, from: 2 });
    expect(current.to).toBeNull();
    expect(current.stats).toEqual({ added: 0, removed: 0 });
  });

  test("rollback writes a NEW version with the old content and is audited", async () => {
    const t = convexTest(schema, modules);
    const skillId = await t.mutation(api.skills.create, { name: "R", instructions: "v1 text", tags: ["x"] });
    await t.mutation(api.skills.update, { skillId, name: "R2", instructions: "v2 text", tags: [] });
    const { version } = await t.mutation(api.skills.rollback, { skillId, version: 1 });
    expect(version).toBe(3);
    const row = await t.query(api.skills.get, { skillId });
    expect(row).toMatchObject({ name: "R", instructions: "v1 text", tags: ["x"], version: 3 });
    const history = await t.query(api.skills.versions, { skillId });
    expect(history.map((h) => h.kind)).toEqual(["rollback", "edit", "create"]);
    expect(history[0].note).toBe("Rolled back to v1");
    const audit = await t.run((ctx) => ctx.db.query("audit").collect());
    expect(audit.find((a) => a.action === "skill.rollback")).toMatchObject({
      target: "R",
      details: { from: 2, to: 1, newVersion: 3 },
    });
    await expect(t.mutation(api.skills.rollback, { skillId, version: 9 })).rejects.toThrow(/Version 9 not found/);
  });

  test("a pre-v2 skill gets a baseline version before its first edit; backfill is idempotent", async () => {
    const t = convexTest(schema, modules);
    const legacy = await t.run((ctx) =>
      ctx.db.insert("skills", { name: "Old", description: "", instructions: "old body", createdAt: 1, updatedAt: 1 })
    );
    const other = await t.run((ctx) =>
      ctx.db.insert("skills", { name: "Other", description: "", instructions: "x", createdAt: 1, updatedAt: 1 })
    );
    await t.mutation(api.skills.update, { skillId: legacy, instructions: "new body" });
    const history = await t.query(api.skills.versions, { skillId: legacy });
    expect(history.map((h) => [h.version, h.kind, h.author])).toEqual([
      [2, "edit", "user"],
      [1, "baseline", "system"],
    ]);
    expect((await t.query(api.skills.getVersion, { skillId: legacy, version: 1 }))?.instructions).toBe("old body");
    expect(await t.mutation(api.skills.backfillVersions, {})).toEqual({ backfilled: 1 });
    expect(await t.mutation(api.skills.backfillVersions, {})).toEqual({ backfilled: 0 });
    expect((await t.query(api.skills.get, { skillId: other }))?.version).toBe(1);
  });

  test("pin a version: the agent runs it; unpin follows latest; detaching drops the pin", async () => {
    const t = convexTest(schema, modules);
    const fe = await agent(t, "frontend");
    const skillId = await t.mutation(api.skills.create, { name: "P", instructions: "first" });
    await t.mutation(api.agents.setSkills, { agentId: fe, skillIds: [skillId] });
    await t.mutation(api.skills.update, { skillId, instructions: "second" });

    await t.mutation(api.skills.setPin, { agentId: fe, skillId, version: 1 });
    expect((await promptSkills(t, fe))[0]).toMatchObject({ instructions: "first", version: 1 });
    const listed = (await t.query(api.skills.list, {}))[0];
    expect(listed.usedBy[0].pinnedVersion).toBe(1);
    expect((await t.query(api.skills.versions, { skillId })).find((h) => h.version === 1)?.pinnedBy.map((a) => a.role)).toEqual([
      "frontend",
    ]);

    await t.mutation(api.skills.setPin, { agentId: fe, skillId, version: null });
    expect((await promptSkills(t, fe))[0]).toMatchObject({ instructions: "second", version: 2 });

    await t.mutation(api.skills.setPin, { agentId: fe, skillId, version: 1 });
    await t.mutation(api.agents.setSkills, { agentId: fe, skillIds: [] });
    expect((await t.run((ctx) => ctx.db.get(fe)))?.skillPins).toBeUndefined();
    await expect(t.mutation(api.skills.setPin, { agentId: fe, skillId, version: 1 })).rejects.toThrow(/does not use/);
    const audit = await t.run((ctx) => ctx.db.query("audit").collect());
    expect(audit.filter((a) => a.action === "skill.pin")).toHaveLength(2);
  });

  test("remove deletes history and pins", async () => {
    const t = convexTest(schema, modules);
    const fe = await agent(t, "frontend");
    const skillId = await t.mutation(api.skills.create, { name: "Gone", instructions: "x" });
    await t.mutation(api.agents.setSkills, { agentId: fe, skillIds: [skillId] });
    await t.mutation(api.skills.setPin, { agentId: fe, skillId, version: 1 });
    await t.mutation(api.skills.remove, { skillId });
    expect(await t.run((ctx) => ctx.db.query("skillVersions").collect())).toHaveLength(0);
    const row = await t.run((ctx) => ctx.db.get(fe));
    expect(row?.skillIds).toBeUndefined();
    expect(row?.skillPins).toBeUndefined();
  });
});

describe("dependencies", () => {
  test("pure resolution: transitive, ordered, cycle-safe, missing reported", () => {
    const req = new Map<string, string[]>([
      ["c", ["b"]],
      ["b", ["a"]],
      ["a", ["c"]], // cycle
      ["x", ["gone"]],
    ]);
    expect(expandWithDependencies(["c"], req)).toEqual({ ids: ["c", "b", "a"], added: ["b", "a"], missing: [] });
    expect(expandWithDependencies(["x"], req)).toEqual({ ids: ["x"], added: [], missing: ["gone"] });
    expect(createsDependencyCycle("a", ["b"], new Map([["b", ["a"]]]))).toBe(true);
    expect(createsDependencyCycle("a", ["b"], new Map([["b", []]]))).toBe(false);
    expect(brokenDependencies(["a"], ["b"], new Map([["b", ["a"]]]))).toEqual([{ removed: "a", requiredBy: ["b"] }]);
  });

  test("assigning a skill pulls in what it requires, with a warning", async () => {
    const t = convexTest(schema, modules);
    const fe = await agent(t, "frontend");
    const base = await t.mutation(api.skills.create, { name: "Base", instructions: "base" });
    const mid = await t.mutation(api.skills.create, { name: "Mid", instructions: "mid", requires: [base] });
    const top = await t.mutation(api.skills.create, { name: "Top", instructions: "top", requires: [mid] });

    const res = await t.mutation(api.agents.setSkills, { agentId: fe, skillIds: [top] });
    expect(res.skillIds).toEqual([top, mid, base]);
    expect(res.warnings).toEqual([
      'Also added "Mid" to Frontend: required by "Top".',
      'Also added "Base" to Frontend: required by "Mid".',
    ]);

    // Role assignment and "Used by" pull dependencies in too.
    const be = await agent(t, "backend");
    const assigned = await t.mutation(api.skills.assignRoles, { skillId: mid, roles: ["backend", "frontend"] });
    expect(assigned.added).toBe(1);
    expect((await t.run((ctx) => ctx.db.get(be)))?.skillIds).toEqual([mid, base]);
    expect(assigned.warnings).toEqual(['Also added "Base" to Backend: required by "Mid".']);
  });

  test("removing a required skill is allowed but warns; it is not silently re-added", async () => {
    const t = convexTest(schema, modules);
    const fe = await agent(t, "frontend");
    const base = await t.mutation(api.skills.create, { name: "Base", instructions: "base" });
    const top = await t.mutation(api.skills.create, { name: "Top", instructions: "top", requires: [base] });
    await t.mutation(api.agents.setSkills, { agentId: fe, skillIds: [top] });
    const res = await t.mutation(api.agents.setSkills, { agentId: fe, skillIds: [top] /* Base unticked */ });
    expect(res.skillIds).toEqual([top]);
    expect(res.warnings).toEqual(['Frontend still has "Top", which requires "Base".']);
    // Removing both is quiet.
    expect((await t.mutation(api.agents.setSkills, { agentId: fe, skillIds: [] })).warnings).toEqual([]);
  });

  test("requires: self, cycles and unknown ids are rejected; new deps reach agents already using it", async () => {
    const t = convexTest(schema, modules);
    const fe = await agent(t, "frontend");
    const a = await t.mutation(api.skills.create, { name: "A", instructions: "a" });
    const b = await t.mutation(api.skills.create, { name: "B", instructions: "b", requires: [a] });
    await expect(t.mutation(api.skills.update, { skillId: a, requires: [a] })).rejects.toThrow(/itself/);
    await expect(t.mutation(api.skills.update, { skillId: a, requires: [b] })).rejects.toThrow(/require each other/);

    const c = await t.mutation(api.skills.create, { name: "C", instructions: "c" });
    await t.mutation(api.agents.setSkills, { agentId: fe, skillIds: [c] });
    const res = await t.mutation(api.skills.update, { skillId: c, requires: [b] });
    expect((await t.run((ctx) => ctx.db.get(fe)))?.skillIds).toEqual([c, b, a]);
    expect(res.warnings).toContain('Also added "B" to Frontend: required by "C".');
    const dropped = await t.mutation(api.skills.update, { skillId: c, requires: [] });
    expect(dropped.warnings).toEqual(['"C" no longer requires "B"; agents keep it until you remove it.']);

    const list = await t.query(api.skills.list, {});
    expect(list.find((s) => s.name === "B")?.requiresNames).toEqual(["A"]);
    expect(list.find((s) => s.name === "A")?.requiredBy.map((s) => s.name)).toEqual(["B"]);

    // Deleting a required skill drops the requirement with a warning.
    const removed = await t.mutation(api.skills.remove, { skillId: a });
    expect(removed.warnings).toEqual(['"B" required "A"; that requirement was removed.']);
    expect((await t.query(api.skills.get, { skillId: b }))?.requires).toBeUndefined();
  });

  test("SKILL.md front matter: requires + allowed-tools", () => {
    expect(parseFrontMatterList("[a, 'b c']")).toEqual(["a", "b c"]);
    expect(parseFrontMatterList("- one\n- two")).toEqual(["one", "two"]);
    expect(parseFrontMatterList("Bash(npm test:*) Read Edit")).toEqual(["Bash(npm test:*)", "Read", "Edit"]);
    const parsed = parseSkillMarkdown(
      "---\nname: x\ndescription: d\nrequires: [base-skill]\nallowed-tools: Bash Read\n---\nbody",
      "skills/x/SKILL.md",
      "r"
    );
    expect(parsed.requires).toEqual(["base-skill"]);
    expect(parsed.permissions).toEqual(["Bash", "Read"]);
  });
});

describe("permissions (advisory only)", () => {
  test("normalization and role tool sets", () => {
    expect(normalizeSkillPermission("Bash(git:*)")).toBe("run_command");
    expect(normalizeSkillPermission("Edit")).toBe("write_file");
    expect(normalizeSkillPermission("WebFetch")).toBe("network");
    expect(normalizeSkillPermission("playwright")).toBe("browser");
    expect(normalizeSkillPermission("nonsense")).toBeNull();
    // Reviewer is read-only even if it declares run_command.
    expect([...agentPermissions({ role: "reviewer", supportedTools: ["read_file", "run_command"] })]).toEqual(["read_file"]);
    expect(missingPermissions(["run_command", "browser"], { role: "qa" })).toEqual([]);
    expect(missingPermissions(["run_command", "browser"], { role: "backend" })).toEqual(["browser"]);
  });

  test("assigning a skill that needs run_command to the Reviewer warns and grants nothing", async () => {
    const t = convexTest(schema, modules);
    const reviewer = await agent(t, "reviewer", { supportedTools: ["read_file"] });
    const backend = await agent(t, "backend", { supportedTools: ["read_file", "write_file", "run_command"] });
    const skillId = await t.mutation(api.skills.create, {
      name: "Run tests",
      instructions: "npm test",
      permissions: ["Bash", "run_command", "bogus"],
    });
    expect((await t.query(api.skills.get, { skillId }))?.permissions).toEqual(["run_command"]);

    const res = await t.mutation(api.skills.assignRoles, { skillId, roles: ["reviewer", "backend"] });
    expect(res.warnings).toEqual(['Reviewer lacks run commands, which "Run tests" needs. Skills never grant tools.']);
    expect((await t.run((ctx) => ctx.db.get(reviewer)))?.supportedTools).toEqual(["read_file"]);
    expect((await t.run((ctx) => ctx.db.get(backend)))?.supportedTools).toEqual(["read_file", "write_file", "run_command"]);
    const listed = (await t.query(api.skills.list, {}))[0];
    expect(listed.usedBy.find((a) => a.role === "reviewer")?.missingPermissions).toEqual(["run_command"]);

    // Adding a permission later warns about agents already using it.
    const other = await t.mutation(api.skills.create, { name: "Browse", instructions: "b" });
    await t.mutation(api.agents.setSkills, { agentId: backend, skillIds: [other] });
    const edit = await t.mutation(api.skills.update, { skillId: other, permissions: ["browser"] });
    expect(edit.warnings).toEqual(['Backend lacks browser, which "Browse" needs. Skills never grant tools.']);

    // The worker receives the agent row unchanged: supportedTools never widened.
    const run = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "p", agentIds: [reviewer] } as never);
      return await ctx.db.insert("tasks", { projectId, title: "t", command: "c", status: "queued" } as never);
    });
    const runCtx = await t.query(internal.orchestration.getRunContext, { taskId: run });
    expect(runCtx!.agents[0].supportedTools).toEqual(["read_file"]);
  });
});

const SKILLS: PromptSkill[] = [
  { name: "Alpha", description: "First one", instructions: "A".repeat(100), fullInstructions: "A".repeat(100), version: 2 },
  { name: "Beta", description: "Second", instructions: "B".repeat(50) },
];

describe("on-demand loading", () => {
  test("inline mode is exactly the old section; on_demand lists names + descriptions only", () => {
    expect(skillsSectionFor(SKILLS, "inline")).toBe(formatSkillsSection(SKILLS, SKILLS_PROMPT_BUDGET));
    expect(skillsSectionFor(SKILLS, undefined)).toBe(formatSkillsSection(SKILLS));
    expect(appendAgentSkills("base", SKILLS, "inline")).toBe(`base\n\n${formatSkillsSection(SKILLS)}`);

    const index = skillsSectionFor(SKILLS, "on_demand");
    expect(index).toContain("## Skills (load on demand)");
    expect(index).toContain("- Alpha: First one (100 chars)");
    expect(index).toContain("- Beta: Second (50 chars)");
    expect(index).not.toContain("AAAA");
    expect(index).toContain(`at most ${LOAD_SKILL_MAX_CALLS} per run`);
    expect(wantsLoadSkillTool(SKILLS, "on_demand")).toBe(true);
    expect(wantsLoadSkillTool(SKILLS, "inline")).toBe(false);
    expect(wantsLoadSkillTool([], "on_demand")).toBe(false);
  });

  test("the index stays within its budget and says how many it left out", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ name: `Skill ${i}`, description: "d".repeat(80), instructions: "x" }));
    const index = formatSkillsIndex(many, 2_000);
    expect(index.length).toBeLessThanOrEqual(2_100);
    expect(index).toMatch(/…and \d+ more \(load by name\)/);
  });

  test("the 12k problem: three long skills — inline drops the third, on_demand reaches all three untrimmed", () => {
    const long = (n: string) => ({ name: n, description: n, instructions: `# ${n}\n\n${"y".repeat(11_000)}` });
    const three = [long("emil-design-eng"), long("apple-design"), long("animation-vocabulary")];
    const inline = formatSkillsSection(three);
    expect(inline).toContain("…(truncated)");
    expect(inline).not.toContain("## Skill: animation-vocabulary");
    const loader = createSkillLoader(three);
    for (const s of three) {
      const res = loader.load(s.name);
      expect(res.ok).toBe(true);
      expect(res.text).toContain("y".repeat(11_000));
    }
  });

  test("load_skill caps: chars per call, calls per run, repeats are free, unknown names list the skills", () => {
    const big = [{ name: "Big", instructions: "z".repeat(50_000) }, ...SKILLS];
    const loader = createSkillLoader(big, { maxCalls: 2, maxChars: 1_000 });
    const first = loader.load("big");
    expect(first.ok && first.truncated).toBe(true);
    expect(first.text.length).toBeLessThanOrEqual(1_000);
    expect(first.text).toMatch(/\[truncated: showing 1,000 of 50,000 chars\]$/);
    expect(loader.load("Big").text).toMatch(/already loaded/);
    expect(loader.calls).toBe(1);
    expect(loader.load("Nope")).toEqual({ ok: false, text: 'No skill named "Nope". Your skills: Big, Alpha, Beta.' });
    expect(loader.load("alpha").text).toMatch(/^## Skill: Alpha \(v2\)\n/);
    const third = loader.load("Beta");
    expect(third.ok).toBe(false);
    expect(third.text).toMatch(/limit reached \(2 per run\)/);
    expect(loader.loaded).toEqual(["Big", "Alpha"]);
  });

  test("chat loop: load_skill runs as a local tool, outside the repo budget", async () => {
    const loader = createSkillLoader(SKILLS);
    const repoCalls: string[] = [];
    const replies = [
      '{"tool":"load_skill","arguments":{"name":"Alpha"}}',
      '{"tool":"grep","arguments":{"pattern":"x"}}',
      "Answer using Alpha.",
    ];
    const seen: string[] = [];
    const result = await runRepoToolLoop({
      messages: [{ role: "user", content: "q" }],
      maxCalls: 0,
      localTools: { load_skill: (call) => ({ ok: true, text: loader.load(call.args.name).text }) },
      maxLocalCalls: 3,
      step: async (msgs) => {
        seen.push(msgs[msgs.length - 1].content);
        return { content: replies.shift() ?? "done" };
      },
      callTool: async (call) => {
        repoCalls.push(call.tool);
        return { ok: true, text: "" };
      },
    });
    expect(result.answer).toBe("Answer using Alpha.");
    expect(repoCalls).toEqual([]);
    expect(result.repoCalls).toBe(0);
    expect(seen[1]).toContain("## Skill: Alpha (v2)");
    expect(seen[1]).toContain("A".repeat(100));
    expect(seen[2]).toMatch(/Tool "grep" is not available\. Read-only tools: load_skill\./);
  });

  test("repo tool protocol wording is unchanged unless load_skill is offered", () => {
    expect(buildRepoToolProtocol(6)).toContain("At most 6 tool calls per reply.");
    expect(buildRepoToolProtocol(6)).not.toContain("load_skill");
    const both = buildRepoToolProtocol(6, { loadSkill: true });
    expect(both).toContain("At most 6 repo tool calls per reply.");
    expect(both).toContain('- load_skill {"name": skill name}');
  });

  test("chat context: on_demand gets an index, inline stays inline, every agent can load the library", async () => {
    const t = convexTest(schema, modules);
    const skillId = await t.mutation(api.skills.create, { name: "Guide", description: "How we work", instructions: "full guide text" });
    await t.mutation(api.skills.create, { name: "Release", description: "Release steps", instructions: "release body" });
    const cto = await agent(t, "cto", { skillIds: [skillId], skillLoading: "on_demand" });
    const fe = await agent(t, "frontend", { skillIds: [skillId] });
    const projectId = await t.run((ctx) => ctx.db.insert("projects", { name: "P", workspacePath: "p", agentIds: [cto, fe] } as never));
    const context = await t.query(internal.chatContext.getContext, { projectId, preferredAgentIds: [cto, fe] });
    const byRole = new Map(context.team!.map((a: { role: string }) => [a.role, a] as const)) as Map<string, any>;
    expect(byRole.get("cto").skillsSection).toContain("- Guide: How we work");
    expect(byRole.get("cto").skillsSection).not.toContain("full guide text");
    expect(byRole.get("cto").onDemandSkills[0]).toMatchObject({ name: "Guide", fullInstructions: "full guide text" });
    // The inline agent keeps its own skill inline, and sees the rest of the
    // library as a load-on-demand index (never the body).
    expect(byRole.get("frontend").skillsSection).toContain("## Skill: Guide\nfull guide text");
    expect(byRole.get("frontend").skillsSection).toContain("- Release: Release steps");
    expect(byRole.get("frontend").skillsSection).not.toContain("release body");
    expect(byRole.get("frontend").onDemandSkills).toBeUndefined();
    // The library rides bodiless; load_skill fetches a body (skillLibrary.body).
    expect(byRole.get("frontend").librarySkills).toEqual([
      { name: "Guide", description: "How we work", version: 1 },
      { name: "Release", description: "Release steps", version: 1 },
    ]);
  });

  test("agents.update sets and resets skillLoading", async () => {
    const t = convexTest(schema, modules);
    const id = await agent(t, "designer");
    await t.mutation(api.agents.update, { agentId: id, name: "designer", role: "designer", systemPrompt: "", skillLoading: "on_demand" });
    expect((await t.run((ctx) => ctx.db.get(id)))?.skillLoading).toBe("on_demand");
    await t.mutation(api.agents.update, { agentId: id, name: "designer", role: "designer", systemPrompt: "", skillLoading: null });
    expect((await t.run((ctx) => ctx.db.get(id)))?.skillLoading).toBeUndefined();
  });
});

describe("diffLines", () => {
  test("identical, pure add, and large inputs", () => {
    expect(diffLines("a\nb", "a\nb").every((l) => l.op === "same")).toBe(true);
    expect(diffLines("", "x")).toEqual([
      { op: "del", text: "" },
      { op: "add", text: "x" },
    ]);
    const big = Array.from({ length: 3_001 }, (_, i) => `l${i}`).join("\n");
    const lines = diffLines(big, `${big}\nmore`);
    expect(lines.filter((l) => l.op === "add")).toHaveLength(3_002);
  });
});
