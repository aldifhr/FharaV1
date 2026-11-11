import { compareThreads, threadHref, type ThreadItem } from "./threadTree";

/** Recent threads in the command menu, newest first. */
export const RECENT_THREADS = 6;

export type RecentThread = { id: string; title: string; projectName: string; href: string; needsYou: boolean };

/**
 * The newest top-level threads across projects for ⌘K: fix tasks that sit
 * under an owner in the list are left out, untitled rows get a fallback, and
 * each row carries the href the sidebar would open.
 */
export function recentThreads(rows: readonly ThreadItem[] | undefined, limit = RECENT_THREADS): RecentThread[] {
  if (!rows?.length) return [];
  const ownerIds = new Set(rows.map((r) => r.taskId).filter((id): id is string => !!id));
  return [...rows]
    .filter((r) => !(r.ownerTaskId && r.ownerTaskId !== r.taskId && ownerIds.has(r.ownerTaskId)))
    .sort(compareThreads)
    .slice(0, Math.max(0, limit))
    .map((r) => ({
      id: r.id,
      title: r.title.trim() || "Untitled thread",
      projectName: r.projectName,
      href: threadHref(r),
      needsYou: r.needsYou,
    }));
}

/** Where ⌘K "New task" goes: the project's Tasks tab with the create field focused. */
export const newTaskHref = (projectId: string) => `/chats/${projectId}?tab=tasks&compose=1`;
