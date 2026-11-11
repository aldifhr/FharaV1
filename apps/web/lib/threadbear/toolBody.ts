/**
 * Threadbear T3: what a tool row and a diff row show before they are opened.
 * Pure. The full output of a big result lives in `eventBodies` and is read
 * only when the row opens (`directThreads.body`).
 */
import type { Hunk, ToolRow } from "./types";

/** Lines of a diff shown before "Show N more". */
export const DIFF_PREVIEW_LINES = 12;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The tool's one-line subject: the command, the path, the query, else the title. */
export function toolSubject(row: Pick<ToolRow, "title" | "input" | "toolKind">): string {
  const i = row.input;
  const command = Array.isArray(i.argv) ? (i.argv as unknown[]).map(String).join(" ") : str(i.command) || str(i.cmd);
  const subject = command || str(i.path) || str(i.filePath) || str(i.file_path) || str(i.pattern) || str(i.query) || str(i.url);
  return (subject || row.title).replace(/\s+/g, " ").trim();
}

/** "Running", "Done", "Failed": the status word of a tool row. */
export function toolStatus(row: Pick<ToolRow, "result">, turnOpen: boolean): "running" | "done" | "failed" | "interrupted" {
  if (row.result) return row.result.ok ? "done" : "failed";
  return turnOpen ? "running" : "interrupted";
}

/** What a tool row that never got a result says about it: a status word and a line. */
export type ToolInterruption = { word: string; text: string };

export const STOPPED_TOOL_TEXT = "Stopped before the tool finished.";
export const INTERRUPTED_TOOL_TEXT = "Interrupted before the tool finished.";
export const INCOMPLETE_TOOL_TEXT = "The agent didn't finish writing this tool call.";

/**
 * Interruption wording for a tool row with no result once its turn is over.
 * The user pressed Stop: "Stopped". The call came with no input and no output
 * (the agent stalled while still writing it): "Incomplete". Otherwise the tool
 * started and the turn ended under it (a crash, a timeout, a failed turn):
 * "Interrupted". Null while the tool runs or once it has a result.
 */
export function toolInterruption(
  row: Pick<ToolRow, "result" | "input" | "liveOutput">,
  turnOpen: boolean,
  turnOutcome?: string,
): ToolInterruption | null {
  if (row.result || turnOpen) return null;
  if (turnOutcome === "interrupted") return { word: "Stopped", text: STOPPED_TOOL_TEXT };
  if (!Object.keys(row.input).length && !row.liveOutput) return { word: "Incomplete", text: INCOMPLETE_TOOL_TEXT };
  return { word: "Interrupted", text: INTERRUPTED_TOOL_TEXT };
}

/** The input shown when a tool row is opened (pretty JSON, long strings kept). */
export function toolInputText(input: Record<string, unknown>): string {
  if (!Object.keys(input).length) return "";
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return "";
  }
}

/** "4.2 KB" for a body size. */
export function bytesText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type DiffLine = { tag: " " | "+" | "-" | "@"; text: string };

/** Hunks as display lines, a "@@" header before each. */
export function diffLines(hunks: readonly Hunk[]): DiffLine[] {
  const out: DiffLine[] = [];
  for (const h of hunks) {
    out.push({ tag: "@", text: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@` });
    for (const line of h.lines) {
      const tag = line[0] === "+" || line[0] === "-" ? line[0] : " ";
      out.push({ tag, text: line.slice(1) });
    }
  }
  return out;
}

/** "+12 −3" for a diff row header. */
export function diffStat(hunks: readonly Hunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l[0] === "+") added++;
      else if (l[0] === "-") removed++;
    }
  }
  return { added, removed };
}
