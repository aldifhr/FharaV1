/**
 * Pure helpers for the per-task Changes pane (Paradev A2, plan
 * audit/paradev-plan-2026-11-11.md, P-A). The pane components stay thin:
 * patch splitting, plain-text labels and the "open the Changes tab" hand-off
 * live here so they can be unit tested without React.
 */
import type { ChangesetFile, ChangesPr } from "@/api/convex/lib/changeset";

/** The marker line lib/diffPatch.ts appends to a patch cut at its byte budget. */
const TRUNCATION_MARKER = /^\\ Fhara: diff truncated[^\n]*$/m;

export function isPatchTruncated(patch: string): boolean {
  return TRUNCATION_MARKER.test(patch);
}

const SECTION_HEADER = "diff --git ";

/** A file's section header as git writes it with the safe config (a/ b/ prefixes, raw paths). */
function headerFor(file: Pick<ChangesetFile, "path" | "oldPath">): string {
  return `${SECTION_HEADER}a/${file.oldPath ?? file.path} b/${file.path}`;
}

/** Paths a section names in its `---`/`+++`/rename lines (fallback when the header is quoted). */
function sectionPaths(section: string): string[] {
  const out: string[] = [];
  for (const line of section.split("\n")) {
    if (line.startsWith("+++ b/")) out.push(line.slice(6));
    else if (line.startsWith("--- a/")) out.push(line.slice(6));
    else if (line.startsWith("rename to ")) out.push(line.slice(10));
    else if (line.startsWith("copy to ")) out.push(line.slice(8));
  }
  return out;
}

/**
 * One branch patch → its sections keyed by file path. The header is matched
 * against the known file list exactly (a path with spaces cannot be split
 * from the header alone); the `+++`/rename lines are the fallback. Files
 * missing from the map were cut by the byte budget (or are binary-only).
 */
export function splitPatchByFile(patch: string, files: Array<Pick<ChangesetFile, "path" | "oldPath">>): Map<string, string> {
  const byHeader = new Map(files.map((f) => [headerFor(f), f.path]));
  const known = new Set(files.map((f) => f.path));
  const out = new Map<string, string>();
  const body = patch.replace(TRUNCATION_MARKER, "");
  const starts: number[] = [];
  if (body.startsWith(SECTION_HEADER)) starts.push(0);
  for (let i = body.indexOf(`\n${SECTION_HEADER}`); i !== -1; i = body.indexOf(`\n${SECTION_HEADER}`, i + 1)) starts.push(i + 1);
  starts.forEach((start, n) => {
    const section = body.slice(start, starts[n + 1] ?? body.length);
    const header = section.slice(0, section.indexOf("\n") === -1 ? section.length : section.indexOf("\n"));
    const path = byHeader.get(header) ?? sectionPaths(section).find((p) => known.has(p));
    if (path && !out.has(path)) out.set(path, section);
  });
  return out;
}

/** One-letter status for the file list (A, M, D, R, C, or · for an unknown change). */
export function statusLetter(status: ChangesetFile["status"]): string {
  switch (status) {
    case "added":
      return "A";
    case "modified":
      return "M";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    default:
      return "·";
  }
}

/** DiffCard's change type for a changeset status. */
export function diffChangeType(status: ChangesetFile["status"]): "new" | "modified" | "deleted" {
  if (status === "added") return "new";
  if (status === "deleted") return "deleted";
  return "modified";
}

/** "#123 open" for the header. */
export function prLine(pr: Pick<ChangesPr, "number" | "state">): string {
  return `#${pr.number} ${pr.state}`;
}

const REVIEW_TEXT: Record<NonNullable<ChangesPr["reviewState"]>, string | null> = {
  none: null,
  approved: "Approved",
  changes_requested: "Changes requested",
  commented: "Commented",
};

const MERGEABLE_TEXT: Record<NonNullable<ChangesPr["mergeable"]>, string | null> = {
  unknown: null,
  mergeable: "No conflicts",
  conflict: "Has conflicts",
};

/** Review and merge facts as plain words, unknowns left out. */
export function prFactsText(pr: Pick<ChangesPr, "reviewState" | "mergeable">): string[] {
  const out: string[] = [];
  const review = pr.reviewState ? REVIEW_TEXT[pr.reviewState] : null;
  const mergeable = pr.mergeable ? MERGEABLE_TEXT[pr.mergeable] : null;
  if (review) out.push(review);
  if (mergeable) out.push(mergeable);
  return out;
}

export type CheckRow = { name: string; status: "pending" | "passed" | "failed"; word: string; url?: string };

/** ciChecks → rows, failed first, then pending, then passed (stable within each). */
export function checkRows(checks: ChangesPr["ciChecks"]): CheckRow[] {
  const rank = { failed: 0, pending: 1, passed: 2 } as const;
  return checks
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank[a.c.status] - rank[b.c.status] || a.i - b.i)
    .map(({ c }) => ({
      name: c.name,
      status: c.status,
      word: c.status === "failed" ? "Failed" : c.status === "pending" ? "Pending" : "Passed",
      ...(c.url ? { url: c.url } : {}),
    }));
}

/** "2 failed · 1 pending · 5 passed", empty parts left out. */
export function checksSummary(checks: ChangesPr["ciChecks"]): string {
  const count = (s: CheckRow["status"]) => checks.filter((c) => c.status === s).length;
  return [
    [count("failed"), "failed"],
    [count("pending"), "pending"],
    [count("passed"), "passed"],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, w]) => `${n} ${w}`)
    .join(" · ");
}

/** Next/previous file index for Alt+↓/↑, clamped (no wrap). */
export function stepFile(current: number, count: number, delta: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return delta === 1 ? 0 : count - 1;
  return Math.min(count - 1, Math.max(0, current + delta));
}

// ---------------------------------------------------------------------------
// "Open changes" hand-off: a card asks for a task's Changes tab; the thread
// panel (mounted now, or after the task is selected) picks it up.
// ---------------------------------------------------------------------------

export const OPEN_CHANGES_EVENT = "fhara:open-changes";

let pendingOpen: string | null = null;

/** Ask the task thread for `taskId` to show its Changes tab. */
export function requestOpenChanges(taskId: string): void {
  pendingOpen = taskId;
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(OPEN_CHANGES_EVENT, { detail: { taskId } }));
}

/** True once when a request for `taskId` is waiting (a panel that mounted after the request). */
export function consumeOpenChanges(taskId: string | null): boolean {
  if (!taskId || pendingOpen !== taskId) return false;
  pendingOpen = null;
  return true;
}
