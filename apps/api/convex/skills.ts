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
import { assertAgentAccess, assertRegistryWriteAccess, getViewerId } from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";
import {
  DEFAULT_SKILLS,
  SKILL_INSTRUCTIONS_MAX,
  SKILL_NAME_MAX,
  SKILL_STORED_MAX,
  validateSkillInput,
  type PromptSkill,
} from "./lib/skills";
import {
  brokenDependencies,
  createsDependencyCycle,
  diffLines,
  diffStats,
  expandWithDependencies,
  missingPermissions,
  normalizeSkillPermissions,
  SKILL_PERMISSION_LABELS,
  SKILL_REQUIRES_MAX,
} from "./lib/skillGraph";
import { roleLabel } from "./lib/roles";
import {
  fitSkillBody,
  githubFileUrls,
  inlineSkillBody,
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

// ---------------------------------------------------------------------------
// Versions (Skill v2)
// ---------------------------------------------------------------------------

type VersionKind = Doc<"skillVersions">["kind"];

async function authorFor(ctx: MutationCtx): Promise<string> {
  return (await getViewerId(ctx)) ?? "user";
}

async function versionRowsOf(ctx: Ctx, skillId: Id<"skills">): Promise<Doc<"skillVersions">[]> {
  return await ctx.db
    .query("skillVersions")
    .withIndex("by_skill", (q) => q.eq("skillId", skillId))
    .collect();
}

async function versionRow(ctx: Ctx, skillId: Id<"skills">, version: number): Promise<Doc<"skillVersions"> | null> {
  return await ctx.db
    .query("skillVersions")
    .withIndex("by_skill", (q) => q.eq("skillId", skillId).eq("version", version))
    .first();
}

async function latestVersionNumber(ctx: Ctx, skillId: Id<"skills">): Promise<number> {
  const last = await ctx.db
    .query("skillVersions")
    .withIndex("by_skill", (q) => q.eq("skillId", skillId))
    .order("desc")
    .first();
  return last?.version ?? 0;
}

function contentOf(skill: Doc<"skills">) {
  return {
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    ...(skill.tags?.length ? { tags: skill.tags } : {}),
    ...(skill.requires?.length ? { requires: skill.requires } : {}),
    ...(skill.permissions?.length ? { permissions: skill.permissions } : {}),
    ...(skill.source?.sha ? { sourceSha: skill.source.sha } : {}),
  };
}

/**
 * A skill written before Skill v2 has no version rows: snapshot its current
 * content as version 1 ("baseline") before the first change, so history
 * and rollback always include what agents were running before.
 */
async function ensureBaseline(ctx: MutationCtx, skill: Doc<"skills">): Promise<void> {
  if ((await latestVersionNumber(ctx, skill._id)) > 0) return;
  await ctx.db.insert("skillVersions", {
    skillId: skill._id,
    version: 1,
    ...contentOf(skill),
    author: "system",
    kind: "baseline",
    note: "Content before version history",
    createdAt: skill.updatedAt,
  });
  await ctx.db.patch(skill._id, { version: 1 });
}

/** Snapshot the skill's CURRENT content as the next version. */
async function recordVersion(
  ctx: MutationCtx,
  skillId: Id<"skills">,
  kind: VersionKind,
  opts: { author?: string; note?: string } = {}
): Promise<number> {
  const skill = await ctx.db.get(skillId);
  if (!skill) throw new Error("Skill not found");
  const version = (await latestVersionNumber(ctx, skillId)) + 1;
  await ctx.db.insert("skillVersions", {
    skillId,
    version,
    ...contentOf(skill),
    author: opts.author ?? (await authorFor(ctx)),
    kind,
    ...(opts.note ? { note: opts.note } : {}),
    createdAt: Date.now(),
  });
  await ctx.db.patch(skillId, { version });
  return version;
}

function sameList(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((item, i) => item === y[i]);
}

/** Did a patch change anything a version captures? */
function contentChanged(before: Doc<"skills">, after: Doc<"skills">): boolean {
  return (
    before.name !== after.name ||
    before.description !== after.description ||
    before.instructions !== after.instructions ||
    !sameList(before.tags, after.tags) ||
    !sameList(before.requires, after.requires) ||
    !sameList(before.permissions, after.permissions)
  );
}

// ---------------------------------------------------------------------------
// Prompt loading
// ---------------------------------------------------------------------------

/**
 * Attached skills in the agent's own order, missing rows skipped. A pinned
 * skill reads its pinned version; others the latest. `instructions` is the
 * inline text (a long imported body fitted under the inline cap at heading
 * boundaries); `fullInstructions` is the untrimmed body load_skill returns.
 */
export async function loadPromptSkills(
  ctx: Ctx,
  agent: Pick<Doc<"agents">, "skillIds" | "skillPins">
): Promise<PromptSkill[]> {
  if (!agent.skillIds?.length) return [];
  const rows = await Promise.all(agent.skillIds.map((id) => ctx.db.get(id)));
  const out: PromptSkill[] = [];
  for (const row of rows) {
    if (!row) continue;
    const pin = agent.skillPins?.find((p) => p.skillId === row._id);
    const pinned = pin ? await versionRow(ctx, row._id, pin.version) : null;
    const name = pinned?.name ?? row.name;
    const description = pinned?.description ?? row.description;
    const body = pinned?.instructions ?? row.instructions;
    out.push({
      name,
      description,
      instructions: inlineSkillBody(body, row.source?.url),
      fullInstructions: body,
      ...(pinned ? { version: pinned.version } : row.version ? { version: row.version } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dependencies + permission warnings
// ---------------------------------------------------------------------------

type SkillIndex = Map<string, Doc<"skills">>;

async function skillIndex(ctx: Ctx): Promise<SkillIndex> {
  const rows = await ctx.db.query("skills").collect();
  return new Map(rows.map((row) => [String(row._id), row]));
}

function requiresMapOf(index: SkillIndex): Map<string, string[]> {
  return new Map([...index.values()].map((row) => [String(row._id), (row.requires ?? []).map(String)]));
}

function nameOf(index: SkillIndex, id: string): string {
  return index.get(id)?.name ?? "a deleted skill";
}

function agentLabel(agent: Pick<Doc<"agents">, "role" | "name">): string {
  return roleLabel(agent.role) || agent.name;
}

/**
 * The skill list an agent ends up with when it is given `wanted`: required
 * skills pulled in (appended), plus warnings for what was pulled in, for
 * required skills that were removed, and for permissions the agent lacks.
 */
export function planAgentSkills(
  agent: Pick<Doc<"agents">, "role" | "name" | "supportedTools" | "capabilities" | "skillIds">,
  wanted: readonly string[],
  index: SkillIndex
): { skillIds: string[]; warnings: string[] } {
  const requires = requiresMapOf(index);
  const expanded = expandWithDependencies(wanted, requires, (id) => index.has(id));
  const who = agentLabel(agent);
  const warnings: string[] = [];
  for (const dep of expanded.added) {
    const by = expanded.ids.filter((id) => (requires.get(id) ?? []).includes(dep)).map((id) => `"${nameOf(index, id)}"`);
    warnings.push(`Also added "${nameOf(index, dep)}" to ${who}: required by ${by.join(", ")}.`);
  }
  for (const missing of expanded.missing) {
    const by = expanded.ids.filter((id) => (requires.get(id) ?? []).includes(missing)).map((id) => `"${nameOf(index, id)}"`);
    warnings.push(`${by.join(", ")} requires a skill that no longer exists.`);
  }
  // Permission gaps are reported when a skill is newly given to the agent.
  const before = (agent.skillIds ?? []).map(String);
  for (const id of expanded.ids) {
    if (before.includes(id)) continue;
    const skill = index.get(id);
    const missing = missingPermissions(skill?.permissions, agent);
    if (skill && missing.length) {
      warnings.push(
        `${who} lacks ${missing.map((p) => SKILL_PERMISSION_LABELS[p]).join(" and ")}, which "${skill.name}" needs. Skills never grant tools.`
      );
    }
  }
  return { skillIds: expanded.ids, warnings };
}

/**
 * Warnings for taking `removedIds` off an agent while skills that require
 * them stay. Removal is allowed (the dependent is pulled back in only when
 * it is assigned again); this is the "removing a dependency warns" rule.
 */
function removalWarnings(
  agent: Pick<Doc<"agents">, "role" | "name">,
  removedIds: readonly string[],
  remainingIds: readonly string[],
  index: SkillIndex
): string[] {
  return brokenDependencies(removedIds, remainingIds, requiresMapOf(index)).map(
    ({ removed, requiredBy }) =>
      `${agentLabel(agent)} still has ${requiredBy.map((id) => `"${nameOf(index, id)}"`).join(", ")}, which requires "${nameOf(index, removed)}".`
  );
}

/** Pins for skills no longer attached are dropped. */
function prunePins(
  pins: Doc<"agents">["skillPins"],
  skillIds: readonly string[]
): Doc<"agents">["skillPins"] | undefined {
  const next = (pins ?? []).filter((p) => skillIds.includes(String(p.skillId)));
  return next.length ? next : undefined;
}

/**
 * Write an agent's skill list (agents.setSkills, skills.setAgents,
 * skills.assignRoles). Additions pull in their dependencies; removals of a
 * still-required skill go through with a warning. Returns the warnings.
 */
export async function applyAgentSkills(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  wanted: readonly string[],
  index?: SkillIndex
): Promise<{ skillIds: Id<"skills">[]; warnings: string[] }> {
  const idx = index ?? (await skillIndex(ctx));
  const before = (agent.skillIds ?? []).map(String);
  const deduped = Array.from(new Set(wanted.map(String)));
  const removedByUser = before.filter((id) => !deduped.includes(id));
  // Removed skills must not be pulled straight back in by a dependent that
  // is also being removed; only dependents that stay can require them.
  const planned = planAgentSkills(agent, deduped, idx);
  let ids = planned.skillIds;
  const warnings = [...planned.warnings];
  // A skill the user removed that a remaining skill requires: keep it out
  // (their choice) but warn, instead of silently re-adding it.
  const pulledBack = removedByUser.filter((id) => ids.includes(id));
  if (pulledBack.length) {
    ids = ids.filter((id) => !pulledBack.includes(id));
    const filteredWarnings = warnings.filter(
      (w) => !pulledBack.some((id) => w.startsWith(`Also added "${nameOf(idx, id)}"`))
    );
    warnings.length = 0;
    warnings.push(...filteredWarnings);
  }
  warnings.push(...removalWarnings(agent, removedByUser, ids, idx));
  const skillIds = ids as Id<"skills">[];
  await ctx.db.patch(agent._id, {
    skillIds: skillIds.length ? skillIds : undefined,
    skillPins: prunePins(agent.skillPins, ids),
  });
  return { skillIds, warnings };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * All skills by name, each with the agents that use it (id + role + name +
 * pinned version), its size, version count, dependencies (names) and the
 * skills that require it.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const skills = await ctx.db.query("skills").withIndex("by_name").collect();
    const agents = await ctx.db.query("agents").collect();
    const byId = new Map(skills.map((s) => [String(s._id), s]));
    return await Promise.all(
      skills.map(async (skill) => ({
        ...skill,
        size: skill.instructions.length,
        inlineTrimmed: skill.instructions.length > SKILL_IMPORT_MAX,
        versionCount: (await versionRowsOf(ctx, skill._id)).length,
        requiresNames: (skill.requires ?? []).map((id) => byId.get(String(id))?.name ?? "deleted skill"),
        requiredBy: skills
          .filter((other) => (other.requires ?? []).includes(skill._id))
          .map((other) => ({ _id: other._id, name: other.name })),
        usedBy: agents
          .filter((agent) => agent.skillIds?.includes(skill._id))
          .map((agent) => ({
            _id: agent._id,
            name: agent.name,
            role: agent.role,
            isEnabled: agent.isEnabled,
            skillLoading: agent.skillLoading ?? "inline",
            pinnedVersion: agent.skillPins?.find((p) => p.skillId === skill._id)?.version,
            missingPermissions: missingPermissions(skill.permissions, agent),
          })),
      }))
    );
  },
});

export const get = query({
  args: { skillId: v.id("skills") },
  handler: async (ctx, args) => await ctx.db.get(args.skillId),
});

/** Version history, newest first (bodies omitted; `size` is their length). */
export const versions = query({
  args: { skillId: v.id("skills") },
  handler: async (ctx, args) => {
    const rows = await versionRowsOf(ctx, args.skillId);
    const agents = await ctx.db.query("agents").collect();
    return rows
      .sort((a, b) => b.version - a.version)
      .map(({ instructions, ...row }) => ({
        ...row,
        size: instructions.length,
        pinnedBy: agents
          .filter((agent) => agent.skillPins?.some((p) => p.skillId === args.skillId && p.version === row.version))
          .map((agent) => ({ _id: agent._id, name: agent.name, role: agent.role })),
      }));
  },
});

export const getVersion = query({
  args: { skillId: v.id("skills"), version: v.number() },
  handler: async (ctx, args) => await versionRow(ctx, args.skillId, args.version),
});

/**
 * Line diff of the instructions between two versions (`to` omitted = the
 * current content), plus which header fields changed.
 */
export const diff = query({
  args: { skillId: v.id("skills"), from: v.number(), to: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const skill = await ctx.db.get(args.skillId);
    if (!skill) throw new Error("Skill not found");
    const from = await versionRow(ctx, args.skillId, args.from);
    if (!from) throw new Error(`Version ${args.from} not found`);
    const to = args.to !== undefined ? await versionRow(ctx, args.skillId, args.to) : null;
    if (args.to !== undefined && !to) throw new Error(`Version ${args.to} not found`);
    const after = to ?? { ...contentOf(skill), version: skill.version ?? 0 };
    const lines = diffLines(from.instructions, after.instructions);
    const fields: string[] = [];
    if (from.name !== after.name) fields.push("name");
    if (from.description !== after.description) fields.push("description");
    if (!sameList(from.tags, after.tags)) fields.push("tags");
    if (!sameList(from.requires, after.requires)) fields.push("requires");
    if (!sameList(from.permissions, after.permissions)) fields.push("permissions");
    return {
      from: args.from,
      to: to ? to.version : null,
      fields,
      stats: diffStats(lines),
      lines,
    };
  },
});

/** Skills that require this one, and the agents that use those (pre-delete warning). */
export const dependents = query({
  args: { skillId: v.id("skills") },
  handler: async (ctx, args) => {
    const skills = await ctx.db.query("skills").collect();
    return skills
      .filter((row) => (row.requires ?? []).includes(args.skillId))
      .map((row) => ({ _id: row._id, name: row.name }));
  },
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

async function cleanRequires(
  ctx: MutationCtx,
  skillId: Id<"skills"> | null,
  requires: readonly Id<"skills">[]
): Promise<Id<"skills">[]> {
  const ids = Array.from(new Set(requires));
  if (ids.length > SKILL_REQUIRES_MAX) throw new Error(`A skill can require at most ${SKILL_REQUIRES_MAX} skills`);
  for (const id of ids) {
    if (skillId && id === skillId) throw new Error("A skill cannot require itself");
    if (!(await ctx.db.get(id))) throw new Error("Required skill not found");
  }
  if (skillId) {
    const index = await skillIndex(ctx);
    if (createsDependencyCycle(String(skillId), ids.map(String), requiresMapOf(index))) {
      throw new Error("That would make the skills require each other");
    }
  }
  return ids;
}

/**
 * Agents that use `skillId` get its (new) dependencies too. Returns the
 * warnings (what was added where, plus permission gaps).
 */
async function propagateDependencies(ctx: MutationCtx, skillId: Id<"skills">): Promise<string[]> {
  const index = await skillIndex(ctx);
  const agents = await ctx.db.query("agents").collect();
  const warnings: string[] = [];
  for (const agent of agents) {
    if (!agent.skillIds?.includes(skillId)) continue;
    const planned = planAgentSkills(agent, agent.skillIds.map(String), index);
    if (planned.skillIds.length === agent.skillIds.length) continue;
    await ctx.db.patch(agent._id, { skillIds: planned.skillIds as Id<"skills">[] });
    warnings.push(...planned.warnings);
  }
  return warnings;
}

/** Permission gaps on agents already using the skill (after a permissions edit). */
async function permissionWarningsFor(ctx: MutationCtx, skill: Doc<"skills">): Promise<string[]> {
  if (!skill.permissions?.length) return [];
  const agents = await ctx.db.query("agents").collect();
  const warnings: string[] = [];
  for (const agent of agents) {
    if (!agent.skillIds?.includes(skill._id) || agent.isEnabled === false) continue;
    const missing = missingPermissions(skill.permissions, agent);
    if (missing.length) {
      warnings.push(
        `${agentLabel(agent)} lacks ${missing.map((p) => SKILL_PERMISSION_LABELS[p]).join(" and ")}, which "${skill.name}" needs. Skills never grant tools.`
      );
    }
  }
  return warnings;
}

export const create = mutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    instructions: v.string(),
    tags: v.optional(v.array(v.string())),
    requires: v.optional(v.array(v.id("skills"))),
    permissions: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await assertRegistryWriteAccess(ctx);
    const clean = validateSkillInput({ ...args, description: args.description ?? "" });
    await assertUniqueName(ctx, clean.name!);
    const requires = await cleanRequires(ctx, null, args.requires ?? []);
    const permissions = normalizeSkillPermissions(args.permissions);
    const now = Date.now();
    const skillId = await ctx.db.insert("skills", {
      name: clean.name!,
      description: clean.description ?? "",
      instructions: clean.instructions!,
      ...(clean.tags?.length ? { tags: clean.tags } : {}),
      ...(requires.length ? { requires } : {}),
      ...(permissions.length ? { permissions } : {}),
      createdAt: now,
      updatedAt: now,
    });
    await recordVersion(ctx, skillId, "create");
    return skillId;
  },
});

/**
 * Edit a skill. Any content change saves a new version. Returns warnings
 * (dependencies pulled into agents that use it, permission gaps).
 */
export const update = mutation({
  args: {
    skillId: v.id("skills"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    instructions: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    requires: v.optional(v.array(v.id("skills"))),
    permissions: v.optional(v.array(v.string())),
    /** Optional change note stored on the version. */
    note: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ version: number | null; warnings: string[] }> => {
    await assertRegistryWriteAccess(ctx);
    const skill = await ctx.db.get(args.skillId);
    if (!skill) throw new Error("Skill not found");
    const { skillId, requires: rawRequires, permissions: rawPermissions, note, ...input } = args;
    // Imported skills keep their whole upstream body, so an edit may be as
    // long as what the import stored.
    const clean = validateSkillInput(input, {
      instructionsMax: skill.source ? SKILL_STORED_MAX : SKILL_INSTRUCTIONS_MAX,
    });
    if (clean.name !== undefined && clean.name !== skill.name) {
      await assertUniqueName(ctx, clean.name, skillId);
    }
    const requires = rawRequires !== undefined ? await cleanRequires(ctx, skillId, rawRequires) : undefined;
    const permissions = rawPermissions !== undefined ? normalizeSkillPermissions(rawPermissions) : undefined;
    await ensureBaseline(ctx, skill);
    await ctx.db.patch(skillId, {
      ...(clean.name !== undefined ? { name: clean.name } : {}),
      ...(clean.description !== undefined ? { description: clean.description } : {}),
      ...(clean.instructions !== undefined ? { instructions: clean.instructions } : {}),
      ...(clean.tags !== undefined ? { tags: clean.tags.length ? clean.tags : undefined } : {}),
      ...(requires !== undefined ? { requires: requires.length ? requires : undefined } : {}),
      ...(permissions !== undefined ? { permissions: permissions.length ? permissions : undefined } : {}),
      updatedAt: Date.now(),
    });
    const after = (await ctx.db.get(skillId))!;
    if (!contentChanged(skill, after)) return { version: null, warnings: [] };
    const version = await recordVersion(ctx, skillId, "edit", note?.trim() ? { note: note.trim().slice(0, 200) } : {});
    const warnings: string[] = [];
    if (!sameList(skill.requires, after.requires)) {
      warnings.push(...(await propagateDependencies(ctx, skillId)));
      const dropped = (skill.requires ?? []).filter((id) => !(after.requires ?? []).includes(id));
      if (dropped.length) {
        const index = await skillIndex(ctx);
        warnings.push(
          `"${after.name}" no longer requires ${dropped.map((id) => `"${nameOf(index, String(id))}"`).join(", ")}; agents keep it until you remove it.`
        );
      }
    }
    if (!sameList(skill.permissions, after.permissions)) {
      warnings.push(...(await permissionWarningsFor(ctx, after)));
    }
    return { version, warnings };
  },
});

/**
 * Roll a skill back to an earlier version: its content becomes a NEW
 * latest version (kind "rollback"), so history is never rewritten. Audited.
 */
export const rollback = mutation({
  args: { skillId: v.id("skills"), version: v.number() },
  handler: async (ctx, args): Promise<{ version: number }> => {
    await assertRegistryWriteAccess(ctx);
    const skill = await ctx.db.get(args.skillId);
    if (!skill) throw new Error("Skill not found");
    const target = await versionRow(ctx, args.skillId, args.version);
    if (!target) throw new Error(`Version ${args.version} not found`);
    if (target.name !== skill.name) await assertUniqueName(ctx, target.name, args.skillId);
    // Dependencies that were deleted since are dropped, not resurrected.
    const requires: Id<"skills">[] = [];
    for (const id of target.requires ?? []) if (await ctx.db.get(id)) requires.push(id);
    await ensureBaseline(ctx, skill);
    const from = (await ctx.db.get(args.skillId))!.version ?? 1;
    await ctx.db.patch(args.skillId, {
      name: target.name,
      description: target.description,
      instructions: target.instructions,
      tags: target.tags?.length ? target.tags : undefined,
      requires: requires.length ? requires : undefined,
      permissions: target.permissions?.length ? target.permissions : undefined,
      updatedAt: Date.now(),
    });
    const version = await recordVersion(ctx, args.skillId, "rollback", { note: `Rolled back to v${args.version}` });
    await recordAudit(ctx, {
      action: "skill.rollback",
      target: target.name,
      details: { from, to: args.version, newVersion: version },
    });
    return { version };
  },
});

/**
 * Snapshot every skill that has no history yet as version 1. Idempotent;
 * the first edit/import does the same lazily. `npx convex run skills:backfillVersions`.
 */
export const backfillVersions = mutation({
  args: {},
  handler: async (ctx): Promise<{ backfilled: number }> => {
    await assertRegistryWriteAccess(ctx);
    let backfilled = 0;
    for (const skill of await ctx.db.query("skills").collect()) {
      if ((await latestVersionNumber(ctx, skill._id)) > 0) continue;
      await ensureBaseline(ctx, skill);
      backfilled++;
    }
    return { backfilled };
  },
});

/** Delete a skill: detach it from every agent, drop pins, history and requires on it. */
export const remove = mutation({
  args: { skillId: v.id("skills") },
  handler: async (ctx, args): Promise<{ warnings: string[] }> => {
    await assertRegistryWriteAccess(ctx);
    const skill = await ctx.db.get(args.skillId);
    if (!skill) throw new Error("Skill not found");
    const warnings: string[] = [];
    const agents = await ctx.db.query("agents").collect();
    for (const agent of agents) {
      if (!agent.skillIds?.includes(args.skillId) && !agent.skillPins?.some((p) => p.skillId === args.skillId)) continue;
      const next = (agent.skillIds ?? []).filter((id) => id !== args.skillId);
      await ctx.db.patch(agent._id, {
        skillIds: next.length ? next : undefined,
        skillPins: prunePins(agent.skillPins, next.map(String)),
      });
    }
    for (const other of await ctx.db.query("skills").collect()) {
      if (!(other.requires ?? []).includes(args.skillId)) continue;
      const next = other.requires!.filter((id) => id !== args.skillId);
      await ctx.db.patch(other._id, { requires: next.length ? next : undefined });
      warnings.push(`"${other.name}" required "${skill.name}"; that requirement was removed.`);
    }
    for (const row of await versionRowsOf(ctx, args.skillId)) await ctx.db.delete(row._id);
    await ctx.db.delete(args.skillId);
    return { warnings };
  },
});

/**
 * Library "Used by": attach this skill to exactly `agentIds`, detaching it
 * from every other agent. Order on each agent is preserved (new → end);
 * dependencies come along. Returns warnings.
 */
export const setAgents = mutation({
  args: { skillId: v.id("skills"), agentIds: v.array(v.id("agents")) },
  handler: async (ctx, args): Promise<{ warnings: string[] }> => {
    await assertRegistryWriteAccess(ctx);
    const skill = await ctx.db.get(args.skillId);
    if (!skill) throw new Error("Skill not found");
    const wanted = new Set(args.agentIds.map(String));
    const agents = await ctx.db.query("agents").collect();
    for (const id of args.agentIds) {
      if (!agents.some((a) => a._id === id)) throw new Error("Agent not found");
    }
    const index = await skillIndex(ctx);
    const warnings: string[] = [];
    for (const agent of agents) {
      const has = agent.skillIds?.includes(args.skillId) ?? false;
      const want = wanted.has(String(agent._id));
      if (has === want) continue;
      const next = want
        ? [...(agent.skillIds ?? []).map(String), String(args.skillId)]
        : (agent.skillIds ?? []).map(String).filter((id) => id !== String(args.skillId));
      warnings.push(...(await applyAgentSkills(ctx, agent, next, index)).warnings);
    }
    return { warnings };
  },
});

/**
 * Pin an attached skill to a version (`version: null` = follow latest).
 * Audited.
 */
export const setPin = mutation({
  args: { agentId: v.id("agents"), skillId: v.id("skills"), version: v.union(v.number(), v.null()) },
  handler: async (ctx, args) => {
    const agent = await assertAgentAccess(ctx, args.agentId);
    const skill = await ctx.db.get(args.skillId);
    if (!skill) throw new Error("Skill not found");
    if (!agent.skillIds?.includes(args.skillId)) throw new Error(`${agent.name} does not use "${skill.name}"`);
    const others = (agent.skillPins ?? []).filter((p) => p.skillId !== args.skillId);
    if (args.version !== null) {
      if (!(await versionRow(ctx, args.skillId, args.version))) throw new Error(`Version ${args.version} not found`);
    }
    const next = args.version === null ? others : [...others, { skillId: args.skillId, version: args.version }];
    await ctx.db.patch(args.agentId, { skillPins: next.length ? next : undefined });
    await recordAudit(ctx, {
      action: args.version === null ? "skill.unpin" : "skill.pin",
      target: `${skill.name} on ${agent.name}`,
      details: { version: args.version },
    });
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
      const skillId = await ctx.db.insert("skills", { ...skill, createdAt: now, updatedAt: now });
      await recordVersion(ctx, skillId, "create", { author: "system" });
    }
    return { inserted: DEFAULT_SKILLS.length };
  },
});

/**
 * Role assignment: attach this skill to every ENABLED agent whose role is
 * in `roles` and detach it from enabled agents whose role is not. Disabled
 * agents are left exactly as they are. Order on each agent is preserved
 * (new → end); dependencies come along. Returns the agents touched and
 * warnings (dependencies pulled in, removed dependencies, permission gaps).
 */
export const assignRoles = mutation({
  args: { skillId: v.id("skills"), roles: v.array(v.string()) },
  handler: async (ctx, args): Promise<{ added: number; removed: number; warnings: string[] }> => {
    await assertRegistryWriteAccess(ctx);
    const skill = await ctx.db.get(args.skillId);
    if (!skill) throw new Error("Skill not found");
    const wanted = new Set(args.roles.map((r) => r.trim()).filter(Boolean));
    const agents = await ctx.db.query("agents").collect();
    const index = await skillIndex(ctx);
    let added = 0;
    let removed = 0;
    const warnings: string[] = [];
    for (const agent of agents) {
      if (agent.isEnabled === false) continue;
      const has = agent.skillIds?.includes(args.skillId) ?? false;
      const want = wanted.has(agent.role);
      if (has === want) continue;
      const next = want
        ? [...(agent.skillIds ?? []).map(String), String(args.skillId)]
        : (agent.skillIds ?? []).map(String).filter((id) => id !== String(args.skillId));
      warnings.push(...(await applyAgentSkills(ctx, agent, next, index)).warnings);
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
    return { added, removed, warnings: Array.from(new Set(warnings)) };
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
  /** Required skill names from front matter (resolved after the write). */
  requires: string[];
  /** Raw allowed-tools / permissions entries from front matter. */
  permissions: string[];
};

type ImportResult = {
  repo: string;
  sha: string;
  license: string | null;
  created: Array<{ skillId: Id<"skills">; name: string; path: string }>;
  updated: Array<{ skillId: Id<"skills">; name: string; path: string }>;
  unchanged: Array<{ skillId: Id<"skills">; name: string; path: string }>;
  skipped: Array<{ path: string; reason: string }>;
  /** Dependencies that could not be resolved, permission gaps, etc. */
  warnings: string[];
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
        requires: v.optional(v.array(v.string())),
        permissions: v.optional(v.array(v.string())),
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
      warnings: [],
    };
    const now = Date.now();
    const author = `github:${args.repo}`;
    const note = `Imported at ${args.sha.slice(0, 7)}`;
    // Written (created/updated/unchanged) skill per item, for the requires pass.
    const written: Array<{ skillId: Id<"skills">; item: (typeof args.items)[number]; name: string }> = [];
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
        clean = validateSkillInput(
          { description: item.description, instructions: item.instructions },
          { instructionsMax: SKILL_STORED_MAX }
        );
      } catch (err) {
        result.skipped.push({ path: item.path, reason: err instanceof Error ? err.message : "Invalid skill" });
        continue;
      }
      const existing = all.find(
        (row) => row.source?.kind === "github" && row.source.repo.toLowerCase() === repoKey && row.source.path === item.path
      );
      const permissions = normalizeSkillPermissions(item.permissions);
      if (existing) {
        const same =
          existing.source!.sha === args.sha &&
          existing.instructions === clean.instructions &&
          existing.description === (clean.description ?? "") &&
          sameList(existing.permissions, permissions);
        written.push({ skillId: existing._id, item, name: existing.name });
        if (same) {
          result.unchanged.push({ skillId: existing._id, name: existing.name, path: item.path });
          continue;
        }
        await ensureBaseline(ctx, existing);
        await ctx.db.patch(existing._id, {
          description: clean.description ?? "",
          instructions: clean.instructions!,
          permissions: permissions.length ? permissions : undefined,
          source,
          trimmed: item.trimmed ? true : undefined,
          updatedAt: now,
        });
        await recordVersion(ctx, existing._id, "import", { author, note });
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
        ...(permissions.length ? { permissions } : {}),
        ...(item.trimmed ? { trimmed: true } : {}),
        createdAt: now,
        updatedAt: now,
      });
      await recordVersion(ctx, skillId, "import", { author, note });
      written.push({ skillId, item, name: unique });
      result.created.push({ skillId, name: unique, path: item.path });
    }
    // Dependencies by name: first a skill from this import (front matter
    // or folder name), then any library skill with that name.
    const library = await ctx.db.query("skills").collect();
    for (const entry of written) {
      const names = entry.item.requires ?? [];
      if (names.length === 0) continue;
      const requires: Id<"skills">[] = [];
      for (const wanted of names) {
        const key = wanted.trim().toLowerCase();
        const fromImport = written.find(
          (w) => w.item.name.toLowerCase() === key || w.item.path.split("/").slice(-2, -1)[0]?.toLowerCase() === key
        );
        const match = fromImport?.skillId ?? library.find((row) => row.name.toLowerCase() === key)?._id;
        if (!match || match === entry.skillId) {
          result.warnings.push(`"${entry.name}" requires "${wanted}", which is not in the library. Import it too.`);
          continue;
        }
        if (!requires.includes(match)) requires.push(match);
      }
      const current = await ctx.db.get(entry.skillId);
      if (!current || sameList(current.requires, requires)) continue;
      const index = await skillIndex(ctx);
      if (createsDependencyCycle(String(entry.skillId), requires.map(String), requiresMapOf(index))) {
        result.warnings.push(`"${entry.name}" and a skill it requires require each other; dependencies were not set.`);
        continue;
      }
      await ctx.db.patch(entry.skillId, { requires: requires.length ? requires : undefined });
      // The dependency change is part of this import's version.
      const latest = await versionRow(ctx, entry.skillId, current.version ?? 0);
      if (latest && latest.kind === "import" && latest.sourceSha === args.sha) {
        await ctx.db.patch(latest._id, { requires: requires.length ? requires : undefined });
      } else {
        await recordVersion(ctx, entry.skillId, "import", { author, note });
      }
      result.warnings.push(...(await propagateDependencies(ctx, entry.skillId)));
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
    result.warnings = Array.from(new Set(result.warnings));
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
    /** Required skill names from front matter. */
    requires: string[];
    /** Declared permissions (normalized). */
    permissions: string[];
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
        requires: skill.requires,
        permissions: normalizeSkillPermissions(skill.permissions),
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
    // Stored untrimmed (Skill v2); only bodies past SKILL_STORED_MAX are
    // cut. Inline injection fits long ones at run time (inlineSkillBody).
    const fitted = fitSkillBody(skill.body, SKILL_STORED_MAX, skill.url);
    return {
      path,
      name: skill.name,
      description: skill.description,
      instructions: fitted.text,
      trimmed: fitted.trimmed,
      url: skill.url,
      requires: skill.requires,
      permissions: skill.permissions,
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

/**
 * Marketplace "Update all from source": re-read every skill imported from
 * `repo` at its default branch. Each changed skill gets a new version;
 * agents pinned to an older version keep it.
 */
export const updateAllFromSource = action({
  args: { repo: v.string() },
  handler: async (
    ctx,
    args
  ): Promise<{ sha: string; updated: string[]; unchanged: string[]; missing: string[]; warnings: string[] }> => {
    const rows: Array<{ _id: Id<"skills">; name: string; path: string; sha: string }> = await ctx.runQuery(
      internal.skills.githubSourcesForRepo,
      { repo: args.repo }
    );
    if (rows.length === 0) throw new Error(`No skills were imported from ${args.repo}`);
    const [owner, repo] = rows.length ? args.repo.split("/") : [];
    if (!owner || !repo) throw new Error("Use owner/repo");
    const result = await importPaths(ctx, { owner, repo, path: "", kind: "repo" }, rows.map((r) => r.path));
    return {
      sha: result.sha,
      updated: result.updated.map((r) => r.name),
      unchanged: result.unchanged.map((r) => r.name),
      missing: result.skipped.map((r) => r.path),
      warnings: result.warnings,
    };
  },
});
