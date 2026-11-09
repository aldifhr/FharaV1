/**
 * Chat team selection: who answers an ASK, who the CTO handed work to, and
 * which agents form an assigned task's pool. Pure helpers, unit-tested in
 * chatIntent.test.ts.
 */

export type ChatAgent = {
  _id: string;
  name: string;
  role: string;
  systemPrompt?: string;
  /** Pre-rendered library skills (`## Skill: …` sections), budgeted. */
  skillsSection?: string;
  /** Pre-rendered pinned memories (`## Memory`), budgeted; after the skills. */
  memorySection?: string;
};

/** The chat orchestrator: role exactly "cto" (legacy "architect"). */
export const ORCHESTRATOR_ROLE = /^(cto|architect)$/i;
/** Roles that never answer as the conversational (ASK) agent. Anchored;
 *  the retired "lead" role is no longer special-cased. */
export const ORCHESTRATOR_LIKE_ROLE = /^(cto|architect|orchestrator|planner|manager)$/i;

/** One conversational agent for every ASK (plan 016). The CTO/Orchestrator
 *  owns TASK; their functions stay separate. Prefer a general-purpose
 *  agent (General/Assistant), then Researcher, then Support — never a
 *  coding role. An explicit
 *  mention (the user routed to the CTO by @CTO) always wins. This is the
 *  deterministic fallback when the CTO chooser (below) is unavailable.
 *  Exported for unit tests. */
export function pickConversationalAgent(
  agents: ChatAgent[]
): ChatAgent[] {
  const notCto = agents.filter((a) => !ORCHESTRATOR_LIKE_ROLE.test(a.role.trim()));
  if (notCto.length === 0) return agents; // user mentioned the CTO explicitly
  const general = notCto.find((a) => /^(general|assistant)/i.test(a.role));
  if (general) return [general];
  const researcher = notCto.find((a) => /^researcher/i.test(a.role));
  if (researcher) return [researcher];
  const support = notCto.find((a) => /^support/i.test(a.role));
  if (support) return [support];
  return [notCto[0]];
}

/** Who answers a bare greeting: the mentioned agents, else the CTO (the
 *  default chat participant), else the conversational fallback. Before
 *  this, greetings skipped the CTO and the Researcher answered "hello". */
export function pickGreetingResponders<T extends ChatAgent>(
  mentioned: T[],
  orchestrator: T | null,
  team: T[]
): T[] {
  if (mentioned.length > 0) return mentioned;
  if (orchestrator) return [orchestrator];
  return pickConversationalAgent(team) as T[];
}

/** Max teammates the CTO can pull into one chat turn by @mention. */
export const MAX_CTO_HANDOFFS = 3;

/**
 * Teammates the CTO addressed in its reply with `@Name` or `@role`
 * (case-insensitive, whole word), in the order they first appear. The
 * speaker itself and unknown names are ignored. Exported for unit tests.
 */
export function extractAgentMentions<T extends { _id: string; name: string; role: string }>(
  text: string,
  team: T[],
  speakerId?: string
): T[] {
  const hits: Array<{ index: number; agent: T }> = [];
  for (const agent of team) {
    if (speakerId && String(agent._id) === String(speakerId)) continue;
    const labels = Array.from(new Set([agent.name, agent.role].filter(Boolean)));
    let first = -1;
    for (const label of labels) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
      const match = new RegExp(`(^|[^\\w@])@${escaped}(?![\\w-])`, "i").exec(text);
      if (match && (first === -1 || match.index < first)) first = match.index;
    }
    if (first !== -1) hits.push({ index: first, agent });
  }
  return hits.sort((a, b) => a.index - b.index).map((hit) => hit.agent);
}

/** Roles that always stay in an assigned task's pool so review and QA still run. */
const ALWAYS_IN_POOL = /^(reviewer|qa)$/i;

/**
 * The task's agent pool when the CTO (or the user) assigned specific
 * teammates: the CTO (planner), the assignees, and the Reviewer/QA so the
 * checks still run. Empty when nobody was assigned (the whole team is used).
 */
export function resolveAssignees<T extends { _id: string; role: string }>(
  team: T[],
  orchestrator: T | null,
  picked: T[]
): T[] {
  if (picked.length === 0) return [];
  const pool = new Map<string, T>();
  if (orchestrator) pool.set(String(orchestrator._id), orchestrator);
  for (const agent of picked) pool.set(String(agent._id), agent);
  for (const agent of team) if (ALWAYS_IN_POOL.test(agent.role)) pool.set(String(agent._id), agent);
  return [...pool.values()];
}

const ROLE_KEYWORDS: Array<[RegExp, RegExp]> = [
  [/^frontend$/i, /\b(ui|ux|component|komponen|page|halaman|tampilan|css|tailwind|react|layout|button|tombol|form|modal|frontend|next\.?js)\b/i],
  [/^backend$/i, /\b(api|endpoint|helper|util|lib|function|fungsi|database|db|schema|server|convex|query|mutation|backend|parser|algorithm|logic|logika)\b/i],
  [/^designer$/i, /\b(design|desain|mockup|wireframe|warna|color|palette|typography|font|logo|branding)\b/i],
  [/^devops$/i, /\b(deploy|docker|ci|cd|pipeline|github actions|workflow|infra|kubernetes|nginx)\b/i],
  [/^researcher$/i, /\b(riset|research|bandingkan|compare|cari tahu|investigate|analisis|analysis|benchmark)\b/i],
  [/^support$/i, /\b(docs|dokumentasi|documentation|readme|faq|panduan|guide|changelog)\b/i],
];

/**
 * Deterministic assignee pick from the request text, used when the CTO's
 * reply names nobody (empty reply, or no @mentions). Falls back to Backend
 * for code work so a task never silently goes to the whole team.
 */
export function suggestAssigneesByKeywords<T extends { _id: string; name: string; role: string }>(
  text: string,
  team: T[]
): T[] {
  const picked: T[] = [];
  for (const [roleRe, wordRe] of ROLE_KEYWORDS) {
    if (!wordRe.test(text)) continue;
    const agent = team.find((a) => roleRe.test(a.role) || roleRe.test(a.name));
    if (agent && !picked.includes(agent)) picked.push(agent);
  }
  if (picked.length === 0) {
    const fallback = team.find((a) => /^backend$/i.test(a.role) || /^backend$/i.test(a.name));
    if (fallback) picked.push(fallback);
  }
  return picked;
}

/** Parse the CTO chooser's reply: the chosen candidate id, or null. */
export function parseResponderSelection(raw: string, candidateIds: string[]): string | null {
  const text = raw.trim();
  const json = text.match(/\{[\s\S]*\}/);
  if (!json) return null;
  try {
    const o = JSON.parse(json[0]) as { agentId?: unknown };
    return typeof o.agentId === "string" && candidateIds.includes(o.agentId) ? o.agentId : null;
  } catch {
    return null;
  }
}
