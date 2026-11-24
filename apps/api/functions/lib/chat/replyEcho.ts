/**
 * Teammates asked about the same command tend to answer with the same
 * "task already created / no duplicate" sentence. Keep one such reply per
 * turn; the task card already carries the state for everyone.
 */

export function replyEchoKey(content: string | undefined): string | null {
  const text = (content ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return null;
  const taskCreated =
    /(?:task|tugas)[^.!?]{0,120}(?:sudah|telah)[^.!?]{0,40}dibuat/.test(text) ||
    /sudah[^.!?]{0,40}dibuat[^.!?]{0,80}(?:task|tugas)/.test(text) ||
    /tidak ada (?:task|tugas) duplikat/.test(text) ||
    /no duplicate (?:task|was|created)/.test(text);
  return taskCreated ? "task-created" : null;
}
