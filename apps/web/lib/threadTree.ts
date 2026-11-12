/**
 * Pure thread helpers: the `threads.list` row shape the command menu's recent
 * threads read (lib/commandMenu.ts), their order, where a thread opens, and
 * what a thread deep link names. No React, no Convex, so it is unit tested
 * in tests/unit/threadTree.test.mjs.
 *
 * (The sidebar Threads section that grouped, filtered and keyboard-walked
 * these rows was removed; threads open from the board, Needs you, Inbox,
 * ⌘K and deep links.)
 */

export type ThreadKind = "task" | "conversation";

/** One `threads.list` row plus the project it came from. */
export type ThreadItem = {
  id: string;
  kind: ThreadKind;
  taskId: string | null;
  conversationId: string | null;
  ownerTaskId: string | null;
  title: string;
  status: string;
  needsYou: boolean;
  unread: boolean;
  branchName: string | null;
  lastActivityAt: number;
  projectId: string;
  projectName: string;
};

const activity = (row: { lastActivityAt: number }) =>
  Number.isFinite(row.lastActivityAt) && row.lastActivityAt > 0 ? row.lastActivityAt : null;

/** Newest first; ties by title then id; rows without a timestamp last. */
export function compareThreads(a: ThreadItem, b: ThreadItem): number {
  const ta = activity(a);
  const tb = activity(b);
  if (ta === null && tb !== null) return 1;
  if (tb === null && ta !== null) return -1;
  if (ta !== null && tb !== null && ta !== tb) return tb - ta;
  const byTitle = a.title.localeCompare(b.title);
  if (byTitle !== 0) return byTitle;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The project workspace page (`/project/:projectId`) every thread opens in. */
export function projectHref(projectId: string): string {
  return `/project/${projectId}`;
}

/**
 * Where a row opens. Threads carry their id in the path
 * (`/project/:projectId/:threadId`) so the link is shareable and a reload
 * lands on the same thread: a task opens its thread, a project conversation
 * shows that conversation (see `threadLinkView`).
 */
export function threadHref(row: Pick<ThreadItem, "projectId" | "taskId" | "conversationId">): string {
  const id = row.taskId ?? row.conversationId;
  return id ? `/project/${row.projectId}/${id}` : projectHref(row.projectId);
}

/** `threads.resolveLink`: what a deep link's id names (`projectId` is null for another project's row). */
export type ThreadLink = {
  kind: "task" | "conversation";
  projectId: string | null;
  personal: boolean;
  taskChat: boolean;
  status: string | null;
} | null;

export type ThreadLinkView = "loading" | "task" | "conversation" | "not_found";

/**
 * The main view for `/project/:projectId/:threadId`. A task of this project
 * opens its thread; a project conversation of this project shows that
 * conversation. Anything else (an unknown id, another project's row, a
 * personal chat, a task's own chat) is "Thread not found".
 */
export function threadLinkView(projectId: string, link: ThreadLink | undefined): ThreadLinkView {
  if (link === undefined) return "loading";
  if (!link || link.projectId !== projectId) return "not_found";
  if (link.kind === "task") return "task";
  return link.personal || link.taskChat ? "not_found" : "conversation";
}
