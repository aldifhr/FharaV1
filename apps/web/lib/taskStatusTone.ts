import type { StatusTone } from "@/components/ui/status-tag";

/** StatusTag tone per task status (dashboard restyle F5): frame + text, no tint. */
export const TASK_STATUS_TONE: Record<string, StatusTone> = {
  queued: "neutral",
  running: "active",
  needs_approval: "warn",
  waiting_input: "warn",
  paused: "neutral",
  done: "ok",
  failed: "danger",
  rejected: "danger",
  cancelled: "neutral",
};

export function taskStatusTone(status: string | undefined, needsYou = false): StatusTone {
  if (needsYou && status !== "done" && status !== "failed" && status !== "rejected" && status !== "cancelled") return "warn";
  return TASK_STATUS_TONE[status ?? ""] ?? "neutral";
}
