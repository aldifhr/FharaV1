import { isLegacyDirect } from "./legacyDirect";

/**
 * Whether a task parked in `waiting_input` is actually waiting on the user.
 *
 * Orchestrated tasks enter `waiting_input` only to ask a question, so every
 * one counts. A legacy direct thread (removed 2026-11-12) never does.
 */
export function isAwaitingUserAnswer(task: {
  status: string;
  mode?: string | null;
}): boolean {
  if (task.status !== "waiting_input") return false;
  return !isLegacyDirect(task);
}
