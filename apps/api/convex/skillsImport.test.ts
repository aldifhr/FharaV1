/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  EMIL_SKILLS_ROLE_MAPPING,
  findSkillFiles,
  fitSkillBody,
  parseFrontMatter,
  parseGithubSkillUrl,
  parseSkillMarkdown,
  SKILL_IMPORT_MAX,
} from "./lib/githubSkills";
import { SKILLS_PROMPT_BUDGET } from "./lib/skills";

const modules = import.meta.glob("./**/*.ts");

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("github skill helpers", () => {
  test("parses repo, tree and blob URLs", () => {
    expect(parseGithubSkillUrl("https://github.com/emilkowalski/skills")).toEqual({
      owner: "emilkowalski", repo: "skills", path: "", kind: "repo",
    });
    expect(parseGithubSkillUrl("github.com/emilkowalski/skills.git/")).toMatchObject({ repo: "skills", kind: "repo" });
    expect(parseGithubSkillUrl("https://github.com/emilkowalski/skills/tree/main/skills")).toEqual({
      owner: "emilkowalski", repo: "skills", ref: "main", path: "skills", kind: "tree",
    });
    expect(parseGithubSkillUrl("https://github.com/o/r/blob/main/skills/break-ui/SKILL.md?plain=1")).toEqual({
      owner: "o", repo: "r", ref: "main", path: "skills/break-ui/SKILL.md", kind: "blob",
    });
    expect(() => parseGithubSkillUrl("https://gitlab.com/o/r")).toThrow(/github\.com/);
    expect(() => parseGithubSkillUrl("https://github.com/o/r/blob/main/README.md")).toThrow(/SKILL\.md/);
    // Dot segments are normalised away by URL parsing; the path never escapes.
    expect(parseGithubSkillUrl("https://github.com/o/r/tree/main/a/../../x").path).not.toContain("..");
  });

  test("parses front matter: plain, quoted, folded, block, and none", () => {
    const fm = parseFrontMatter(
      [
        "---",
        "name: break-ui",
        'description: "Stress-test a UI: edge cases, \\"weird\\" input"',
        "license: MIT",
        "summary: >",
        "  folded line one",
        "  line two",
        "notes: |",
        "  keep",
        "  lines",
        "---",
        "",
        "# Body",
        "text",
      ].join("\r\n")
    );
    expect(fm.data).toEqual({
      name: "break-ui",
      description: 'Stress-test a UI: edge cases, "weird" input',
      license: "MIT",
      summary: "folded line one line two",
      notes: "keep\nlines",
    });
    expect(fm.body).toBe("# Body\ntext");
    expect(parseFrontMatter("# Title\n\nHello")).toEqual({ data: {}, body: "# Title\n\nHello" });
  });

  test("falls back to folder name and first paragraph without front matter", () => {
    const parsed = parseSkillMarkdown(
      "# Pick a UI library\n\n> quote\n\nChoose the right component library\nfor the job.\n\n## More",
      "skills/pick-ui-library/SKILL.md",
      "skills"
    );
    expect(parsed.name).toBe("pick-ui-library");
    expect(parsed.description).toBe("Choose the right component library for the job.");
    expect(parseSkillMarkdown("Root skill.", "SKILL.md", "my-repo").name).toBe("my-repo");
  });

  test("finds every SKILL.md in a mocked recursive tree, scoped and capped", () => {
    const tree = [
      { path: "README.md", type: "blob", size: 10 },
      { path: "skills", type: "tree" },
      { path: "skills/a/SKILL.md", type: "blob", size: 100 },
      { path: "skills/b/SKILL.md", type: "blob", size: 200 },
      { path: "skills/b/notes.md", type: "blob", size: 5 },
      { path: "other/deep/c/SKILL.md", type: "blob", size: 300 },
      { path: "skills/fake-SKILL.md", type: "blob", size: 1 },
      { path: "skills/dir/SKILL.md", type: "tree" },
    ];
    expect(findSkillFiles(tree, "").files.map((f) => f.path)).toEqual([
      "other/deep/c/SKILL.md",
      "skills/a/SKILL.md",
      "skills/b/SKILL.md",
    ]);
    expect(findSkillFiles(tree, "skills/").files.map((f) => f.path)).toEqual(["skills/a/SKILL.md", "skills/b/SKILL.md"]);
    expect(findSkillFiles(tree, "skills/b/SKILL.md").files).toEqual([{ path: "skills/b/SKILL.md", size: 200 }]);
    const many = Array.from({ length: 130 }, (_, i) => ({ path: `s/${String(i).padStart(3, "0")}/SKILL.md`, type: "blob" }));
    const capped = findSkillFiles(many, "");
    expect(capped.files).toHaveLength(100);
    expect(capped.total).toBe(130);
  });

  test("import cap leaves room for the prompt header", () => {
    expect(SKILL_IMPORT_MAX).toBeLessThan(SKILLS_PROMPT_BUDGET);
    expect(SKILL_IMPORT_MAX).toBeGreaterThan(11_900);
  });

  test("trims at heading boundaries, never mid-section, with a note", () => {
    const url = "https://github.com/o/r/blob/abc/skills/x/SKILL.md";
    const intro = "# Title\n\nIntro sentence one. Intro sentence two.";
    const s1 = `## One\n\n${"alpha ".repeat(40).trim()}.`;
    const s2 = `## Two\n\n${"beta ".repeat(40).trim()}.`;
    const s3 = "## Three\n\n```md\n# not a heading inside a fence\n```\n" + "gamma ".repeat(40).trim() + ".";
    const body = [intro, s1, s2, s3].join("\n\n");

    expect(fitSkillBody(body, body.length, url)).toEqual({ text: body, trimmed: false, originalLength: body.length });

    const max = [intro, s1, s2].join("\n\n").length + 120;
    const fitted = fitSkillBody(body, max, url);
    expect(fitted.trimmed).toBe(true);
    expect(fitted.text.length).toBeLessThanOrEqual(max);
    expect(fitted.text).toContain("## Two");
    expect(fitted.text).not.toContain("## Three");
    expect(fitted.text).not.toContain("gamma");
    expect(fitted.text.endsWith(`(trimmed from ${body.length.toLocaleString("en-US")} chars; full: ${url})`)).toBe(true);
    // The kept part ends where a section ended, not mid-sentence.
    expect(fitted.text.split("\n\n(trimmed")[0].endsWith("beta.")).toBe(true);

    // A fenced "# heading" is not a boundary: the fence stays whole or goes whole.
    const fenceCut = fitSkillBody(body, body.length - 50, url);
    expect(fenceCut.text).not.toContain("```md");
  });

  test("falls back to paragraphs when the first section alone is too long", () => {
    const url = "https://x";
    const body = ["# Big", "p1 sentence.", "p2 sentence.", "p3 " + "z".repeat(500) + "."].join("\n\n");
    const fitted = fitSkillBody(body, 120, url);
    expect(fitted.trimmed).toBe(true);
    expect(fitted.text.length).toBeLessThanOrEqual(120);
    expect(fitted.text.startsWith("# Big\n\np1 sentence.\n\np2 sentence.")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Convex actions against a mocked GitHub
// ---------------------------------------------------------------------------

type MockFile = { path: string; content: string };

function skillMd(name: string, description: string, body: string) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
}

function mockGithub(opts: {
  files: MockFile[];
  sha?: string;
  license?: string | null;
  isPrivate?: boolean;
  status?: Record<string, { status: number; headers?: Record<string, string>; body?: string }>;
}) {
  const sha = opts.sha ?? "sha1";
  const calls: Array<{ url: string; auth?: string }> = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, auth: headers.Authorization });
    for (const [needle, res] of Object.entries(opts.status ?? {})) {
      if (url.includes(needle)) return new Response(res.body ?? "{}", { status: res.status, headers: res.headers });
    }
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
    const base = "https://api.github.com/repos/emilkowalski/skills";
    if (url === base) return json({ full_name: "emilkowalski/skills", default_branch: "main", private: !!opts.isPrivate });
    if (url.startsWith(`${base}/commits/`)) return json({ sha });
    if (url === `${base}/license`) {
      return opts.license === null
        ? new Response("{}", { status: 404 })
        : json({ license: { spdx_id: opts.license ?? "MIT" }, html_url: "https://github.com/emilkowalski/skills/blob/main/LICENSE" });
    }
    if (url.startsWith(`${base}/git/trees/`)) {
      const dirs = new Set<string>();
      for (const f of opts.files) {
        const parts = f.path.split("/");
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
      }
      return json({
        truncated: false,
        tree: [
          ...[...dirs].map((path) => ({ path, type: "tree" })),
          ...opts.files.map((f) => ({ path: f.path, type: "blob", size: f.content.length })),
          { path: "README.md", type: "blob", size: 3 },
        ],
      });
    }
    const raw = `https://raw.githubusercontent.com/emilkowalski/skills/${sha}/`;
    if (url.startsWith(raw)) {
      const file = opts.files.find((f) => f.path === decodeURIComponent(url.slice(raw.length)));
      return file ? new Response(file.content, { status: 200 }) : new Response("404", { status: 404 });
    }
    if (url.startsWith(`${base}/contents/`)) {
      const path = decodeURIComponent(url.slice(`${base}/contents/`.length).split("?")[0]);
      const file = opts.files.find((f) => f.path === path);
      return file ? new Response(file.content, { status: 200 }) : new Response("{}", { status: 404 });
    }
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const REPO_URL = "https://github.com/emilkowalski/skills";
const longSection = (title: string, n: number) => `## ${title}\n\n${"Keep animations purposeful. ".repeat(n).trim()}`;

const FILES: MockFile[] = [
  { path: "skills/break-ui/SKILL.md", content: skillMd("break-ui", "Stress-test interfaces.", "# Break UI\n\nTry hostile input.") },
  {
    path: "skills/emil-design-eng/SKILL.md",
    content: skillMd(
      "emil-design-eng",
      "Design engineering philosophy.",
      ["# Design Engineering", longSection("Core", 200), longSection("Springs", 200), longSection("Gestures", 200)].join("\n\n")
    ),
  },
  { path: "skills/pick-ui-library/SKILL.md", content: "# Pick a library\n\nChoose wisely.\n" },
];

describe("previewGithubImport", () => {
  test("lists skills with front matter, sizes, cap flag, license and sha", async () => {
    const t = convexTest(schema, modules);
    const { calls } = mockGithub({ files: FILES, sha: "c0ffee" });
    const preview = await t.action(api.skills.previewGithubImport, { url: `${REPO_URL}/tree/main/skills` });
    expect(preview.repo).toBe("emilkowalski/skills");
    expect(preview.sha).toBe("c0ffee");
    expect(preview.license).toEqual({ spdxId: "MIT", url: "https://github.com/emilkowalski/skills/blob/main/LICENSE" });
    expect(preview.skills.map((s) => [s.path, s.name, s.exceedsCap, s.status])).toEqual([
      ["skills/break-ui/SKILL.md", "break-ui", false, "new"],
      ["skills/emil-design-eng/SKILL.md", "emil-design-eng", true, "new"],
      ["skills/pick-ui-library/SKILL.md", "pick-ui-library", false, "new"],
    ]);
    expect(preview.skills[2].description).toBe("Choose wisely.");
    expect(preview.skills[1].size).toBeGreaterThan(SKILL_IMPORT_MAX);
    // Public repo + no integration: nothing authenticated.
    expect(calls.every((c) => !c.auth)).toBe(true);
  });

  test("uses an existing GitHub integration token for API calls only", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "p", agentIds: [] } as never);
      await ctx.db.insert("integrations", {
        projectId, type: "github", name: "gh", accessToken: "tok", status: "active", createdAt: 0,
      } as never);
    });
    const { calls } = mockGithub({ files: FILES });
    await t.action(api.skills.previewGithubImport, { url: REPO_URL });
    expect(calls.filter((c) => c.url.startsWith("https://api.github.com")).every((c) => c.auth === "Bearer tok")).toBe(true);
    expect(calls.filter((c) => c.url.startsWith("https://raw.")).every((c) => !c.auth)).toBe(true);
  });

  test("reports not found / private, rate limit and no SKILL.md", async () => {
    const t = convexTest(schema, modules);
    mockGithub({ files: FILES, status: { "repos/emilkowalski/skills": { status: 404 } } });
    await expect(t.action(api.skills.previewGithubImport, { url: REPO_URL })).rejects.toThrow(/not found\. It may be private/);

    mockGithub({
      files: FILES,
      status: { "repos/emilkowalski/skills": { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" } } },
    });
    await expect(t.action(api.skills.previewGithubImport, { url: REPO_URL })).rejects.toThrow(/rate limit reached\. Try again after 00:00 UTC/);

    mockGithub({ files: [] });
    await expect(t.action(api.skills.previewGithubImport, { url: REPO_URL })).rejects.toThrow(/No SKILL\.md found/);
  });

  test("a direct SKILL.md blob URL previews just that skill", async () => {
    const t = convexTest(schema, modules);
    mockGithub({ files: FILES });
    const preview = await t.action(api.skills.previewGithubImport, {
      url: `${REPO_URL}/blob/main/skills/break-ui/SKILL.md`,
    });
    expect(preview.skills.map((s) => s.name)).toEqual(["break-ui"]);
  });
});

describe("importFromGithub", () => {
  test("creates skills with source + license, stores long bodies untrimmed (inline fits them at run time), audits", async () => {
    const t = convexTest(schema, modules);
    mockGithub({ files: FILES, sha: "s1" });
    const result = await t.action(api.skills.importFromGithub, {
      url: REPO_URL,
      paths: ["skills/break-ui/SKILL.md", "skills/emil-design-eng/SKILL.md", "skills/nope/SKILL.md", "../x"],
    });
    expect(result.created.map((r) => r.name)).toEqual(["break-ui", "emil-design-eng"]);
    expect(result.skipped.map((s) => s.path)).toEqual(["skills/nope/SKILL.md", "../x"]);

    const rows = await t.query(api.skills.list, {});
    const big = rows.find((r) => r.name === "emil-design-eng")!;
    // Skill v2: stored whole; only inline injection trims (at headings).
    expect(big.trimmed).toBeUndefined();
    expect(big.instructions.length).toBeGreaterThan(SKILL_IMPORT_MAX);
    expect(big.inlineTrimmed).toBe(true);
    expect(big.instructions).not.toContain("---\nname:");
    expect(big.instructions).toContain("## Gestures");
    expect(big.version).toBe(1);
    const agentId = await t.run((ctx) => ctx.db.insert("agents", { name: "designer", role: "designer", status: "idle", isEnabled: true }));
    await t.mutation(api.agents.setSkills, { agentId, skillIds: [big._id] });
    const run = await t.run(async (ctx) => {
      const { loadPromptSkills } = await import("./skills");
      return await loadPromptSkills(ctx, (await ctx.db.get(agentId))!);
    });
    expect(run[0].instructions.length).toBeLessThanOrEqual(SKILL_IMPORT_MAX);
    expect(run[0].instructions).toMatch(/\(trimmed from [\d,]+ chars; full: https:\/\/github\.com\/emilkowalski\/skills\/blob\/s1\/skills\/emil-design-eng\/SKILL\.md\)$/);
    expect(run[0].instructions).toContain("## Core");
    expect(run[0].instructions).not.toContain("## Gestures");
    expect(run[0].fullInstructions).toBe(big.instructions);
    expect(big.description).toBe("Design engineering philosophy.");
    expect(big.source).toEqual({
      kind: "github",
      repo: "emilkowalski/skills",
      path: "skills/emil-design-eng/SKILL.md",
      sha: "s1",
      license: "MIT",
      licenseUrl: "https://github.com/emilkowalski/skills/blob/main/LICENSE",
      url: "https://github.com/emilkowalski/skills/blob/s1/skills/emil-design-eng/SKILL.md",
    });
    const small = rows.find((r) => r.name === "break-ui")!;
    expect(small.trimmed).toBeUndefined();
    expect(small.instructions).toBe("# Break UI\n\nTry hostile input.");

    const audit = await t.run((ctx) => ctx.db.query("audit").collect());
    const row = audit.find((a) => a.action === "skill.import")!;
    expect(row.target).toBe("emilkowalski/skills");
    expect(row.details).toMatchObject({ sha: "s1", license: "MIT", trimmed: [] });
  });

  test("no license → source without license fields", async () => {
    const t = convexTest(schema, modules);
    mockGithub({ files: FILES, license: null });
    await t.action(api.skills.importFromGithub, { url: REPO_URL, paths: ["skills/break-ui/SKILL.md"] });
    const [row] = await t.query(api.skills.list, {});
    expect(row.source?.license).toBeUndefined();
    expect(row.source?.licenseUrl).toBeUndefined();
  });

  test("duplicates: same sha is unchanged, new sha overwrites, name/attachments kept", async () => {
    const t = convexTest(schema, modules);
    mockGithub({ files: FILES, sha: "s1" });
    const first = await t.action(api.skills.importFromGithub, { url: REPO_URL, paths: ["skills/break-ui/SKILL.md"] });
    const skillId = first.created[0].skillId;
    const agentId = await t.run((ctx) => ctx.db.insert("agents", { name: "qa", role: "qa", status: "idle", isEnabled: true }));
    await t.mutation(api.agents.setSkills, { agentId, skillIds: [skillId] });
    await t.mutation(api.skills.update, { skillId, name: "Break UI (renamed)" });

    const again = await t.action(api.skills.importFromGithub, { url: REPO_URL, paths: ["skills/break-ui/SKILL.md"] });
    expect(again.created).toHaveLength(0);
    expect(again.unchanged.map((r) => r.skillId)).toEqual([skillId]);

    // Preview reports it as imported; after an upstream commit, as an update.
    expect((await t.action(api.skills.previewGithubImport, { url: REPO_URL })).skills[0].status).toBe("imported");
    const changed = FILES.map((f) =>
      f.path === "skills/break-ui/SKILL.md" ? { ...f, content: skillMd("break-ui", "Stress-test v2.", "# Break UI\n\nv2") } : f
    );
    mockGithub({ files: changed, sha: "s2" });
    const preview = await t.action(api.skills.previewGithubImport, { url: REPO_URL });
    expect(preview.skills[0]).toMatchObject({ status: "update", skillId });

    const updated = await t.action(api.skills.updateFromSource, { skillId });
    expect(updated).toEqual({ status: "updated", sha: "s2" });
    const row = await t.query(api.skills.get, { skillId });
    expect(row).toMatchObject({ name: "Break UI (renamed)", instructions: "# Break UI\n\nv2", description: "Stress-test v2." });
    expect(row?.source?.sha).toBe("s2");
    expect((await t.run((ctx) => ctx.db.get(agentId)))?.skillIds).toEqual([skillId]);
    expect(await t.query(api.skills.list, {})).toHaveLength(1);

    expect(await t.action(api.skills.updateFromSource, { skillId })).toEqual({ status: "unchanged", sha: "s2" });
  });

  test("name clash with a hand-written skill gets the repo suffix", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.skills.create, { name: "break-ui", instructions: "mine" });
    mockGithub({ files: FILES });
    const result = await t.action(api.skills.importFromGithub, { url: REPO_URL, paths: ["skills/break-ui/SKILL.md"] });
    expect(result.created[0].name).toBe("break-ui (skills)");
  });

  test("updateFromSource refuses skills without a GitHub source", async () => {
    const t = convexTest(schema, modules);
    const skillId = await t.mutation(api.skills.create, { name: "Local", instructions: "x" });
    await expect(t.action(api.skills.updateFromSource, { skillId })).rejects.toThrow(/not imported from GitHub/);
  });
});

describe("Skill v2 import: dependencies, permissions, versions, update all", () => {
  const depFiles = (v: string): MockFile[] => [
    { path: "skills/base/SKILL.md", content: `---\nname: base\ndescription: Base.\n---\n\n# Base\n\n${v}` },
    {
      path: "skills/top/SKILL.md",
      content: `---\nname: top\ndescription: Top.\nrequires: [base, missing-one]\nallowed-tools: Bash(npm test:*) Read\n---\n\n# Top\n\n${v}`,
    },
  ];

  test("front matter requires/allowed-tools resolve; each import is a version; pins survive Update all", async () => {
    const t = convexTest(schema, modules);
    mockGithub({ files: depFiles("one"), sha: "s1" });
    const preview = await t.action(api.skills.previewGithubImport, { url: REPO_URL });
    expect(preview.skills.find((s) => s.name === "top")).toMatchObject({ requires: ["base", "missing-one"], permissions: ["run_command", "read_file"] });
    const first = await t.action(api.skills.importFromGithub, { url: REPO_URL, paths: depFiles("one").map((f) => f.path) });
    expect(first.warnings).toEqual(['"top" requires "missing-one", which is not in the library. Import it too.']);
    const ids = new Map(first.created.map((c) => [c.name, c.skillId]));
    const top = (await t.query(api.skills.get, { skillId: ids.get("top")! }))!;
    expect(top.requires).toEqual([ids.get("base")]);
    expect(top.permissions).toEqual(["run_command", "read_file"]);
    const v1 = await t.query(api.skills.versions, { skillId: ids.get("top")! });
    expect(v1.map((v) => [v.version, v.kind, v.author, v.sourceSha])).toEqual([[1, "import", "github:emilkowalski/skills", "s1"]]);

    // Assigning top pulls base in; the Reviewer is warned about run_command.
    const reviewer = await t.run((ctx) => ctx.db.insert("agents", { name: "reviewer", role: "reviewer", status: "idle", isEnabled: true }));
    const assigned = await t.mutation(api.agents.setSkills, { agentId: reviewer, skillIds: [ids.get("top")!] });
    expect(assigned.skillIds).toEqual([ids.get("top"), ids.get("base")]);
    expect(assigned.warnings).toEqual([
      'Also added "base" to Reviewer: required by "top".',
      'Reviewer lacks run commands, which "top" needs. Skills never grant tools.',
    ]);
    await t.mutation(api.skills.setPin, { agentId: reviewer, skillId: ids.get("top")!, version: 1 });

    mockGithub({ files: depFiles("two"), sha: "s2" });
    const all = await t.action(api.skills.updateAllFromSource, { repo: "emilkowalski/skills" });
    expect(all).toMatchObject({ sha: "s2", updated: ["base", "top"], unchanged: [], missing: [] });
    const v2 = await t.query(api.skills.versions, { skillId: ids.get("top")! });
    expect(v2.map((v) => [v.version, v.kind, v.sourceSha])).toEqual([
      [2, "import", "s2"],
      [1, "import", "s1"],
    ]);
    const diff = await t.query(api.skills.diff, { skillId: ids.get("top")!, from: 1, to: 2 });
    expect(diff.lines.filter((l) => l.op !== "same")).toEqual([
      { op: "del", text: "one" },
      { op: "add", text: "two" },
    ]);
    // The pinned agent still runs v1.
    const skills = await t.run(async (ctx) => {
      const { loadPromptSkills } = await import("./skills");
      return await loadPromptSkills(ctx, (await ctx.db.get(reviewer))!);
    });
    expect(skills[0]).toMatchObject({ name: "top", version: 1 });
    expect(skills[0].fullInstructions).toContain("one");
    expect(skills[1].fullInstructions).toContain("two");

    await expect(t.action(api.skills.updateAllFromSource, { repo: "nobody/none" })).rejects.toThrow(/No skills were imported/);
  });
});

describe("assignRoles + recommended emilkowalski/skills mapping", () => {
  test("seeds the mapping through import + assignRoles (test DB only)", async () => {
    const t = convexTest(schema, modules);
    const roles = ["designer", "frontend", "qa", "reviewer", "backend"];
    const agentIds = new Map<string, string>();
    for (const role of roles) {
      agentIds.set(role, await t.run((ctx) => ctx.db.insert("agents", { name: role, role, status: "idle", isEnabled: true })));
    }
    const disabledQa = await t.run((ctx) =>
      ctx.db.insert("agents", { name: "old qa", role: "qa", status: "idle", isEnabled: false })
    );

    const names = [...new Set(Object.values(EMIL_SKILLS_ROLE_MAPPING).flat())];
    const files = names.map((name) => ({
      path: `skills/${name}/SKILL.md`,
      content: skillMd(name, `${name} skill`, `# ${name}\n\nDo ${name}.`),
    }));
    mockGithub({ files });
    const imported = await t.action(api.skills.importFromGithub, { url: REPO_URL, paths: files.map((f) => f.path) });
    expect(imported.created).toHaveLength(names.length);
    const idByName = new Map(imported.created.map((c) => [c.name, c.skillId]));

    for (const name of names) {
      const forRoles = Object.entries(EMIL_SKILLS_ROLE_MAPPING)
        .filter(([, skills]) => skills.includes(name))
        .map(([role]) => role);
      await t.mutation(api.skills.assignRoles, { skillId: idByName.get(name)! as never, roles: forRoles });
    }

    for (const [role, skills] of Object.entries(EMIL_SKILLS_ROLE_MAPPING)) {
      const row = await t.run((ctx) => ctx.db.get(agentIds.get(role) as never));
      expect((row as { skillIds?: string[] } | null)?.skillIds).toEqual(skills.map((s) => idByName.get(s)));
    }
    expect((await t.run((ctx) => ctx.db.get(agentIds.get("backend") as never)) as { skillIds?: string[] })?.skillIds).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(disabledQa)))?.skillIds).toBeUndefined();

    // Removing a role detaches only from that role's enabled agents.
    const breakUi = idByName.get("break-ui")!;
    expect(await t.mutation(api.skills.assignRoles, { skillId: breakUi, roles: [] })).toEqual({ added: 0, removed: 1, warnings: [] });
    expect((await t.run((ctx) => ctx.db.get(agentIds.get("qa") as never)) as { skillIds?: string[] })?.skillIds).toEqual([
      idByName.get("review-animations"),
    ]);
    const audits = await t.run((ctx) => ctx.db.query("audit").collect());
    expect(audits.filter((a) => a.action === "skill.assignRoles").length).toBe(names.length + 1);
  });
});
