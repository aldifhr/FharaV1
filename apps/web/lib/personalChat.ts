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

/** One row of `conversations.listPersonal`, the fields the sidebar reads. */
export type PersonalListRow = {
  agent: { _id: string; name: string; role: string };
  conversationId: string | null;
  lastMessageAt: number | null;
  preview: string | null;
};

/**
 * Sidebar "Personal messages" rows: only agents that already have a personal
 * conversation, most recent first (no messages yet sorts last, then by name),
 * narrowed by the sidebar search on the agent name or role label.
 */
export function sidebarPersonalRows<R extends PersonalListRow>(
  rows: readonly R[] | null | undefined,
  filter = "",
  label: (role: string) => string = (role) => role
): R[] {
  const q = filter.trim().toLowerCase();
  return (rows ?? [])
    .filter((row) => row.conversationId !== null)
    .filter((row) => !q || row.agent.name.toLowerCase().includes(q) || label(row.agent.role).toLowerCase().includes(q))
    .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0) || a.agent.name.localeCompare(b.agent.name));
}

/** Agent id of the personal chat a path shows (`/chats/personal/<id>`), or null. */
export function personalAgentIdFromPath(pathname: string | null | undefined): string | null {
  const match = /^\/chats\/personal\/([^/?#]+)/.exec(pathname ?? "");
  return match ? decodeURIComponent(match[1]) : null;
}

/** Where `/chats/personal` lands: the most recent personal chat, else the chats home. */
export function personalIndexTarget(rows: readonly PersonalListRow[] | null | undefined): string {
  const [latest] = sidebarPersonalRows(rows);
  return latest ? `/chats/personal/${latest.agent._id}` : "/chats";
}
