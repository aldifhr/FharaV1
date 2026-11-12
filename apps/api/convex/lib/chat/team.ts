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
  /**
   * Skill v2: set only for an on_demand agent. Its prompt carries the index
   * (`skillsSection`) and the reply loop serves load_skill from these.
   */
  onDemandSkills?: Array<{ name: string; instructions: string; description?: string; fullInstructions?: string; version?: number }>;
  /** The shared library skills this agent may use: no bodies; load_skill fetches one (skillLibrary.body). */
  librarySkills?: Array<{ name: string; description?: string; version?: number }>;
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

/** Who answers a bare greeting: the mentioned agents, else Support (the
 *  guidance role; O3: no CTO default), else the conversational fallback.
 *  Before plan 016 the Researcher answered "hello"; before O3 the CTO did. */
export function pickGreetingResponders<T extends ChatAgent>(mentioned: T[], team: T[]): T[] {
  if (mentioned.length > 0) return mentioned;
  const support = team.find((a) => /^support/i.test(a.role.trim()));
  if (support) return [support];
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

/**
 * Teammates the CTO actually handed part of the turn to. Mentions only count
 * as a handoff when the CTO addressed at most MAX_CTO_HANDOFFS teammates;
 * a reply that names more (e.g. "@Designer for UX, @Frontend for code, @QA
 * ...") is describing the team, not asking them anything, so nobody is
 * pulled in. Exported for unit tests.
 */
export function selectHandoffs<T extends { _id: string; name: string; role: string }>(
  text: string,
  team: T[],
  speakerId?: string
): T[] {
  const mentioned = extractAgentMentions(text, team, speakerId);
  return mentioned.length > MAX_CTO_HANDOFFS ? [] : mentioned;
}

/** The sentence(s) of the CTO reply addressed to one teammate. */
export function handoffRequestFor(text: string, agent: { name: string; role: string }): string {
  const labels = Array.from(new Set([agent.name, agent.role].filter(Boolean)))
    .map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
  const re = new RegExp(`(^|[^\\w@])@(${labels.join("|")})(?![\\w-])`, "i");
  return text
    .split(/(?<=[.?!])\s+|\n+/)
    .filter((sentence) => re.test(sentence))
    .join(" ")
    .trim()
    .slice(0, 400);
}

/**
 * A handoff request that asks the teammate to check/verify code ("cek",
 * "verifikasi", "periksa", "grep", "check", "verify"). Without repo access
 * the teammate cannot do it either, so such handoffs are dropped.
 */
export function isVerificationRequest(text: string): boolean {
  return /\b(?:cek|ngecek|mengecek|dicek|pengecekan|periksa|memeriksa|diperiksa|pemeriksaan|verifikasi|memverifikasi|diverifikasi|grep|check(?:s|ed|ing)?|verif(?:y|ies|ied|ying))\b/i.test(text);
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
