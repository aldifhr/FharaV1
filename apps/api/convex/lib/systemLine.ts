/**
 * Orchestrator/CTO split O2: System status lines.
 *
 * The orchestrator is system code, not an agent. What it reports in a task
 * thread or chat ("Planned 4 subtasks", "Sent to Frontend") is a neutral
 * System line: a message with `voice: "system"`, no agentId, no @name, no
 * opinion. System lines are routing/status only and are never fed to a
 * model as transcript (buildChatMessages, chatContext history).
 *
 * Pure (no Convex APIs) so the worker, the API and the web can share it.
 */

export const SYSTEM_VOICE = "system" as const;
export const SYSTEM_LABEL = "System";
export const SYSTEM_LINE_MAX_CHARS = 300;

/** True for a System status line row. */
export function isSystemLine(row: { voice?: string | null } | null | undefined): boolean {
  return row?.voice === SYSTEM_VOICE;
}

/** One line, no @mentions, bounded: what a System line may say. */
export function normalizeSystemLine(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/(^|\s)@(\w)/g, "$1$2")
    .trim()
    .slice(0, SYSTEM_LINE_MAX_CHARS);
}
