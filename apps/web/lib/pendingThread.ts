/**
 * One-shot hand-off for thread links.
 *
 * Thread URLs are project-scoped (`/project/:projectId`) by request, so the
 * thread id cannot ride in the address. A link that should open a specific
 * thread records it here and then navigates; the workspace shell takes it
 * once, when its project mounts. A reload lands on the project with no
 * thread open, which is the trade the shorter URL makes.
 */
let pending: { projectId: string; taskId: string } | null = null;

/** Remember the thread a `/project/:projectId` link should open. */
export function requestThread(projectId: string, taskId: string): void {
  pending = { projectId, taskId };
}

/** Take the request for this project, if any. One shot: consuming clears it. */
export function takeRequestedThread(projectId: string): string | null {
  if (!pending || pending.projectId !== projectId) return null;
  const { taskId } = pending;
  pending = null;
  return taskId;
}
