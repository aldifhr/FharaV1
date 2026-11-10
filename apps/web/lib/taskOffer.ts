/**
 * Whether a CTO chat reply offers the Create task button.
 *
 * The server stores its own reading of the user's request on the reply
 * (`messages.taskOffer`, set when the intent is "task", e.g. "tolong
 * jalankan tes" → testing with ["npm run test"]). That decides it, whatever
 * the model wrote. Replies from before the field (or a CTO that offers a
 * task on its own) still match the old wording rule.
 */
export function offersCreateTask(message: { content?: string | null; taskOffer?: { kind: string; commands?: string[] } | null }): boolean {
  if (message.taskOffer) return true;
  return /\b(create|bikin|buat)\s+task\b/i.test(message.content ?? "");
}
