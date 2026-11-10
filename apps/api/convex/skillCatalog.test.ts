/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { parseGithubSkillUrl } from "./lib/githubSkills";
import {
  catalogCategories,
  catalogInstallUrl,
  catalogKey,
  catalogStatus,
  filterCatalog,
  importedContentMatches,
  installedIndex,
  parseSkillIndex,
  resolveSkillLink,
  type BundledCatalog,
  type CatalogEntry,
} from "./lib/skillCatalog";
import bundledJson from "./lib/skillCatalog.json";

const modules = import.meta.glob("./**/*.ts");

const INDEX = [
  "# Awesome",
  "",
  "| Skill | What |",
  "| --- | --- |",
  "| [outside](skills/outside) | Not in the Skills section |",
  "",
  "## Skills",
  "",
  "### Code review",
  "",
  "| Skill | What it does |",
  "| --- | --- |",
  "| [review](skills/review) | Reviews **diffs** and `PRs` |",
  "| [jury](skills/jury/SKILL.md) | Second opinion \\| judge |",
  "| [dup](./skills/review/) | Same path again |",
  "| plain text | no link |",
  "",
  "### Elsewhere",
  "",
  "- [ext-tree](https://github.com/Other/Repo/tree/dev/skills/ext): External skill on a branch",
  "- [ext-blob](https://github.com/other/repo/blob/main/x/SKILL.md) - Blob link",
  "- [docs](https://example.com/skills/x): not GitHub",
  "- [readme](skills/readme.md): a file that is not SKILL.md",
  "- see [inline](skills/inline) in prose",
  "",
  "```",
  "| [fenced](skills/fenced) | ignored |",
  "```",
  "",
  "## License",
  "",
  "| [after](skills/after) | Other section |",
].join("\n");

describe("catalog parser", () => {
  test("parses tables and bullets in the Skills section with categories, licenses and refs", () => {
    const entries = parseSkillIndex(INDEX, { indexRepo: "khasky/awesome", ref: "main", section: "Skills", license: "MIT" });
    expect(entries.map((e) => [e.name, e.category, e.repo, e.path, e.ref ?? null, e.license, e.author])).toEqual([
      ["review", "Code review", "khasky/awesome", "skills/review/SKILL.md", "main", "MIT", "khasky"],
      ["jury", "Code review", "khasky/awesome", "skills/jury/SKILL.md", "main", "MIT", "khasky"],
      ["ext-tree", "Elsewhere", "Other/Repo", "skills/ext/SKILL.md", "dev", null, "Other"],
      ["ext-blob", "Elsewhere", "other/repo", "x/SKILL.md", "main", null, "other"],
    ]);
    expect(entries[0].description).toBe("Reviews diffs and PRs");
    expect(entries[1].description).toBe("Second opinion | judge");
    expect(entries[2].description).toBe("External skill on a branch");
    expect(entries[3].description).toBe("Blob link");
  });

  test("without a section reads the whole file; a default category applies when there is no ### heading", () => {
    const all = parseSkillIndex(INDEX, { indexRepo: "o/r" });
    expect(all.map((e) => e.name)).toEqual(["outside", "review", "jury", "ext-tree", "ext-blob", "after"]);
    expect(all[0].category).toBe("Other");
    expect(all[0].license).toBeNull();
    const flat = parseSkillIndex("## Skills\n\n| [one](skills/one/SKILL.md) | x |", {
      indexRepo: "o/r",
      section: "Skills",
      category: "Workflow",
    });
    expect(flat.map((e) => e.category)).toEqual(["Workflow"]);
  });

  test("resolveSkillLink rejects traversal, anchors, other hosts and repo roots", () => {
    expect(resolveSkillLink("../x", "o/r")).toBeNull();
    expect(resolveSkillLink("#skills", "o/r")).toBeNull();
    expect(resolveSkillLink("/abs/skill", "o/r")).toBeNull();
    expect(resolveSkillLink("https://github.com/o/r", "o/r")).toBeNull();
    expect(resolveSkillLink("https://gitlab.com/o/r/tree/main/x", "o/r")).toBeNull();
    expect(resolveSkillLink("mailto:a@b.c", "o/r")).toBeNull();
    expect(resolveSkillLink("skills/a%20b?x=1#y", "o/r")).toEqual({ repo: "o/r", path: "skills/a b/SKILL.md" });
  });

  test("the bundled catalog is well formed", () => {
    const catalog = bundledJson as BundledCatalog;
    const entries = catalog.sources.flatMap((s) => s.entries);
    expect(catalog.sources.map((s) => s.repo)).toContain("khasky/awesome-agent-skills");
    expect(entries.length).toBeGreaterThanOrEqual(49);
    const keys = new Set(entries.map((e) => catalogKey(e.repo, e.path)));
    expect(keys.size).toBe(entries.length);
    for (const e of entries) {
      expect(e.path).toMatch(/(^|\/)SKILL\.md$/);
      expect(e.name.length).toBeGreaterThan(0);
      expect(() => parseGithubSkillUrl(catalogInstallUrl(e))).not.toThrow();
    }
    // An index without a license contributes names and paths, not its prose.
    for (const source of catalog.sources.filter((s) => !s.license)) {
      expect(source.entries.every((e) => e.description === "" && e.license === null)).toBe(true);
    }
    expect(catalogCategories(entries).length).toBeGreaterThan(5);
  });
});

const entry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  name: "review",
  description: "Reviews diffs",
  category: "Code review",
  repo: "khasky/awesome",
  path: "skills/review/SKILL.md",
  license: "MIT",
  author: "khasky",
  ...over,
});

describe("installed / update matching", () => {
  const skills = [
    { _id: "s1", source: { kind: "github" as const, repo: "Khasky/Awesome", path: "skills/review/SKILL.md", url: "x" } },
    // Repo renamed after import: matched through the source URL.
    {
      _id: "s2",
      source: {
        kind: "github" as const,
        repo: "old/name",
        path: "skills/jury/SKILL.md",
        url: "https://github.com/khasky/awesome/blob/abc123/skills/jury/SKILL.md",
      },
    },
    { _id: "s3" },
  ];
  const index = installedIndex(skills);

  test("matches repo case-insensitively and path exactly", () => {
    expect(catalogStatus(entry(), index, {})).toEqual({ kind: "installed", skillId: "s1" });
    expect(catalogStatus(entry({ path: "skills/Review/SKILL.md" }), index, {})).toEqual({ kind: "install" });
    expect(catalogStatus(entry({ path: "skills/jury/SKILL.md" }), index, {})).toEqual({ kind: "installed", skillId: "s2" });
    expect(catalogStatus(entry({ repo: "other/repo" }), index, {})).toEqual({ kind: "install" });
  });

  test("update available only when the check says so", () => {
    expect(catalogStatus(entry(), index, { s1: "update" })).toEqual({ kind: "update", skillId: "s1" });
    for (const state of ["current", "missing", "error"] as const) {
      expect(catalogStatus(entry(), index, { s1: state }).kind).toBe("installed");
    }
  });

  test("importedContentMatches mirrors the import's unchanged rule", () => {
    const a = { sha: "1", instructions: "x", description: "d", permissions: ["read_files"] };
    expect(importedContentMatches(a, { ...a })).toBe(true);
    expect(importedContentMatches(a, { ...a, sha: "2" })).toBe(false);
    expect(importedContentMatches(a, { ...a, sha: "2" }, { ignoreSha: true })).toBe(true);
    expect(importedContentMatches(a, { ...a, instructions: "y" }, { ignoreSha: true })).toBe(false);
    expect(importedContentMatches(a, { ...a, permissions: [] }, { ignoreSha: true })).toBe(false);
    expect(importedContentMatches({ ...a, permissions: undefined }, { ...a, permissions: [] })).toBe(true);
  });

  test("filterCatalog searches name, description, repo and category", () => {
    const list = [entry(), entry({ name: "humanize", description: "Removes AI voice", category: "Writing", path: "p/SKILL.md" })];
    expect(filterCatalog(list, "AI voice").map((e) => e.name)).toEqual(["humanize"]);
    expect(filterCatalog(list, "khasky").length).toBe(2);
    expect(filterCatalog(list, "", "Writing").map((e) => e.name)).toEqual(["humanize"]);
    expect(filterCatalog(list, "review", "Writing")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Backend: catalog query, refresh, update check
// ---------------------------------------------------------------------------

type Files = Record<string, string>;

/** GitHub for one repo `o/r` (+ the catalog indexes) at `sha`. */
function mockGithub(opts: { sha: string; files: Files; indexReadme?: string; failIndex?: boolean }) {
  const fn = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
    const m = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url);
    if (m) {
      const full = `${m[1]}/${m[2]}`;
      const rest = m[3] ?? "";
      if (opts.failIndex && full !== "o/r") return new Response("{}", { status: 404 });
      if (!rest) return json({ full_name: full, default_branch: "main", private: false });
      if (rest.startsWith("/commits/")) return json({ sha: full === "o/r" ? opts.sha : "idx" });
      if (rest === "/license") return json({ license: { spdx_id: "MIT" } });
      if (rest.startsWith("/git/trees/")) {
        return json({
          truncated: false,
          tree: Object.keys(opts.files).map((path) => ({ path, type: "blob", size: opts.files[path].length })),
        });
      }
    }
    const raw = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(url);
    if (raw) {
      const path = decodeURIComponent(raw[4]);
      if (`${raw[1]}/${raw[2]}` !== "o/r") {
        return path === "README.md" && opts.indexReadme ? new Response(opts.indexReadme) : new Response("404", { status: 404 });
      }
      const body = opts.files[path];
      return body === undefined ? new Response("404", { status: 404 }) : new Response(body);
    }
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const md = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}`;

describe("skillCatalog backend", () => {
  test("get falls back to the bundled catalog, then uses a refreshed copy", async () => {
    const t = convexTest(schema, modules);
    const before = await t.query(api.skillCatalog.get, {});
    const bundled = bundledJson as BundledCatalog;
    expect(before.entries.length).toBe(bundled.sources.reduce((n, s) => n + s.entries.length, 0));
    expect(before.sources.every((s) => s.origin === "bundled")).toBe(true);

    mockGithub({
      sha: "x",
      files: {},
      indexReadme: "## Skills\n\n### Fresh\n\n| [awesome-code-review](skills/awesome-code-review) | New text |\n| [brand-new](skills/brand-new) | Added |",
    });
    const res = await t.action(api.skillCatalog.refresh, {});
    expect(res.failed).toEqual([]);
    expect(res.refreshed.map((r) => r.entries)).toEqual(bundled.sources.map(() => 2));
    const after = await t.query(api.skillCatalog.get, {});
    expect(after.sources.every((s) => s.origin === "refreshed" && s.sha === "idx")).toBe(true);
    const review = after.entries.find((e) => e.repo === "khasky/awesome-agent-skills" && e.name === "awesome-code-review");
    expect(review).toMatchObject({ category: "Fresh", description: "New text", license: "MIT", author: "Khasky" });
    expect(after.entries.some((e) => e.name === "brand-new")).toBe(true);
  });

  test("a failed refresh keeps the bundled list", async () => {
    const t = convexTest(schema, modules);
    mockGithub({ sha: "x", files: {}, failIndex: true });
    const res = await t.action(api.skillCatalog.refresh, {});
    expect(res.refreshed).toEqual([]);
    expect(res.failed.length).toBe((bundledJson as BundledCatalog).sources.length);
    const view = await t.query(api.skillCatalog.get, {});
    expect(view.sources.every((s) => s.origin === "bundled")).toBe(true);
  });

  test("checkUpdates: same commit current, new commit with same content current, changed content update, gone missing", async () => {
    const t = convexTest(schema, modules);
    const files = {
      "skills/a/SKILL.md": md("a", "Alpha body."),
      "skills/b/SKILL.md": md("b", "Beta body."),
      "skills/c/SKILL.md": md("c", "Gamma body."),
    };
    mockGithub({ sha: "s1", files });
    const imported = await t.action(api.skills.importFromGithub, {
      url: catalogInstallUrl({ repo: "o/r", path: "skills/a/SKILL.md" }).replace(/\/blob\/.*/, ""),
      paths: Object.keys(files),
    });
    const id = (name: string) => imported.created.find((c) => c.name === name)!.skillId;
    const ids = ["a", "b", "c"].map(id);

    expect(await t.action(api.skillCatalog.checkUpdates, { skillIds: ids })).toEqual({
      [ids[0]]: "current",
      [ids[1]]: "current",
      [ids[2]]: "current",
    });

    // New commit: a unchanged, b edited, c deleted.
    mockGithub({ sha: "s2", files: { "skills/a/SKILL.md": files["skills/a/SKILL.md"], "skills/b/SKILL.md": md("b", "Beta v2.") } });
    const checked = await t.action(api.skillCatalog.checkUpdates, { skillIds: ids });
    expect(checked).toEqual({ [ids[0]]: "current", [ids[1]]: "update", [ids[2]]: "missing" });

    // updateFromSource (the Browse "Update" action) clears it.
    const upd = await t.action(api.skills.updateFromSource, { skillId: ids[1] });
    expect(upd.status).toBe("updated");
    expect((await t.action(api.skillCatalog.checkUpdates, { skillIds: [ids[1]] }))[ids[1]]).toBe("current");

    // Installed matching against the library list.
    const library = await t.query(api.skills.list, {});
    const index = installedIndex(library as never);
    expect(catalogStatus({ repo: "O/R", path: "skills/b/SKILL.md" }, index, {}).kind).toBe("installed");
  });

  test("readSkillFile validates repo and path", async () => {
    const t = convexTest(schema, modules);
    mockGithub({ sha: "s1", files: { "skills/a/SKILL.md": md("a", "Alpha.") } });
    const file = await t.action(api.skillCatalog.readSkillFile, { repo: "o/r", path: "skills/a/SKILL.md", ref: "s1" });
    expect(file.text).toContain("Alpha.");
    expect(file.url).toBe("https://github.com/o/r/blob/s1/skills/a/SKILL.md");
    await expect(t.action(api.skillCatalog.readSkillFile, { repo: "o/r/x", path: "skills/a/SKILL.md" })).rejects.toThrow(/owner\/repo/);
    await expect(t.action(api.skillCatalog.readSkillFile, { repo: "o/r", path: "../README.md" })).rejects.toThrow(/SKILL\.md/);
  });
});
