/**
 * Paradev C3 (plan audit/paradev-plan-2026-11-11.md, P-C): skills the user
 * invoked with "/<skill> [request]". Kept out of schema.ts so that file stays
 * within its line budget. Pure: no Convex ctx, so web and worker tests can
 * import it.
 */
import { v } from "convex/values";
import { SKILL_NAME_MAX } from "./skills";

/** Skills one message (and the task made from it) may invoke. */
export const INVOKED_SKILLS_MAX = 3;

/** `messages.invokedSkills` / `tasks.invokedSkills`: skill names, as stored. */
export const invokedSkillsField = v.optional(v.array(v.string()));

/** Trimmed, de-duplicated (case-insensitive) names; throws on a bad list. */
export function normalizeInvokedSkills(raw: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of raw ?? []) {
    const name = value.trim();
    if (!name) continue;
    if (name.length > SKILL_NAME_MAX) throw new Error(`Skill name must be ${SKILL_NAME_MAX} characters or fewer`);
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  if (out.length > INVOKED_SKILLS_MAX) throw new Error(`Invoke at most ${INVOKED_SKILLS_MAX} skills in one message`);
  return out;
}

/** The inline error the composer shows for a skill the team does not carry. */
export function missingSkillError(name: string): string {
  return `No skill named ${name} on this team.`;
}
