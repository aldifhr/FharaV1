/**
 * Chat team selection: who answers an ASK and which agents form an assigned
 * task's pool. Handoff roles come from validated structured data, never from
 * parsing role names out of text. Pure helpers.
 */
import { resolveRoleKey } from "../roles";

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
  const notCto = agents.filter((a) => {
    const key = resolveRoleKey(a.role);
    return key !== "cto" && key !== "lead";
  });
  if (notCto.length === 0) return agents; // user mentioned the CTO explicitly
  const general = notCto.find((a) => /^(general|assistant)/i.test(a.role));
  if (general) return [general];
  const writer = notCto.find((a) => resolveRoleKey(a.role) === "backend");
  if (writer) return [writer];
  return [notCto[0]];
}

/** Who answers a bare greeting: the mentioned agents, else Support (the
 *  guidance role; O3: no CTO default), else the conversational fallback.
 *  Before plan 016 the Researcher answered "hello"; before O3 the CTO did. */
export function pickGreetingResponders<T extends ChatAgent>(mentioned: T[], team: T[]): T[] {
  if (mentioned.length > 0) return mentioned;
  const support = team.find((a) => resolveRoleKey(a.role) === "backend");
  if (support) return [support];
  return pickConversationalAgent(team) as T[];
}

/**
 * The task's agent pool when the CTO (or the user) assigned specific
 * teammates: the CTO (planner), the assignees, and QA so the checks still
 * run. Empty when nobody was assigned (the whole team is used).
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
  for (const agent of team) if (resolveRoleKey(agent.role) === "qa") pool.set(String(agent._id), agent);
  return [...pool.values()];
}
