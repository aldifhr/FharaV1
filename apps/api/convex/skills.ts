import { query, mutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { assertRegistryWriteAccess } from "./lib/authz";
import { DEFAULT_SKILLS, validateSkillInput, type PromptSkill } from "./lib/skills";

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
