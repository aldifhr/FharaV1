/**
 * Conversation kinds (plan 039, personal chat). Pure helpers, no Convex
 * context, so the rules are unit-tested on their own.
 *
 *   personal  one agent, own history; projectId absent until attachProject
 *             sets it once (no detach / switch in v1). Its messages never
 *             carry projectId (D1).
 *   project   today's project chat (legacy rows have no `kind`).
 *   team      reserved for team chat without a project (deferred, D6);
 *             requires a project in v1.
 */
import type { Id } from "../_generated/dataModel";
import { looksIndonesian } from "./chat/toolCallText";

export type ConversationKind = "personal" | "project" | "team";

type KindRow = { kind?: ConversationKind | undefined } | null | undefined;

/** A row's kind. Legacy rows (no `kind`) are project conversations. */
export function conversationKind(row: KindRow): ConversationKind {
  return row?.kind ?? "project";
}

export function isPersonalConversation(row: KindRow): boolean {
  return conversationKind(row) === "personal";
}

export interface ConversationShapeInput {
  kind?: ConversationKind;
  agentId?: Id<"agents"> | string;
  projectId?: Id<"projects"> | string;
}

/**
 * Shape check for a conversation row about to be written. Returns the
 * reason it is invalid, or null. Personal: agentId required (projectId is
 * allowed only because attachProject sets it later; creation code passes
 * none). Project/team: projectId required, agentId absent.
 */
export function conversationShapeError(row: ConversationShapeInput): string | null {
  const kind = row.kind ?? "project";
  if (kind === "personal") {
    if (!row.agentId) return "A personal conversation needs an agent";
    return null;
  }
  if (!row.projectId) return `A ${kind} conversation needs a project`;
  if (row.agentId) return `A ${kind} conversation has no single agent`;
  return null;
}

/**
 * The scope a chat reply runs in, derived server-side from the conversation
 * row only (rule PC-S1). There is no default or "currently selected"
 * project: a personal conversation without projectId has none, and every
 * project feature (repo tools, repo snapshot, tasks, project memory) is
 * gated on `projectId !== null`.
 */
export interface ChatScope {
  kind: ConversationKind;
  agentId: Id<"agents"> | null;
  projectId: Id<"projects"> | null;
}

export function chatScopeOf(row: {
  kind?: ConversationKind;
  agentId?: Id<"agents">;
  projectId?: Id<"projects">;
}): ChatScope {
  return {
    kind: conversationKind(row),
    agentId: row.agentId ?? null,
    projectId: row.projectId ?? null,
  };
}

/**
 * projectId for a message written into this conversation: none for a
 * personal conversation (D1), the given project otherwise.
 */
export function messageProjectIdFor(
  conversation: KindRow,
  projectId: Id<"projects"> | undefined
): Id<"projects"> | undefined {
  return isPersonalConversation(conversation) ? undefined : projectId;
}

/** Fixed reply when a personal chat without a project is asked to start a task. */
export function personalNoTaskReply(userText: string): string {
  // The task verbs themselves count: "kerjakan perbaikan bug login".
  const indonesian = looksIndonesian(userText) || /\b(kerja(kan|in)?|bikin(kan|in)?|buat(kan|in)?|perbaiki|benerin|tambahkan|jalankan)\b/i.test(userText);
  return indonesian
    ? "Ini chat pribadi tanpa proyek, jadi saya tidak bisa memulai task di sini. Tempelkan proyek (Attach project) untuk mengerjakan kode."
    : "This is a personal chat with no project attached, so I can't start a task here. Attach a project to work on code.";
}

