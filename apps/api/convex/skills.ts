import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { assertRegistryWriteAccess } from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";
import { DEFAULT_SKILLS, SKILL_NAME_MAX, validateSkillInput, type PromptSkill } from "./lib/skills";
import {
  fitSkillBody,
  githubFileUrls,
  GITHUB_SKILL_SCAN_MAX,
  isSkillPath,
  parseGithubSkillUrl,
  parseSkillMarkdown,
  SKILL_IMPORT_MAX,
  type GithubSkillUrl,
} from "./lib/githubSkills";
import { GithubClient, mapLimit, resolveGithubRepo, type ResolvedRepo } from "./lib/githubSkillsApi";

/**
 * Library of agent skills: reusable markdown instructions attached to agents
 * through `agents.skillIds`. Same authz model as agents.ts — reads are open
 * (local single-user mode), writes go through assertRegistryWriteAccess.
 */

type Ctx = QueryCtx | MutationCtx;

async function assertUniqueName(ctx: Ctx, name: string, except?: Id<"skills">) {
  const existing = await ctx.db
    .query("skills")
    .withIndex("by_name", (q) => q.eq("name", name))
    .first();
  if (existing && existing._id !== except) {
    throw new Error(`A skill named "${name}" already exists`);
  }
}

/** Attached skills in the agent's own order, missing rows skipped. */
export async function loadPromptSkills(
  ctx: Ctx,
  agent: Pick<Doc<"agents">, "skillIds">
): Promise<PromptSkill[]> {
  if (!agent.skillIds?.length) return [];
  const rows = await Promise.all(agent.skillIds.map((id) => ctx.db.get(id)));
  return rows
    .filter((row): row is Doc<"skills"> => row !== null)
    .map((row) => ({ name: row.name, instructions: row.instructions }));
}

/** All skills by name, each with the agents that use it (id + role + name). */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const skills = await ctx.db.query("skills").withIndex("by_name").collect();
    const agents = await ctx.db.query("agents").collect();
    return skills.map((skill) => ({
      ...skill,
      usedBy: agents
        .filter((agent) => agent.skillIds?.includes(skill._id))
        .map((agent) => ({ _id: agent._id, name: agent.name, role: agent.role })),
    }));
  },
});

export const get = query({
  args: { skillId: v.id("skills") },
  handler: async (ctx, args) => await ctx.db.get(args.skillId),
});

export const create = mutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    instructions: v.string(),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await assertRegistryWriteAccess(ctx);
    const clean = validateSkillInput({ ...args, description: args.description ?? "" });
    await assertUniqueName(ctx, clean.name!);
    const now = Date.now();
    return await ctx.db.insert("skills", {
      name: clean.name!,
      description: clean.description ?? "",
      instructions: clean.instructions!,
      ...(clean.tags?.length ? { tags: clean.tags } : {}),
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  args: {
    skillId: v.id("skills"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    instructions: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await assertRegistryWriteAccess(ctx);
    const skill = await ctx.db.get(args.skillId);
    if (!skill) throw new Error("Skill not found");
    const { skillId, ...input } = args;
    const clean = validateSkillInput(input);
    if (clean.name !== undefined && clean.name !== skill.name) {
      await assertUniqueName(ctx, clean.name, skillId);
    }
    await ctx.db.patch(skillId, {
      ...(clean.name !== undefined ? { name: clean.name } : {}),
      ...(clean.description !== undefined ? { description: clean.description } : {}),
      ...(clean.instructions !== undefined ? { instructions: clean.instructions } : {}),
      ...(clean.tags !== undefined ? { tags: clean.tags.length ? clean.tags : undefined } : {}),
      updatedAt: Date.now(),
    });
  },
});

/** Delete a skill and detach it from every agent that had it. */
export const remove = mutation({
  args: { skillId: v.id("skills") },
  handler: async (ctx, args) => {
    await assertRegistryWriteAccess(ctx);
    const skill = await ctx.db.get(args.skillId);
    if (!skill) throw new Error("Skill not found");
    const agents = await ctx.db.query("agents").collect();
    for (const agent of agents) {
      if (!agent.skillIds?.includes(args.skillId)) continue;
      const next = agent.skillIds.filter((id) => id !== args.skillId);
      await ctx.db.patch(agent._id, { skillIds: next.length ? next : undefined });
    }
    await ctx.db.delete(args.skillId);
  },
});

/**
 * Library "Used by": attach this skill to exactly `agentIds`, detaching it
 * from every other agent. Order on each agent is preserved (new → end).
 */
export const setAgents = mutation({
  args: { skillId: v.id("skills"), agentIds: v.array(v.id("agents")) },
  handler: async (ctx, args) => {
    await assertRegistryWriteAccess(ctx);
    const skill = await ctx.db.get(args.skillId);
    if (!skill) throw new Error("Skill not found");
    const wanted = new Set(args.agentIds.map(String));
    const agents = await ctx.db.query("agents").collect();
    for (const id of args.agentIds) {
      if (!agents.some((a) => a._id === id)) throw new Error("Agent not found");
    }
    for (const agent of agents) {
      const has = agent.skillIds?.includes(args.skillId) ?? false;
      const want = wanted.has(String(agent._id));
      if (has === want) continue;
      const next = want
        ? [...(agent.skillIds ?? []), args.skillId]
        : (agent.skillIds ?? []).filter((id) => id !== args.skillId);
      await ctx.db.patch(agent._id, { skillIds: next.length ? next : undefined });
    }
  },
});

/**
 * Idempotent starter set: inserts the default skills only when the library
 * is empty, so it never resurrects skills the user deleted one by one and
 * never duplicates. `npx convex run skills:seedDefaults`, or the empty-state
 * button on /library.
 */
export const seedDefaults = mutation({
  args: {},
  handler: async (ctx) => {
    await assertRegistryWriteAccess(ctx);
    const any = await ctx.db.query("skills").first();
    if (any) return { inserted: 0 };
    const now = Date.now();
    for (const skill of DEFAULT_SKILLS) {
      await ctx.db.insert("skills", { ...skill, createdAt: now, updatedAt: now });
    }
    return { inserted: DEFAULT_SKILLS.length };
  },
});

/**
 * Role assignment: attach this skill to every ENABLED agent whose role is
 * in `roles` and detach it from enabled agents whose role is not. Disabled
 * agents are left exactly as they are. Order on each agent is preserved
 * (new → end). Returns the agents touched.
 */
export const assignRoles = mutation({
  args: { skillId: v.id("skills"), roles: v.array(v.string()) },
  handler: async (ctx, args): Promise<{ added: number; removed: number }> => {
    await assertRegistryWriteAccess(ctx);
    const skill = await ctx.db.get(args.skillId);
    if (!skill) throw new Error("Skill not found");
    const wanted = new Set(args.roles.map((r) => r.trim()).filter(Boolean));
    const agents = await ctx.db.query("agents").collect();
    let added = 0;
    let removed = 0;
    for (const agent of agents) {
      if (agent.isEnabled === false) continue;
      const has = agent.skillIds?.includes(args.skillId) ?? false;
      const want = wanted.has(agent.role);
      if (has === want) continue;
      const next = want
        ? [...(agent.skillIds ?? []), args.skillId]
        : (agent.skillIds ?? []).filter((id) => id !== args.skillId);
      await ctx.db.patch(agent._id, { skillIds: next.length ? next : undefined });
      if (want) added++;
      else removed++;
    }
    if (added || removed) {
      await recordAudit(ctx, {
        action: "skill.assignRoles",
        target: skill.name,
        details: { roles: [...wanted].sort(), added, removed },
      });
    }
    return { added, removed };
  },
});

// ---------------------------------------------------------------------------
// Import from GitHub
// ---------------------------------------------------------------------------

/** Token of any active GitHub integration, used only for rate limits / private repos. */
export const githubTokenForImport = internalQuery({
  args: {},
  handler: async (ctx): Promise<string | null> => {
    const rows = await ctx.db.query("integrations").collect();
    const row = rows.find((r) => r.type === "github" && r.status === "active" && r.accessToken);
    return row?.accessToken ?? null;
  },
});

/** Skills already imported from `repo`, keyed by path. */
export const githubSourcesForRepo = internalQuery({
  args: { repo: v.string() },
  handler: async (ctx, args): Promise<Array<{ _id: Id<"skills">; name: string; path: string; sha: string }>> => {
    const rows = await ctx.db.query("skills").collect();
    const repo = args.repo.toLowerCase();
    return rows
      .filter((r) => r.source?.kind === "github" && r.source.repo.toLowerCase() === repo)
      .map((r) => ({ _id: r._id, name: r.name, path: r.source!.path, sha: r.source!.sha }));
  },
});

export const getForSourceUpdate = internalQuery({
  args: { skillId: v.id("skills") },
  handler: async (ctx, args) => await ctx.db.get(args.skillId),
});

type ImportItem = {
  path: string;
  name: string;
  description: string;
  instructions: string;
  trimmed: boolean;
  url: string;
};

type ImportResult = {
  repo: string;
  sha: string;
  license: string | null;
  created: Array<{ skillId: Id<"skills">; name: string; path: string }>;
  updated: Array<{ skillId: Id<"skills">; name: string; path: string }>;
  unchanged: Array<{ skillId: Id<"skills">; name: string; path: string }>;
  skipped: Array<{ path: string; reason: string }>;
};

async function uniqueImportName(ctx: MutationCtx, wanted: string, repoName: string): Promise<string | null> {
  const taken = async (name: string) =>
    Boolean(await ctx.db.query("skills").withIndex("by_name", (q) => q.eq("name", name)).first());
  if (!(await taken(wanted))) return wanted;
  const suffix = ` (${repoName})`;
  const base = wanted.slice(0, SKILL_NAME_MAX - suffix.length - 3).trimEnd();
  const withRepo = `${base}${suffix}`;
  if (!(await taken(withRepo))) return withRepo;
  for (let n = 2; n < 50; n++) {
    const candidate = `${base} ${n}${suffix}`;
    if (!(await taken(candidate))) return candidate;
  }
  return null;
}

/**
 * Writes an import: inserts new skills, overwrites ones already imported
 * from the same repo+path when the commit sha (or content) changed, and
 * leaves identical ones alone. A re-import keeps the skill's current name
 * (the user may have renamed it) and its agent attachments.
 */
export const applyGithubImport = internalMutation({
  args: {
    repo: v.string(),
    sha: v.string(),
    license: v.optional(v.string()),
    licenseUrl: v.optional(v.string()),
    items: v.array(
      v.object({
        path: v.string(),
        name: v.string(),
        description: v.string(),
        instructions: v.string(),
        trimmed: v.boolean(),
        url: v.string(),
      })
    ),
  },
  handler: async (ctx, args): Promise<ImportResult> => {
    await assertRegistryWriteAccess(ctx);
    const all = await ctx.db.query("skills").collect();
    const repoKey = args.repo.toLowerCase();
    const repoName = args.repo.split("/")[1] ?? args.repo;
    const result: ImportResult = {
      repo: args.repo,
      sha: args.sha,
      license: args.license ?? null,
      created: [],
      updated: [],
      unchanged: [],
      skipped: [],
    };
    const now = Date.now();
    for (const item of args.items) {
      const source = {
        kind: "github" as const,
        repo: args.repo,
        path: item.path,
        sha: args.sha,
        ...(args.license ? { license: args.license } : {}),
        ...(args.licenseUrl ? { licenseUrl: args.licenseUrl } : {}),
        url: item.url,
      };
      let clean: ReturnType<typeof validateSkillInput>;
      try {
        clean = validateSkillInput({ description: item.description, instructions: item.instructions });
      } catch (err) {
        result.skipped.push({ path: item.path, reason: err instanceof Error ? err.message : "Invalid skill" });
        continue;
      }
      const existing = all.find(
        (row) => row.source?.kind === "github" && row.source.repo.toLowerCase() === repoKey && row.source.path === item.path
      );
      if (existing) {
        const same =
          existing.source!.sha === args.sha &&
          existing.instructions === clean.instructions &&
          existing.description === (clean.description ?? "");
        if (same) {
          result.unchanged.push({ skillId: existing._id, name: existing.name, path: item.path });
          continue;
        }
        await ctx.db.patch(existing._id, {
          description: clean.description ?? "",
          instructions: clean.instructions!,
          source,
          trimmed: item.trimmed ? true : undefined,
          updatedAt: now,
        });
        result.updated.push({ skillId: existing._id, name: existing.name, path: item.path });
        continue;
      }
      let name: string;
      try {
        name = validateSkillInput({ name: item.name }).name!;
      } catch (err) {
        result.skipped.push({ path: item.path, reason: err instanceof Error ? err.message : "Invalid name" });
        continue;
      }
      const unique = await uniqueImportName(ctx, name, repoName);
      if (!unique) {
        result.skipped.push({ path: item.path, reason: `A skill named "${name}" already exists` });
        continue;
      }
      const skillId = await ctx.db.insert("skills", {
        name: unique,
        description: clean.description ?? "",
        instructions: clean.instructions!,
        source,
        ...(item.trimmed ? { trimmed: true } : {}),
        createdAt: now,
        updatedAt: now,
      });
      result.created.push({ skillId, name: unique, path: item.path });
    }
    if (result.created.length || result.updated.length) {
      await recordAudit(ctx, {
        action: "skill.import",
        tool: "github",
        target: args.repo,
        details: {
          sha: args.sha,
          license: args.license ?? null,
          created: result.created.map((r) => r.path),
          updated: result.updated.map((r) => r.path),
          trimmed: args.items.filter((i) => i.trimmed).map((i) => i.path),
        },
      });
    }
    return result;
  },
});

async function githubClient(ctx: ActionCtx): Promise<GithubClient> {
  const token: string | null = await ctx.runQuery(internal.skills.githubTokenForImport, {});
  return new GithubClient(token ?? undefined);
}

function parseUrlOrThrow(url: string): GithubSkillUrl {
  return parseGithubSkillUrl(url);
}

async function readSkillFile(client: GithubClient, repo: ResolvedRepo, path: string) {
  const text = await client.fileText(repo.owner, repo.repo, repo.sha, path, repo.isPrivate);
  const parsed = parseSkillMarkdown(text, path, repo.repo);
  const url = githubFileUrls(repo.owner, repo.repo, repo.sha, path).html;
  return { ...parsed, url, rawLength: text.length };
}

export type GithubImportPreview = {
  repo: string;
  ref: string;
  sha: string;
  license: { spdxId: string; url?: string } | null;
  cap: number;
  total: number;
  capped: boolean;
  treeTruncated: boolean;
  skills: Array<{
    path: string;
    name: string;
    description: string;
    size: number;
    exceedsCap: boolean;
    url: string;
    status: "new" | "imported" | "update";
    skillId?: Id<"skills">;
  }>;
};

/**
 * Preview: every SKILL.md under the URL (repo, /tree/ folder or a /blob/
 * SKILL.md), with name/description from front matter (else folder name +
 * first paragraph), body size in chars and whether it exceeds the import
 * cap, plus license, commit sha and what is already in the library.
 */
export const previewGithubImport = action({
  args: { url: v.string() },
  handler: async (ctx, args): Promise<GithubImportPreview> => {
    const parsed = parseUrlOrThrow(args.url);
    const client = await githubClient(ctx);
    const repo = await resolveGithubRepo(client, parsed);
    const existing: Array<{ _id: Id<"skills">; path: string; sha: string }> = await ctx.runQuery(
      internal.skills.githubSourcesForRepo,
      { repo: repo.fullName }
    );
    const skills = await mapLimit(repo.files, 8, async (file) => {
      const skill = await readSkillFile(client, repo, file.path);
      const prior = existing.find((e) => e.path === file.path);
      return {
        path: file.path,
        name: skill.name,
        description: skill.description,
        size: skill.body.length,
        exceedsCap: skill.body.length > SKILL_IMPORT_MAX,
        url: skill.url,
        status: prior ? (prior.sha === repo.sha ? ("imported" as const) : ("update" as const)) : ("new" as const),
        ...(prior ? { skillId: prior._id } : {}),
      };
    });
    return {
      repo: repo.fullName,
      ref: repo.ref,
      sha: repo.sha,
      license: repo.license ?? null,
      cap: SKILL_IMPORT_MAX,
      total: repo.total,
      capped: repo.total > repo.files.length,
      treeTruncated: repo.treeTruncated,
      skills,
    };
  },
});

async function importPaths(ctx: ActionCtx, parsed: GithubSkillUrl, paths: string[]): Promise<ImportResult> {
  const wanted = Array.from(new Set(paths));
  if (wanted.length === 0) throw new Error("Pick at least one skill to import");
  if (wanted.length > GITHUB_SKILL_SCAN_MAX) throw new Error(`Import at most ${GITHUB_SKILL_SCAN_MAX} skills at a time`);
  const client = await githubClient(ctx);
  // Resolve against the repo root so any SKILL.md path in the repo is accepted.
  const repo = await resolveGithubRepo(client, { ...parsed, path: "", kind: "repo" });
  const skipped: ImportResult["skipped"] = [];
  const valid = wanted.filter((path) => {
    if (!isSkillPath(path) || !repo.allSkillPaths.has(path)) {
      skipped.push({ path, reason: "No SKILL.md at this path" });
      return false;
    }
    return true;
  });
  const items: ImportItem[] = await mapLimit(valid, 8, async (path) => {
    const skill = await readSkillFile(client, repo, path);
    const fitted = fitSkillBody(skill.body, SKILL_IMPORT_MAX, skill.url);
    return {
      path,
      name: skill.name,
      description: skill.description,
      instructions: fitted.text,
      trimmed: fitted.trimmed,
      url: skill.url,
    };
  });
  const result: ImportResult = await ctx.runMutation(internal.skills.applyGithubImport, {
    repo: repo.fullName,
    sha: repo.sha,
    ...(repo.license ? { license: repo.license.spdxId } : {}),
    ...(repo.license?.url ? { licenseUrl: repo.license.url } : {}),
    items,
  });
  return { ...result, skipped: [...skipped, ...result.skipped] };
}

/**
 * Import the chosen SKILL.md paths (from previewGithubImport) as library
 * skills with a `source`. Over-cap bodies are trimmed at heading
 * boundaries with a "(trimmed from N chars; full: <url>)" line. Already
 * imported repo+path pairs are overwritten when the commit moved.
 */
export const importFromGithub = action({
  args: { url: v.string(), paths: v.array(v.string()) },
  handler: async (ctx, args): Promise<ImportResult> => {
    return await importPaths(ctx, parseUrlOrThrow(args.url), args.paths);
  },
});

/** "Update from source": re-read an imported skill at its repo's default branch. */
export const updateFromSource = action({
  args: { skillId: v.id("skills") },
  handler: async (ctx, args): Promise<{ status: "updated" | "unchanged"; sha: string }> => {
    const skill: Doc<"skills"> | null = await ctx.runQuery(internal.skills.getForSourceUpdate, {
      skillId: args.skillId,
    });
    if (!skill) throw new Error("Skill not found");
    if (skill.source?.kind !== "github") throw new Error("This skill was not imported from GitHub");
    const [owner, repo] = skill.source.repo.split("/");
    const result = await importPaths(ctx, { owner, repo, path: "", kind: "repo" }, [skill.source.path]);
    if (result.skipped.length) {
      throw new Error(`${skill.source.path} is no longer in ${skill.source.repo}`);
    }
    return { status: result.updated.length ? "updated" : "unchanged", sha: result.sha };
  },
});
