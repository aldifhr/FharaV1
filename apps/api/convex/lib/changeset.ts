// Portions adapted from Paradev, formerly Superset (https://github.com/paradevai/paradev, cloned from github.com/superset-sh/superset @ ce98da26),
// apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/utils/getPRFlowState/getPRFlowState.ts
// (getPRFlowState, selectActionButton, selectPRLink, selectStatusBadge) and .../hooks/useChangeset/types.ts (ChangesetFile, pattern).
// MIT License, Copyright (c) 2025-2026 Superset Inc.
// See THIRD_PARTY_NOTICES.md.
//
// Changed by Fhara (Paradev A1, plan audit/paradev-plan-2026-11-11.md, P-A):
// - The flow state is a per-task reducer over Fhara facts (fileChanges,
//   the task branch/worktree, the newest taskPushes row, a running fix)
//   instead of Paradev's branch sync status. States are renamed:
//   no-branch, worktree-gone, proposed, committed, pushed, pr-exists,
//   fix-running, error. There is no "loading": a Convex query result is
//   either undefined (the caller's loading) or a value.
// - The selectors return plain English labels; no Paradev name or styling.
// - ChangesetFile keeps Fhara's two sources (proposed = fileChanges before
//   Accept, branch = main..task branch).
// - The git `-z` parsers and the fileChanges folding are Fhara's own.

/** Where a changed file's facts come from. */
export type ChangesetSource = "proposed" | "branch";

export type ChangesetFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "changed";

/** One changed file of a task, in either source. */
export interface ChangesetFile {
  path: string;
  /** Previous path of a rename or copy. */
  oldPath?: string;
  status: ChangesetFileStatus;
  additions: number;
  deletions: number;
  isBinary?: boolean;
  source: ChangesetSource;
}

/** PR facts copied from the newest taskPushes row. */
export interface ChangesPr {
  number: number;
  url?: string;
  title?: string;
  state: "draft" | "open" | "merged" | "closed";
  ciState?: "pending" | "passed" | "failed";
  ciChecks: Array<{ name: string; status: "pending" | "passed" | "failed"; conclusion?: string; url?: string }>;
  reviewState?: "none" | "approved" | "changes_requested" | "commented";
  mergeable?: "unknown" | "mergeable" | "conflict";
  headSha?: string;
}

/** The newest commit/push of a task, as the flow state needs it. */
export interface ChangesPush {
  status: "ready" | "requested" | "pushing" | "pushed" | "failed";
  error?: string;
  pr: ChangesPr | null;
}

export type ChangesFlowState =
  | { kind: "no-branch" }
  | { kind: "worktree-gone"; push: ChangesPush | null }
  | { kind: "proposed"; fileCount: number }
  | { kind: "committed"; push: ChangesPush }
  | { kind: "pushed"; push: ChangesPush }
  | { kind: "pr-exists"; push: ChangesPush; pr: ChangesPr }
  | { kind: "fix-running"; pr: ChangesPr | null }
  | { kind: "error"; pr: ChangesPr | null; message: string };

export interface GetChangesFlowStateInput {
  /** Proposed (fileChanges) file count before Accept. */
  proposedCount: number;
  branchName?: string;
  worktreePath?: string;
  /** Newest taskPushes row of the task, or null before recordTaskCommit. */
  push: ChangesPush | null;
  /** A fix round is queued or running on this task's branch. */
  isFixRunning: boolean;
  loadError?: string | null;
}

export function getChangesFlowState(input: GetChangesFlowStateInput): ChangesFlowState {
  const { proposedCount, branchName, worktreePath, push, isFixRunning, loadError } = input;
  const pr = push?.pr ?? null;

  if (loadError && !push && proposedCount === 0) {
    return { kind: "error", pr: null, message: loadError };
  }
  // Like Paradev's "busy": an agent at work on the branch wins over every
  // actionable state, and the PR stays visible.
  if (isFixRunning) return { kind: "fix-running", pr };

  if (push) {
    if (pr) return { kind: "pr-exists", push, pr };
    if (push.status === "failed") return { kind: "error", pr: null, message: push.error ?? "Push failed" };
    // Without the worktree the branch diff cannot be read any more.
    if (!worktreePath) return { kind: "worktree-gone", push };
    if (push.status === "pushed") return { kind: "pushed", push };
    return { kind: "committed", push };
  }
  if (proposedCount > 0) return { kind: "proposed", fileCount: proposedCount };
  if (branchName && !worktreePath) return { kind: "worktree-gone", push: null };
  return { kind: "no-branch" };
}

// ---------------------------------------------------------------------------
// Selectors: derive header pieces from the flow state (A2 renders them).
// ---------------------------------------------------------------------------

export type ChangesActionButton =
  | { kind: "hidden" }
  | { kind: "disabled"; reason: "no-branch" | "worktree-gone" }
  | { kind: "open-pr" }
  | { kind: "refresh-pr" }
  | { kind: "retry" };

export function selectActionButton(state: ChangesFlowState): ChangesActionButton {
  switch (state.kind) {
    case "no-branch":
      return { kind: "disabled", reason: "no-branch" };
    case "worktree-gone":
      return { kind: "disabled", reason: "worktree-gone" };
    case "proposed":
    case "fix-running":
      return { kind: "hidden" };
    case "committed":
      // A push already in flight has its approval; no second Open PR.
      return state.push.status === "ready" ? { kind: "open-pr" } : { kind: "hidden" };
    case "pushed":
      return { kind: "open-pr" };
    case "pr-exists":
      return { kind: "refresh-pr" };
    case "error":
      return { kind: "retry" };
  }
}

export type ChangesPrLink =
  | { kind: "none" }
  | { kind: "pr-link"; state: "open" | "draft" | "merged" | "closed"; number: number; url?: string };

export function selectPrLink(state: ChangesFlowState): ChangesPrLink {
  const pr = prFromState(state);
  if (!pr) return { kind: "none" };
  return { kind: "pr-link", state: pr.state, number: pr.number, url: pr.url };
}

export function selectStatusLabel(state: ChangesFlowState): string {
  switch (state.kind) {
    case "no-branch":
      return "No changes yet";
    case "worktree-gone":
      return "Worktree removed";
    case "proposed":
      return `${state.fileCount} proposed file${state.fileCount === 1 ? "" : "s"}`;
    case "committed":
      if (state.push.status === "requested") return "Push requested";
      if (state.push.status === "pushing") return "Pushing";
      return "Committed, not pushed";
    case "pushed":
      return "Pushed";
    case "pr-exists":
      if (state.pr.state === "draft") return "Draft";
      if (state.pr.state === "merged") return "Merged";
      if (state.pr.state === "closed") return "Closed";
      return "Open";
    case "fix-running":
      return "Agent working…";
    case "error":
      return "Failed. Retry";
  }
}

function prFromState(state: ChangesFlowState): ChangesPr | null {
  switch (state.kind) {
    case "pr-exists":
    case "fix-running":
    case "error":
      return state.pr;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// File model builders (Fhara).
// ---------------------------------------------------------------------------

/** + and − line counts of a unified diff, headers excluded. */
export function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

const CHANGE_TYPE_STATUS: Record<string, ChangesetFileStatus> = { new: "added", modified: "modified", deleted: "deleted" };

/**
 * fileChanges rows → one proposed file per path. Several subtasks can write
 * the same path; the newest row wins. Sorted by path.
 */
export function filesFromFileChanges(
  rows: Array<{ filePath: string; changeType: string; diff: string; _creationTime: number }>,
): ChangesetFile[] {
  const newest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const prev = newest.get(row.filePath);
    if (!prev || row._creationTime >= prev._creationTime) newest.set(row.filePath, row);
  }
  return [...newest.values()]
    .sort((a, b) => a.filePath.localeCompare(b.filePath))
    .map((row) => ({
      path: row.filePath,
      status: CHANGE_TYPE_STATUS[row.changeType] ?? "changed",
      ...countDiffLines(row.diff),
      source: "proposed" as const,
    }));
}

function statusFromLetter(letter: string): ChangesetFileStatus {
  switch (letter[0]) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    default:
      return "changed";
  }
}

type LineCounts = { additions: number; deletions: number; isBinary: boolean };

/** `git diff --numstat -z`: `add\tdel\tpath\0`, or `add\tdel\t\0old\0new\0` for a rename. */
function numstatCounts(numstatZ: string): Map<string, LineCounts> {
  const counts = new Map<string, LineCounts>();
  const fields = numstatZ.split("\0");
  for (let i = 0; i < fields.length; i++) {
    if (!fields[i]) continue;
    const [add, del, inlinePath] = fields[i].split("\t");
    let path: string | undefined = inlinePath;
    if (inlinePath === "") {
      path = fields[i + 2];
      i += 2;
    }
    if (path === undefined) continue;
    const isBinary = add === "-" && del === "-";
    counts.set(path, { additions: isBinary ? 0 : Number(add) || 0, deletions: isBinary ? 0 : Number(del) || 0, isBinary });
  }
  return counts;
}

/**
 * `git diff --name-status -z` plus `--numstat -z` → branch files. `-z`
 * keeps paths raw (tabs, newlines, non-ASCII) and gives a rename's two
 * paths their own fields.
 */
export function filesFromGitZ(nameStatusZ: string, numstatZ: string): ChangesetFile[] {
  const counts = numstatCounts(numstatZ);
  const files: ChangesetFile[] = [];
  const fields = nameStatusZ.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const letter = fields[i];
    if (!letter) continue;
    const status = statusFromLetter(letter);
    const twoPaths = status === "renamed" || status === "copied";
    const oldPath = twoPaths ? fields[i + 1] : undefined;
    const path = twoPaths ? fields[i + 2] : fields[i + 1];
    i += twoPaths ? 2 : 1;
    if (path === undefined) continue;
    const c = counts.get(path) ?? { additions: 0, deletions: 0, isBinary: false };
    files.push({
      path,
      ...(oldPath !== undefined ? { oldPath } : {}),
      status,
      additions: c.additions,
      deletions: c.deletions,
      ...(c.isBinary ? { isBinary: true } : {}),
      source: "branch",
    });
  }
  return files;
}
