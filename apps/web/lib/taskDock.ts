/**
 * The task list docked above the project composer: this chat's open tasks,
 * oldest first, each with a short ref. Pure, so tests/unit/taskDock.test.mjs
 * can run it under node:test.
 */
import { isClosedStatus } from "./taskStatus";

export type DockTaskRow = {
  _id: string;
  _creationTime: number;
  title: string;
  status: string;
  conversationId?: string | null;
};

/** Short, stable ref for a task: the id's last four characters ("#k3x9"). */
export function taskRef(taskId: string): string {
  return `#${String(taskId).slice(-4)}`;
}

/** Open tasks of this conversation (or of the project when no conversation is known), oldest first. */
export function dockTasks<T extends DockTaskRow>(tasks: readonly T[] | undefined, conversationId: string | null): T[] {
  return (tasks ?? [])
    .filter((t) => !isClosedStatus(t.status))
    .filter((t) => !conversationId || !t.conversationId || String(t.conversationId) === conversationId)
    .sort((a, b) => a._creationTime - b._creationTime);
}
