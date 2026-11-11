/**
 * Threadbear T3: the one-line wording of direct-thread events that are not
 * messages, tools or cards (system notes, goal changes, closes). Plain
 * English, no @names. Events with nothing to say (session.restore, the
 * thread.created marker) return null and make no row.
 */

export const recordOf = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** True when the text has something besides whitespace. */
export const plainText = (text: string): boolean => text.trim().length > 0;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function goalUpdatedText(p: Record<string, unknown>): string {
  const by = p.by === "agent" ? "The agent" : "You";
  const rounds = typeof p.round === "number" && typeof p.maxRounds === "number" ? ` (round ${p.round}/${p.maxRounds})` : "";
  switch (p.action) {
    case "set":
      return str(p.objective) ? `Goal set: ${str(p.objective)}` : `Goal resumed${rounds}`;
    case "resume":
      return `Goal resumed${rounds}`;
    case "pause":
    case "paused":
      return `${by} paused the goal${rounds}`;
    case "clear":
      return "Goal cleared";
    case "wrapped-up":
      return "Goal wrapped up";
    case "complete":
      return `Goal complete${rounds}`;
    case "blocked": {
      const reason = recordOf(p.blockedReason);
      return `Goal blocked${str(reason.message) ? `: ${str(reason.message)}` : ""}${rounds}`;
    }
    default:
      return `Goal updated${rounds}`;
  }
}

/** A note row for `type`, or null when the event shows nothing. */
export function noteFromEvent(type: string, p: Record<string, unknown>): { text: string; tone?: "neutral" | "danger" } | null {
  switch (type) {
    case "system.note":
      return plainText(str(p.text)) ? { text: str(p.text) } : null;
    case "goal.updated":
      return { text: goalUpdatedText(p), ...(p.action === "blocked" ? { tone: "danger" as const } : {}) };
    case "goal.prompt":
      return { text: p.kind === "wrapup" ? "Goal: wrapping up" : `Goal round ${typeof p.round === "number" ? p.round : ""}`.trim() };
    case "task.cancelled":
      return { text: "Thread closed" };
    default:
      return null;
  }
}

/** "1m 12s", "8s", "2h 3m". */
export function durationText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The turn footer line: "Worked for 1m 12s", "Stopped after 8s", "Failed after 3s: …". */
export function turnFooterText(outcome: string, durationMs: number, error?: string): string {
  const d = durationText(durationMs);
  switch (outcome) {
    case "interrupted":
      return `Stopped after ${d}`;
    case "timed_out":
      return `Timed out after ${d}${error ? `: ${error}` : ""}`;
    case "failed":
      return `Failed after ${d}${error ? `: ${error}` : ""}`;
    default:
      return `Worked for ${d}`;
  }
}
