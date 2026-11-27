/**
 * One assignee resolver for every way a task is created from chat. Owners come
 * from the validated structured routing decision, the user's mention ids or
 * an offer's assignee — never from role keywords in the command text.
 *
 * Pure: no FharaRuntime or Node APIs (the web app imports it too).
 */
import { resolveAssignees } from "./team";
import { isCtoRole, resolveRoleKey } from "../roles";
import { buildRoutingHint, type RoutingHint } from "../routingHint";
import type { RoutingClassification } from "./routingClassification";

type Member = { _id: string; name: string; role: string };

/** The team member for a live role key (legacy names resolve to successors). */
const byRole = <T extends Member>(team: T[], role: string | undefined | null): T | undefined => {
  const key = resolveRoleKey(role ?? "");
  return key ? team.find((a) => resolveRoleKey(a.role) === key) : undefined;
};

/** The team's CTO (the planner's model source), if any. */
export function teamCto<T extends Member>(team: T[]): T | null {
  return team.find((a) => isCtoRole(a.role)) ?? null;
}

/**
 * Owners of a task command, read only from the classifier's validated role.
 * The CTO is never an owner here (it plans; it does not implement). No role at
 * sufficient confidence means no owner: no narrowing, never a Backend default.
 */
export function routedOwners<T extends Member>(
  routing: RoutingClassification | undefined | null,
  team: T[]
): { owners: T[]; domain?: string; topic?: string } {
  if (!routing?.role) return { owners: [] };
  const owner = byRole(team, routing.role);
  if (!owner || isCtoRole(owner.role)) return { owners: [] };
  return {
    owners: [owner],
    domain: routing.kind,
    ...(routing.files[0] ? { topic: routing.files[0] } : {}),
  };
}

/**
 * The task's agent pool. `team` is the project's enabled team (CTO
 * included). Returns [] for "no narrowing" (nobody owns it: whole team).
 */
export function resolveTaskAssignees<T extends Member>(input: {
  team: T[];
  /** Agent ids the user @mentioned, or the offering reply named. */
  mentionedIds?: string[];
  /** messages.taskOffer.assigneeAgentId */
  offerAssigneeId?: string;
  hint?: RoutingHint | null;
  /** Agents already routed as owners (routedOwners), when the caller has them. */
  routed?: T[];
}): T[] {
  const { team } = input;
  const cto = teamCto(team);
  const owners: T[] = [];
  const add = (agent: T | undefined) => {
    if (agent && !owners.includes(agent)) owners.push(agent);
  };
  for (const id of [...(input.mentionedIds ?? []), ...(input.offerAssigneeId ? [input.offerAssigneeId] : [])]) add(team.find((a) => String(a._id) === String(id)));
  add(byRole(team, input.hint?.role));
  for (const agent of input.routed ?? []) add(agent);
  // The CTO is always in a narrowed pool as the planner; as the ONLY owner it would leave nobody to do the work.
  if (!owners.some((a) => a !== cto)) return [];
  return resolveAssignees(team, cto, owners);
}

/**
 * The hint for a task typed as a command ("/task …", "kerjakan …"): the
 * classifier's owner, domain and file topic; `hard` when the user @mentioned
 * someone (an explicit @mention is binding). Without a routing decision there
 * is no inferred role or domain.
 */
export function hintForCommand<T extends Member>(
  text: string,
  team: T[],
  opts: { mentioned?: T[]; routed?: { owners: T[]; domain?: string; topic?: string } } = {}
): RoutingHint {
  const mentioned = (opts.mentioned ?? []).filter((a) => !isCtoRole(a.role));
  const routed: { owners: T[]; domain?: string; topic?: string } = opts.routed ?? { owners: [] };
  const owner = mentioned[0] ?? routed.owners?.[0];
  return buildRoutingHint({
    source: mentioned.length ? "mention" : "command",
    role: owner?.role,
    domain: routed.domain,
    topic: routed.topic,
    text,
    hard: mentioned.length > 0,
  });
}
