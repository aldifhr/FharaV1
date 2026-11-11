import { isClosedStatus } from "@/lib/taskStatus";
import type { PrLane } from "@/api/convex/lib/prFeedback";

// Agile phases: derived from subtask kind + task status, never from a stale
// stored phase. Order matches the sprint flow.
export const PHASES = [
  { key: "planning", label: "Planning" },
  { key: "implementation", label: "Implementation" },
  { key: "review", label: "Review" },
  { key: "verification", label: "Verification" },
  { key: "done", label: "Closed" },
] as const;

export function kindToPhase(kind: string): string {
  if (kind === "review") return "review";
  if (kind === "qa") return "verification";
  if (kind === "analysis" || kind === "research") return "planning";
  return "implementation";
}

export function phaseOf(t: any, subtasks: any[]): string {
  // Done, failed and rejected tasks will not progress on their own: they
  // belong in the closed lane (the status tag says which), not "Implementation".
  if (isClosedStatus(t.status)) return "done";
  // A subtask is actively running right now → its phase is current.
  const running = subtasks.find((s) => s.status === "running");
  if (running) return kindToPhase(running.kind);
  // Nothing running: the earliest pending kind marks the phase.
  const earliest = subtasks.find((s) => ["pending", "ready", "waiting_approval", "blocked"].includes(s.status));
  if (earliest) return kindToPhase(earliest.kind);
  const done = subtasks.filter((s) => s.status === "completed").length;
  if (done > 0) return "implementation";
  return "planning";
}

export type PrLaneRow = {
  taskId: string;
  lane: PrLane;
  prNumber: number;
  prUrl: string | null;
  ciState: string | null;
  failedChecks: string[];
  reviewState: string | null;
  mergeable: string | null;
  fixing: boolean;
  fixAttempts: number;
  maxAttempts: number;
};

/** One quiet line under the title: PR number, what blocks it, who acts next. */
export function prSummary(row: PrLaneRow): string {
  const parts = [`PR #${row.prNumber}`];
  if (row.ciState === "failed") parts.push(row.failedChecks.length ? `CI failed: ${row.failedChecks.slice(0, 2).join(", ")}` : "CI failed");
  else if (row.ciState === "pending") parts.push("CI running");
  else if (row.ciState === "passed") parts.push("CI passed");
  if (row.reviewState === "changes_requested") parts.push("changes requested");
  else if (row.reviewState === "approved") parts.push("approved");
  if (row.mergeable === "conflict") parts.push("merge conflict");
  if (row.fixing) parts.push(`Fhara is fixing (${row.fixAttempts}/${row.maxAttempts})`);
  else if (row.fixAttempts > 0 && row.lane !== "merged") parts.push(`${row.fixAttempts}/${row.maxAttempts} fixes used`);
  return parts.join(" · ");
}
