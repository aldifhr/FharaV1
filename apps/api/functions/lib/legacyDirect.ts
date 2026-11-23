/**
 * legacy: direct threads removed 2026-11-12. Old task rows may still carry
 * `mode: "direct"` (and `tasks.direct`); nothing runs them any more. They
 * are never claimed, never count as waiting on the user and are listed as
 * plain, read-only tasks.
 */
export function isLegacyDirect(task: { mode?: string | null }): boolean {
  return task.mode === "direct";
}
