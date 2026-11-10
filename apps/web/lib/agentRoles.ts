/**
 * Web view of the team roles. The definitions live in the shared role
 * module (`apps/api/convex/lib/roles.ts`), which the backend's fixed-team
 * seed and role registry also read; this file only adapts them to the
 * shapes the UI uses.
 */
import { FIXED_TEAM_SEED_ORDER, RETIRED_ROLE_KEYS, ROLES, ROLE_KEYS, roleKeyForMention, type RoleKey } from "@/api/convex/lib/roles";
import { fixedAgentIds as fixedAgentIdsFor, type AgentLike, type AgentRow } from "./agentIdentity";
import { AGENT_SEED_PROMPTS } from "@/api/convex/lib/prompts/agents";

export { roleKeyForMention, roleLabel } from "@/api/convex/lib/roles";
import { agentDisplayName, agentRoleCaption } from "./agentIdentity";
import { roleLabel as roleLabelOf } from "@/api/convex/lib/roles";

/** What to call an agent in the UI: its own name ("Reviewer 2"), else its role label. */
export function agentName(agent: AgentLike): string {
  return agentDisplayName(agent, roleLabelOf);
}

/** The role as secondary text, or null when it only repeats the name. */
export function agentRoleText(agent: AgentLike): string | null {
  return agentRoleCaption(agent, roleLabelOf);
}

/**
 * The default tool permissions of a role (e.g. `researcher` → read_file +
 * web_reach). An agent without its own `supportedTools` uses these.
 */
export function roleDefaultTools(role: string): string[] {
  const key = roleKeyForMention(role);
  return key ? [...ROLES[key].defaultTools] : [];
}

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

/** Ids of the fixed-team agents in `agents` (they can't be removed). */
export function fixedAgentIds(agents: readonly AgentRow[] | null | undefined): Set<string> {
  return fixedAgentIdsFor(agents, FIXED_TEAM_SEED_ORDER, RETIRED_ROLE_KEYS);
}
