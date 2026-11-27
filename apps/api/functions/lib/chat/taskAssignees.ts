/**
 * One assignee resolver for every way a task is created from chat (P1a):
 * the Create task button, a bare "gas"/"lanjut" after an offer, "/task …",
 * "kerjakan …", and "kerjakan itu" after an offer. Before this, three
 * pickers disagreed (the offer's single assignee, the keyword picker with a
 * Backend fallback, and "kerjakan itu" dropping the offer's assignee), and an
 * offer task ran with a one-agent pool, so its review and QA nodes were
 * dropped as unroutable.
 *
 * Rule: the owners are the user's @mentions, the offer's assignee, the
 * hint's role and the routed topic owner. When there is at least one owner,
 * the pool is CTO + owners + QA (resolveAssignees). Being in the pool is not
 * running: QA still runs only for code changes, and the CTO only answers
 * architecture-flagged plans. No owner at all: no narrowing (the whole
 * team), never a silent Backend default.
 *
 * Pure: no FharaRuntime or Node APIs (the web app imports it too).
 */
import { routeQuestion } from "./dispatch";
import { codeRoleForRequest } from "./intent";
import { BACKEND_WORD_SOURCE } from "../backendDomain";
import { resolveAssignees } from "./team";
import { normalizeRoleKey, LEGACY_ROLE_SUCCESSORS } from "../roles";
import { buildRoutingHint, type RoutingHint } from "../routingHint";

type Member = { _id: string; name: string; role: string };

const CTO_ROLE = /^(?:cto|architect)$/i;

const ROLE_KEYWORDS: Array<[string, RegExp]> = [
  [
    "frontend",
    /\b(ui|ux|component|komponen|page|halaman|tampilan|css|tailwind|react|layout|button|tombol|form|modal|frontend|next\.?js|design|desain|mockup|wireframe|warna|color|palette|typography|font|logo|branding)\b/i,
  ],
  [
    "backend",
    new RegExp(
      `\\b(?:${BACKEND_WORD_SOURCE}|helper|util|lib|function|fungsi|parser|algorithm|logic|logika|deploy|docker|ci|cd|pipeline|github actions|workflow|infra|kubernetes|nginx|docs|dokumentasi|documentation|readme|faq|panduan|guide|changelog)\\b`,
      "i"
    ),
  ],
];

/**
 * The team member for a role name. A retired name resolves to its successor
 * (a hint or a stored owner can still say "designer"), which is what the
 * fixed roster has to do with the old nine.
 */
const byRole = <T extends Member>(team: T[], role: string | undefined): T | undefined => {
  const key = role ? normalizeRoleKey(role) : "";
  if (!key) return undefined;
  const successor = LEGACY_ROLE_SUCCESSORS[key];
  return (
    team.find((a) => normalizeRoleKey(a.role) === key) ??
    (successor ? team.find((a) => normalizeRoleKey(a.role) === successor) : undefined)
  );
};

/** The team's CTO (the planner's model source), if any. */
export function teamCto<T extends Member>(team: T[]): T | null {
  return team.find((a) => CTO_ROLE.test(a.role.trim())) ?? null;
}

/**
 * Who owns a task command, read like chat routes a message (no LLM): the
 * topic owner (routeQuestion), the role its files belong to, and the roles
 * its keywords name. Empty when nothing matches: no Backend default. The CTO
 * is never an owner here (it plans; it does not implement).
 */
export function routedOwners<T extends Member>(text: string, team: T[]): { owners: T[]; domain?: string; topic?: string } {
  // A verification-only request is QA work, even when it mentions a page or
  // an app. File-change verbs keep it with the implementing role.
  const withoutNoChange = text
    .replace(/^\s*(?:create a task|buat task|buatkan task|\/task|kerjakan)\s*[:;]?\s*/i, "")
    .replace(/\b(?:do not|don't|jangan)\s+(?:change|edit|modify|ubah)\s+(?:any\s+)?files?\b/gi, "");
  const verificationOnly =
    /\b(?:check|verify|report|console|reachability|browser errors?|loads?)\b/i.test(withoutNoChange) &&
    !/\b(?:add|create|write|edit|update|fix|remove|change|tambahkan|buat|ubah|perbaiki|hapus)\b/i.test(withoutNoChange);
  if (verificationOnly) {
    const qa = byRole(team, "qa");
    return { owners: qa ? [qa] : [], domain: "qa", topic: "verification" };
  }
  const route = routeQuestion({ text, team });
  const owners: T[] = [];
  const add = (agent: T | undefined) => {
    if (agent && !owners.includes(agent)) owners.push(agent);
  };
  const codeRole = codeRoleForRequest(text);
  const fileChange = /\b(?:add|create|write|change|edit|update|remove|tambah|buat|ubah|tulis|hapus)\b/i.test(text);
  // A concrete file change outranks a topic keyword: "add a comment saying
  // QA checks..." is Frontend work that merely mentions QA, not QA work.
  if (fileChange && codeRole) add(byRole(team, codeRole));
  if (route.kind === "specialist" && !CTO_ROLE.test(route.agent.role.trim())) add(route.agent);
  if (!fileChange) add(byRole(team, codeRole ?? undefined));
  for (const [role, words] of ROLE_KEYWORDS) if (words.test(text)) add(byRole(team, role));
  const domain = fileChange && codeRole ? codeRole : route.kind === "specialist" ? route.domain : undefined;
  const topic = route.kind === "specialist" ? route.topic : undefined;
  return { owners, ...(domain ? { domain } : {}), ...(topic ? { topic } : {}) };
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
  // In the order given, so re-resolving an already resolved pool keeps it as it was.
  for (const id of [...(input.mentionedIds ?? []), ...(input.offerAssigneeId ? [input.offerAssigneeId] : [])]) add(team.find((a) => String(a._id) === String(id)));
  add(byRole(team, input.hint?.role));
  for (const agent of input.routed ?? []) add(agent);
  // The CTO is always in a narrowed pool as the planner; as the ONLY owner it would leave nobody to do the work.
  if (!owners.some((a) => a !== cto)) return [];
  return resolveAssignees(team, cto, owners);
}

/**
 * The hint for a task typed as a command ("/task …", "kerjakan …"): the
 * routed owner, its domain and code topic; `hard` when the user @mentioned
 * someone (an explicit @mention is binding).
 */
export function hintForCommand<T extends Member>(
  text: string,
  team: T[],
  opts: { mentioned?: T[]; routed?: { owners: T[]; domain?: string; topic?: string } } = {}
): RoutingHint {
  const mentioned = (opts.mentioned ?? []).filter((a) => !CTO_ROLE.test(a.role.trim()));
  const routed = opts.routed ?? routedOwners(text, team);
  const owner = mentioned[0] ?? routed.owners[0];
  return buildRoutingHint({
    source: mentioned.length ? "mention" : "command",
    role: owner?.role,
    domain: routed.domain,
    topic: routed.topic,
    text,
    hard: mentioned.length > 0,
  });
}
