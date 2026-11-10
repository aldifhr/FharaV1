/**
 * Personal chat (plan 039) display helpers, kept pure for node:test.
 */

export type ConversationKind = "personal" | "project" | "team";

/**
 * Header label, plain text (no badge): "Personal" for a personal chat with
 * no project, "Project: <name>" once a project is attached (and for a
 * project chat), "Team" for a team conversation.
 */
export function conversationKindLabel(kind: ConversationKind, projectName: string | null | undefined): string {
  if (kind === "team") return "Team";
  if (projectName) return `Project: ${projectName}`;
  return kind === "personal" ? "Personal" : "Project";
}

/** Empty-state copy under a personal chat with no messages yet. */
export function personalEmptyText(agentName: string, attachedProject: string | null | undefined): string {
  return attachedProject
    ? `Start a conversation with ${agentName}. This chat is attached to ${attachedProject}, so ${agentName} can read its files; tasks start only when you ask for one.`
    : `Start a conversation with ${agentName}. No project is attached, so ${agentName} can't read files or run tasks here.`;
}

/** localStorage key for the unsent draft of one conversation. */
export function personalDraftKey(conversationId: string): string {
  return `fhara-personal-draft-${conversationId}`;
}

/** Why a project cannot be picked in the Attach dialog, or null when it can. */
export function attachBlockReason(
  project: { agentIds?: readonly string[] | null },
  agent: { _id: string; name: string }
): string | null {
  return (project.agentIds ?? []).includes(agent._id) ? null : `${agent.name} is not on this project's team`;
}

/** Composer slash commands in a personal chat: /task only once a project is attached. */
export function personalSlashNames(attached: boolean): Array<"task"> {
  return attached ? ["task"] : [];
}

/** Attach dialog rows: every visible project, the ones whose team includes the agent first. */
export function attachCandidates<P extends { _id: string; name: string; agentIds?: readonly string[] | null }>(
  projects: readonly P[],
  agent: { _id: string; name: string }
): Array<{ project: P; blocked: string | null }> {
  return projects
    .map((project) => ({ project, blocked: attachBlockReason(project, agent) }))
    .sort((a, b) => Number(a.blocked !== null) - Number(b.blocked !== null) || a.project.name.localeCompare(b.project.name));
}
