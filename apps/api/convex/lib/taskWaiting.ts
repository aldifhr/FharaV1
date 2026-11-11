/**
 * Whether a task parked in `waiting_input` is actually waiting on the user.
 *
 * Orchestrated tasks enter `waiting_input` only to ask a question, so every
 * one counts. Direct threads (`mode: "direct"`) also park there when they are
 * simply idle between turns (directThreads.create/interrupt/release); an idle
 * thread with no pending question is not the user's move. Its approval cards,
 * if any, are counted through the approvals source, not here.
 */
export function isAwaitingUserAnswer(task: {
  status: string;
  mode?: "orchestrated" | "direct" | null;
  pendingQuestion?: string | null;
}): boolean {
  if (task.status !== "waiting_input") return false;
  if (task.mode === "direct") return Boolean(task.pendingQuestion?.trim());
  return true;
}
