/** Per-conversation last-read timestamp, kept on this device. */
const key = (conversationKey: string) => `fhara-chat-lastseen-${conversationKey}`;

export function readLastRead(conversationKey: string): number | null {
  try {
    const value = Number(localStorage.getItem(key(conversationKey)));
    return value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writeLastRead(conversationKey: string, at: number): void {
  try {
    localStorage.setItem(key(conversationKey), String(at));
  } catch {
    /* storage denied (private window) — keep it in memory only */
  }
}
