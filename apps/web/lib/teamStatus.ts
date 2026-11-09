/** Live team status words (from `api.shell.teamStatus`) → label + tone. */
export type TeamStatusWord =
  | "needs_you"
  | "waiting_on_you"
  | "reviewing"
  | "testing"
  | "working"
  | "queued"
  | "elsewhere"
  | "idle";

export type TeamStatusEntry = {
  status: TeamStatusWord;
  taskId: string | null;
  taskTitle: string | null;
  projectName: string | null;
  subtaskKey: string | null;
};

export const TEAM_STATUS_LABEL: Record<TeamStatusWord, string> = {
  needs_you: "needs you",
  waiting_on_you: "waiting on you",
  reviewing: "reviewing",
  testing: "testing",
  working: "working",
  queued: "queued",
  elsewhere: "busy",
  idle: "idle",
};

/** Text tone: orange when the user is the blocker, muted otherwise. */
export function teamStatusTone(word: TeamStatusWord): string {
  return word === "needs_you" || word === "waiting_on_you" ? "text-warn" : "text-ink-3";
}

/** Presence dot colour on the avatar. */
export const TEAM_STATUS_DOT: Record<TeamStatusWord, string> = {
  needs_you: "bg-orange-500",
  waiting_on_you: "bg-orange-500",
  reviewing: "bg-blue-500",
  testing: "bg-blue-500",
  working: "bg-emerald-500",
  queued: "bg-gray-400",
  elsewhere: "bg-blue-500",
  idle: "bg-gray-300 dark:bg-gray-600",
};

/** Label for one entry; "elsewhere" names the other project when visible. */
export function teamStatusLabel(entry: TeamStatusEntry | undefined, drafting = false): string {
  if (!entry) return drafting ? "drafting" : "idle";
  if (entry.status === "elsewhere") return entry.projectName ?? "busy";
  return TEAM_STATUS_LABEL[entry.status];
}

/** Sort weight: who needs the user first, idle last. */
export const TEAM_STATUS_RANK: Record<TeamStatusWord, number> = {
  needs_you: 0,
  waiting_on_you: 1,
  reviewing: 2,
  testing: 2,
  working: 3,
  queued: 4,
  elsewhere: 5,
  idle: 6,
};

/** Team status per agent id. */
export type StatusMap = Record<string, TeamStatusEntry>;

/** One row of `api.executionView.activeByAgent` (the execution lease view). */
export type LeaseEntry = { taskId: string; projectId: string; taskTitle: string; subtaskKey?: string; status: string };

/**
 * Team status derived from execution leases — the fallback when the live
 * read model (`api.shell.teamStatus`) is unavailable. `otherProjects`
 * decides whether leases in another project are dropped or shown as
 * "elsewhere"; `checkFirst` which subtask-key word wins when both match.
 */
export function statusFromLeases(
  active: Record<string, LeaseEntry> | undefined,
  opts: { projectId?: string; otherProjects: "skip" | "elsewhere"; checkFirst: "qa" | "review" },
): StatusMap {
  const map: StatusMap = {};
  for (const [agentId, a] of Object.entries(active ?? {})) {
    const elsewhere = opts.otherProjects === "skip" ? a.projectId !== opts.projectId : Boolean(opts.projectId) && a.projectId !== opts.projectId;
    if (elsewhere && opts.otherProjects === "skip") continue;
    const qa = a.subtaskKey?.includes("qa");
    const review = a.subtaskKey?.includes("review");
    const word: TeamStatusWord = elsewhere
      ? "elsewhere"
      : a.status === "waiting_approval"
        ? "waiting_on_you"
        : a.status === "queued"
          ? "queued"
          : opts.checkFirst === "qa"
            ? (qa ? "testing" : review ? "reviewing" : "working")
            : (review ? "reviewing" : qa ? "testing" : "working");
    map[agentId] = { status: word, taskId: a.taskId, taskTitle: a.taskTitle, projectName: null, subtaskKey: a.subtaskKey ?? null };
  }
  return map;
}
