/**
 * Whether a CTO chat reply offers the Create task button.
 *
 * The server stores its own reading of the user's request on the reply
 * (`messages.taskOffer`, set when the intent is "task", e.g. "tolong
 * jalankan tes" → testing with ["npm run test"]). That decides it, whatever
 * the model wrote. Replies from before the field (or a CTO that offers a
 * task on its own) still match the old wording rule.
 */
type TaskOffer = { kind: string; commands?: string[]; usedTaskId?: string; usedAt?: number };

/** The offer already became a task (messages.taskOffer.usedTaskId). */
export function isOfferUsed(offer: TaskOffer | null | undefined): offer is TaskOffer & { usedTaskId: string } {
  return Boolean(offer?.usedTaskId);
}

export function offersCreateTask(message: { content?: string | null; taskOffer?: TaskOffer | null }): boolean {
  // A used offer shows "Task created", never the button again.
  if (isOfferUsed(message.taskOffer)) return false;
  if (message.taskOffer) return true;
  return /\b(create|bikin|buat)\s+task\b/i.test(message.content ?? "");
}
