/**
 * Web view of the team roles. The definitions live in the shared role
 * module (`apps/api/convex/lib/roles.ts`), which the backend's fixed-team
 * seed and role registry also read; this file only adapts them to the
 * shapes the UI uses.
 */
import { ROLES, ROLE_KEYS, type RoleKey } from "@/api/convex/lib/roles";
import { AGENT_SEED_PROMPTS } from "@/api/convex/lib/prompts/agents";

export { roleKeyForMention, roleLabel } from "@/api/convex/lib/roles";

/** The current team roles, in display order. Every role menu reads this list. */
export const AGENT_ROLES = ROLE_KEYS;



/** Chip colours per role, used for @mention chips in chat. */
export const ROLE_COLORS = Object.fromEntries(
  ROLE_KEYS.map((key) => [key, ROLES[key].color])
) as Record<RoleKey, string>;

export const NEUTRAL_MENTION_COLOR =
  "bg-gray-500/10 text-gray-700 ring-gray-500/20 dark:bg-gray-500/20 dark:text-gray-200";

/**
 * Seed system prompt per role — the same text the backend seeds the fixed
 * team with and applies when agents.create gets no prompt. Prefills the
 * create-agent form; the prompt stays editable via agents.update.
 */
export const ROLE_DEFAULT_PROMPTS: Record<string, string> = Object.fromEntries(
  ROLE_KEYS.map((key) => [key, AGENT_SEED_PROMPTS[ROLES[key].defaultPromptKey]])
);
