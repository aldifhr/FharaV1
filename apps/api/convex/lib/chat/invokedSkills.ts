/**
 * Paradev C3: resolve the skills a message invoked ("/<skill> [request]")
 * against the skills the given agents carry, the same set the composer's "/"
 * menu lists (skills assigned to the team, or to the personal agent).
 *
 * The bodies come through loadPromptSkills, so an agent's version pin and the
 * inline size cap (inlineSkillBody) apply exactly as for attached skills.
 */
import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { loadPromptSkills } from "../../skillLibrary";
import type { PromptSkill } from "../skills";
import { missingSkillError, normalizeInvokedSkills } from "../invokedSkillsSchema";

export interface ResolvedInvokedSkills {
  /** In the order invoked, under each skill's canonical name. */
  skills: PromptSkill[];
  /** Names no agent carries, as typed. */
  missing: string[];
}

export async function resolveInvokedSkills(
  ctx: QueryCtx | MutationCtx,
  names: readonly string[] | undefined,
  agents: ReadonlyArray<Pick<Doc<"agents">, "skillIds" | "skillPins" | "isEnabled"> | null>
): Promise<ResolvedInvokedSkills> {
  const wanted = normalizeInvokedSkills(names);
  if (!wanted.length) return { skills: [], missing: [] };
  const byName = new Map<string, PromptSkill>();
  for (const agent of agents) {
    if (!agent || agent.isEnabled === false) continue;
    for (const skill of await loadPromptSkills(ctx, agent)) {
      const key = skill.name.trim().toLowerCase();
      if (key && !byName.has(key)) byName.set(key, skill);
    }
  }
  const skills: PromptSkill[] = [];
  const missing: string[] = [];
  for (const name of wanted) {
    const hit = byName.get(name.toLowerCase());
    if (hit) skills.push(hit);
    else missing.push(name);
  }
  return { skills, missing };
}

/** Canonical names for storage; throws "No skill named X on this team." on the first unknown one. */
export async function assertInvokedSkills(
  ctx: QueryCtx | MutationCtx,
  names: readonly string[] | undefined,
  agents: ReadonlyArray<Pick<Doc<"agents">, "skillIds" | "skillPins" | "isEnabled"> | null>
): Promise<string[]> {
  const { skills, missing } = await resolveInvokedSkills(ctx, names, agents);
  if (missing.length) throw new Error(missingSkillError(missing[0]));
  return skills.map((s) => s.name);
}
