import { action, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { assertServiceToken } from "./lib/authz";
import type { LibrarySkillRef, PromptSkill } from "./lib/skills";
import { missingPermissions } from "./lib/skillGraph";
import { inlineSkillBody } from "./lib/githubSkills";

/**
 * Skills as agents read them at run time (split out of skills.ts, which
 * keeps the library CRUD and imports).
 *
 * - `loadPromptSkills`: an agent's attached skills, with bodies.
 * - `loadLibrarySkills`: the shared library offered to one agent, as a
 *   bodiless index (name, description, version). `load_skill` fetches the
 *   body on demand: chat through `body` (runQuery), the worker through the
 *   token-gated `bodyForWorker` action. Both re-check that the agent may
 *   use the skill.
 */

type Ctx = QueryCtx | MutationCtx;

/** Agent fields the library filter reads. */
export type LibraryAgent = Pick<Doc<"agents">, "role" | "supportedTools" | "capabilities" | "skillIds" | "skillPins">;

export async function versionRow(
  ctx: Ctx,
  skillId: Id<"skills">,
  version: number
): Promise<Doc<"skillVersions"> | null> {
  return await ctx.db
    .query("skillVersions")
    .withIndex("by_skill", (q) => q.eq("skillId", skillId).eq("version", version))
    .first();
}

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

/** The content an agent reads for one skill: its pinned version, else the latest. */
type Effective = {
  name: string;
  description: string;
  instructions: string;
  version?: number;
  permissions?: readonly string[];
  requires?: readonly Id<"skills">[];
};

async function effectiveFor(ctx: Ctx, row: Doc<"skills">, agent: LibraryAgent): Promise<Effective> {
  const pin = agent.skillPins?.find((p) => p.skillId === row._id);
  const pinned = pin ? await versionRow(ctx, row._id, pin.version) : null;
  const src = pinned ?? row;
  return {
    name: src.name,
    description: src.description,
    instructions: src.instructions,
    version: pinned ? pinned.version : row.version || undefined,
    permissions: src.permissions,
    requires: src.requires,
  };
}

/**
 * Which skills this agent may use. A skill is out when the agent lacks a
 * permission it declares (`missingPermissions`), or when a skill it requires
 * is neither attached to the agent nor itself usable (deleted, or blocked by
 * permissions in turn). Memoized; dependency cycles are refused at write
 * time, and a cycle met here counts as usable rather than recursing.
 */
function usableChecker(ctx: Ctx, agent: LibraryAgent, known: Map<string, Doc<"skills">>) {
  const attached = new Set((agent.skillIds ?? []).map(String));
  const done = new Map<string, boolean>();
  const visiting = new Set<string>();
  const check = async (id: string): Promise<boolean> => {
    const hit = done.get(id);
    if (hit !== undefined) return hit;
    if (visiting.has(id)) return true;
    visiting.add(id);
    try {
      const row = known.get(id) ?? (await ctx.db.get(id as Id<"skills">));
      let ok = row !== null;
      if (row) {
        known.set(id, row);
        const eff = await effectiveFor(ctx, row, agent);
        ok = missingPermissions(eff.permissions, agent).length === 0;
        for (const req of eff.requires ?? []) {
          if (!ok) break;
          if (!attached.has(String(req))) ok = await check(String(req));
        }
      }
      done.set(id, ok);
      return ok;
    } finally {
      visiting.delete(id);
    }
  };
  return check;
}

/**
 * The shared library as one agent may use it: name, description and version
 * only (never bodies), the agent's pinned version winning, and skills it
 * cannot use (missing permissions or required skills) left out.
 */
export async function loadLibrarySkills(ctx: Ctx, agent: LibraryAgent, limit = 200): Promise<LibrarySkillRef[]> {
  const rows = await ctx.db.query("skills").take(limit);
  const known = new Map(rows.map((row) => [String(row._id), row]));
  const usable = usableChecker(ctx, agent, known);
  const out: LibrarySkillRef[] = [];
  for (const row of rows) {
    if (!(await usable(String(row._id)))) continue;
    const eff = await effectiveFor(ctx, row, agent);
    out.push({
      name: eff.name,
      ...(eff.description ? { description: eff.description } : {}),
      ...(eff.version ? { version: eff.version } : {}),
    });
  }
  return out;
}

/** `{ librarySkills }` for a worker run-context agent, or nothing when none is usable. */
export async function libraryField(ctx: Ctx, agent: LibraryAgent): Promise<{ librarySkills?: LibrarySkillRef[] }> {
  const librarySkills = await loadLibrarySkills(ctx, agent);
  return librarySkills.length ? { librarySkills } : {};
}

/** Finds a library skill by the name the agent was shown (its pinned name, or the current one). */
async function findForAgent(ctx: Ctx, agent: LibraryAgent, name: string): Promise<Doc<"skills"> | null> {
  for (const pin of agent.skillPins ?? []) {
    const pinned = await versionRow(ctx, pin.skillId, pin.version);
    if (pinned?.name === name) return await ctx.db.get(pin.skillId);
  }
  return await ctx.db
    .query("skills")
    .withIndex("by_name", (q) => q.eq("name", name))
    .first();
}

/**
 * One library skill's full body for `load_skill`, or null when the agent
 * may not use it (or it is gone). The version is the agent's pin, else the
 * latest; a `version` the agent was shown wins over a newer edit.
 */
export async function libraryBodyFor(
  ctx: Ctx,
  agent: LibraryAgent,
  name: string,
  version?: number
): Promise<{ name: string; body: string; version?: number } | null> {
  const row = await findForAgent(ctx, agent, name.trim());
  if (!row) return null;
  if (!(await usableChecker(ctx, agent, new Map())(String(row._id)))) return null;
  const eff = await effectiveFor(ctx, row, agent);
  const shown = version !== undefined && version !== eff.version ? await versionRow(ctx, row._id, version) : null;
  const pick = shown ?? eff;
  return { name: pick.name, body: pick.instructions, ...(pick.version ? { version: pick.version } : {}) };
}

const bodyArgs = { agentId: v.id("agents"), name: v.string(), version: v.optional(v.number()) };

/** Chat: load_skill over a library skill (runQuery from the chat action). */
export const body = internalQuery({
  args: bodyArgs,
  handler: async (ctx, args) => {
    const agent = await ctx.db.get(args.agentId);
    if (!agent || agent.isEnabled === false) return null;
    return await libraryBodyFor(ctx, agent, args.name, args.version);
  },
});

/** Worker: load_skill over a library skill. Token-gated like every worker action. */
export const bodyForWorker = action({
  args: { workerToken: v.string(), ...bodyArgs },
  handler: async (ctx, args): Promise<{ name: string; body: string; version?: number } | null> => {
    assertServiceToken(args.workerToken);
    const { workerToken: _token, ...rest } = args;
    return await ctx.runQuery(internal.skillLibrary.body, rest);
  },
});
