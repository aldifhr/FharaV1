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

/**
 * The one agent-status vocabulary. The sidebar team list, the agent panel and
 * every other place that names what an agent is doing map through
 * `agentStatusView`, so the same agent always shows the same word.
 */
export type AgentStatusKind = "idle" | "queued" | "thinking" | "working" | "testing" | "waiting" | "disabled";

export const AGENT_STATUS_LABEL: Record<AgentStatusKind, string> = {
  idle: "Idle",
  queued: "Queued",
  thinking: "Thinking",
  working: "Working",
  testing: "Testing",
  waiting: "Waiting on you",
  disabled: "Disabled",
};

const KIND_OF_WORD: Record<TeamStatusWord, AgentStatusKind> = {
  needs_you: "waiting",
  waiting_on_you: "waiting",
  reviewing: "working",
  testing: "testing",
  working: "working",
  queued: "queued",
  elsewhere: "working",
  idle: "idle",
};

export type AgentStatusView = {
  kind: AgentStatusKind;
  label: string;
  /** The user is the blocker (shown with a small neutral marker, never a tinted badge). */
  needsYou: boolean;
  /** What the agent is on: the task title, plus the project when it is elsewhere. */
  detail: string | null;
  /** Status word for the avatar dot; undefined when idle or disabled. */
  avatar: TeamStatusWord | undefined;
  /** StatusTag tone (hairline frame, theme tokens). */
  tone: "neutral" | "active" | "warn";
};

/**
 * Status of one agent from the live team status (`api.shell.teamStatus`, or
 * its lease fallback) plus the agent row's `isEnabled` and the chat typing
 * signal. Disabled wins; no entry is idle (or thinking while a chat reply
 * is being drafted).
 */
export function agentStatusView(
  entry: Pick<TeamStatusEntry, "status" | "taskTitle" | "projectName"> | undefined,
  opts: { isEnabled?: boolean | null; drafting?: boolean } = {},
): AgentStatusView {
  const kind: AgentStatusKind =
    opts.isEnabled === false ? "disabled" : entry ? KIND_OF_WORD[entry.status] : opts.drafting ? "thinking" : "idle";
  const where = entry?.status === "elsewhere" && entry.projectName ? `in ${entry.projectName}` : null;
  const detail = kind === "disabled" ? null : [entry?.taskTitle ?? null, where].filter(Boolean).join(" · ") || null;
  const avatar: TeamStatusWord | undefined =
    kind === "disabled" || kind === "idle" ? undefined : kind === "thinking" ? "working" : (entry?.status ?? undefined);
  return {
    kind,
    label: AGENT_STATUS_LABEL[kind],
    needsYou: kind === "waiting",
    detail,
    avatar,
    tone: kind === "waiting" ? "warn" : kind === "working" || kind === "testing" || kind === "thinking" ? "active" : "neutral",
  };
}

/** Label for one entry (same words as `agentStatusView`). */
export function teamStatusLabel(entry: TeamStatusEntry | undefined, drafting = false): string {
  return agentStatusView(entry, { drafting }).label;
}

/** Text tone for the status word: ink when the user is the blocker, muted otherwise. */
export function teamStatusTone(word: TeamStatusWord): string {
  return KIND_OF_WORD[word] === "waiting" ? "text-ink" : "text-ink-3";
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
