/**
 * Whether a CTO chat reply offers the Create task button.
 *
 * The server stores its own reading of the user's request on the reply
 * (`messages.taskOffer`, set when the intent is "task", e.g. "tolong
 * jalankan tes" → testing with ["npm run test"]). That decides it, whatever
 * the model wrote. Replies from before the field (or a CTO that offers a
 * task on its own) still match the old wording rule.
 */
type TaskOffer = { kind: string; commands?: string[]; usedTaskId?: string; usedAt?: number; brief?: string };

/** The offer already became a task (messages.taskOffer.usedTaskId). */
export function isOfferUsed(offer: TaskOffer | null | undefined): offer is TaskOffer & { usedTaskId: string } {
  return Boolean(offer?.usedTaskId);
}

export function offersCreateTask(message: { content?: string | null; taskOffer?: TaskOffer | null }): boolean {
  // A used offer shows "Task created", never the button again.
  if (isOfferUsed(message.taskOffer)) return false;
  if (message.taskOffer) return true;
  // Legacy offers told the user to *click/press* the button. A descriptive
  // mention ("gunakan tombol Create task di bawah ini") is not an offer.
  return /\b(?:klik|tekan|press|click)\b[^.]{0,40}\bcreate\s+task\b/i.test(message.content ?? "");
}
