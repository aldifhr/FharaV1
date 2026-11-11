/**
 * Pure helpers for inline line comments on the Changes pane (Paradev A4,
 * plan audit/paradev-plan-2026-11-11.md, P-A). Idea from Paradev's
 * useDiffCommentComposer; the code is Fhara's. Kept free of React so the
 * selection, composer keys and draft bar copy are unit tested directly.
 */

export type DiffRow =
  | { type: "hunk"; oldStart: number; newStart: number }
  | { type: "add" | "del" | "ctx"; oldNo: number | null; newNo: number | null; text: string };

/** A unified diff → display rows (hunk separators plus numbered lines). */
export function parseDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of diff.split("\n")) {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      rows.push({ type: "hunk", oldStart: oldNo, newStart: newNo });
      continue;
    }
    if (raw.startsWith("diff ") || raw.startsWith("index ") || raw.startsWith("---") || raw.startsWith("+++")) continue;
    // "\ No newline at end of file" is metadata, not a line.
    if (raw.startsWith("\\")) continue;
    if (raw.startsWith("+")) {
      rows.push({ type: "add", oldNo: null, newNo: newNo++, text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      rows.push({ type: "del", oldNo: oldNo++, newNo: null, text: raw.slice(1) });
    } else {
      rows.push({ type: "ctx", oldNo: oldNo++, newNo: newNo++, text: raw.replace(/^ /, "") });
    }
  }
  // The trailing newline of the diff yields one empty "context" row.
  const last = rows[rows.length - 1];
  if (last && last.type === "ctx" && last.text === "") rows.pop();
  return rows;
}

export type CommentSide = "additions" | "deletions" | "mixed";

/** The side and line a row comments on: removed lines on the old side, everything else on the new. */
export function rowLine(row: DiffRow): { side: "additions" | "deletions"; line: number } | null {
  if (row.type === "hunk") return null;
  if (row.type === "del") return row.oldNo == null ? null : { side: "deletions", line: row.oldNo };
  return row.newNo == null ? null : { side: "additions", line: row.newNo };
}

/** A gutter selection in one file, kept as row indices so a shift-click range is exact. */
export interface LineSelection {
  path: string;
  anchor: number;
  focus: number;
}

/**
 * Click starts a one-line selection; shift-click extends from the anchor in
 * the same file (a shift-click in another file starts over there).
 */
export function selectRow(prev: LineSelection | null, path: string, index: number, shift: boolean): LineSelection {
  if (shift && prev && prev.path === path) return { path, anchor: prev.anchor, focus: index };
  return { path, anchor: index, focus: index };
}

export function selectionBounds(sel: Pick<LineSelection, "anchor" | "focus">): [number, number] {
  return sel.anchor <= sel.focus ? [sel.anchor, sel.focus] : [sel.focus, sel.anchor];
}

/** The comment range a selection covers, as the backend stores it; null when it covers no line. */
export function selectionRange(
  rows: DiffRow[],
  sel: LineSelection
): { side: CommentSide; startLine: number; endLine: number; endIndex: number } | null {
  const [from, to] = selectionBounds(sel);
  const lines: Array<{ side: "additions" | "deletions"; line: number; index: number }> = [];
  for (let i = from; i <= to && i < rows.length; i++) {
    const at = rowLine(rows[i]);
    if (at) lines.push({ ...at, index: i });
  }
  if (lines.length === 0) return null;
  const sides = new Set(lines.map((l) => l.side));
  const side: CommentSide = sides.size > 1 ? "mixed" : lines[0].side;
  // A mixed range is numbered on the new side where it has new lines.
  const numbered = side === "mixed" ? lines.filter((l) => l.side === "additions") : lines;
  const nums = numbered.map((l) => l.line);
  return { side, startLine: Math.min(...nums), endLine: Math.max(...nums), endIndex: lines[lines.length - 1].index };
}

/** The row a stored comment is shown under: the last row of its range on its side. */
export function annotationRow(rows: DiffRow[], comment: { side: CommentSide; endLine: number }): number {
  const sides: Array<"additions" | "deletions"> = comment.side === "deletions" ? ["deletions"] : ["additions", "deletions"];
  for (const side of sides) {
    for (let i = rows.length - 1; i >= 0; i--) {
      const at = rowLine(rows[i]);
      if (at && at.side === side && at.line === comment.endLine) return i;
    }
  }
  // The line is no longer in the diff (outdated): show it at the end of the file.
  return rows.length - 1;
}

export function rangeLabel(c: { startLine: number; endLine: number; side?: CommentSide }): string {
  const lines = c.startLine === c.endLine ? `L${c.startLine}` : `L${c.startLine}-L${c.endLine}`;
  return c.side === "deletions" ? `${lines} (old)` : lines;
}

type KeyLike = { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey?: boolean; altKey?: boolean; isComposing?: boolean };

/**
 * The composer's keys: Mod+Enter adds the draft when there is text, Esc
 * closes only an empty composer (typed text is never thrown away by a
 * key). Nothing fires while an IME is composing.
 */
export function composerKeyAction(event: KeyLike, body: string): "submit" | "close" | null {
  if (event.isComposing) return null;
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
    return body.trim() ? "submit" : null;
  }
  if (event.key === "Escape" && !body.trim()) return "close";
  return null;
}

export type SendRefusal = "no_drafts" | "fix_running" | "worktree_gone" | "task_running" | "thread_closed";

/** Plain-English text for a refused review round. */
export function refusalText(reason: SendRefusal): string {
  switch (reason) {
    case "no_drafts":
      return "There are no draft comments to send.";
    case "fix_running":
      return "A fix is already running on this branch. Send these comments once it finishes.";
    case "worktree_gone":
      return "The task's worktree was removed, so a fix round can't run on its branch.";
    case "task_running":
      return "The task is still running. Send these comments once it finishes.";
    case "thread_closed":
      return "This thread is closed, so it can't take a new round.";
    default:
      return "The comments couldn't be sent.";
  }
}

export function draftCountText(count: number): string {
  return count === 0 ? "No draft comments" : `${count} draft ${count === 1 ? "comment" : "comments"}`;
}

export function sendLabel(count: number): string {
  return count === 1 ? "Send 1 comment" : `Send ${count} comments`;
}

export function sentText(round: number): string {
  return `Sent in round ${round}`;
}

/** The status line under one comment: plain text, never a badge. */
export function commentStatusText(c: { status: string; round?: number; outdated?: boolean }): string {
  const parts = [c.status === "sent" && c.round ? sentText(c.round) : "Draft"];
  if (c.outdated) parts.push("Outdated: the branch moved since this comment");
  return parts.join(" · ");
}
