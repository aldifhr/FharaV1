/**
 * R2: turn a code_change answer that uses SEARCH/REPLACE blocks (Format C)
 * into the same `{ filePath, newContent }` draft the full-file formats give,
 * so staging, approval, the broker and `oldContentHash` stay unchanged.
 *
 * Blocks apply to in-memory copies of the current content (a staged edit of
 * an earlier subtask, else disk). Full-file FILE blocks in the same answer
 * (new files) are kept as they are. Failures come back as data so the
 * executor can reflect them to the model (Aider style) and, after that, fall
 * back to asking for the full file.
 */
import type { DraftFile } from "@/utils/json";
import { parseFileBlocks } from "@/utils/draftLenient";
import {
  EditBlockParseError,
  applyEditBlocks,
  findOriginalUpdateBlocks,
  hasEditBlocks,
  type EditFailure,
} from "@/utils/editBlocks";

/** Most reflection rounds after a SEARCH miss before the full-file fallback. */
export const MAX_EDIT_REFLECTIONS = 2;

export type EditWorkingSet = Map<string, { content: string; isNew: boolean }>;

export interface EditAnswer {
  /** The answer carried SEARCH/REPLACE blocks. */
  used: boolean;
  /** Applied files (edit results + plain full-file blocks), in order. */
  files: DraftFile[];
  failures: EditFailure[];
  /** Blocks applied in this round. */
  appliedCount: number;
  /** In-memory state after this round (seed for the next reflection round). */
  working: EditWorkingSet;
}

const MARKER = /^(<{5,9} SEARCH>?|={5,9}|>{5,9} REPLACE)\s*$/m;

/**
 * Resolve one answer. `start` carries the files a previous round already
 * edited (the reflection reply only resends the failed blocks).
 */
export async function resolveEditAnswer(
  answer: string,
  readCurrent: (filePath: string) => Promise<string | null>,
  options: { validPaths?: readonly string[]; start?: EditWorkingSet } = {}
): Promise<EditAnswer> {
  const working: EditWorkingSet = new Map(options.start ?? []);
  if (!hasEditBlocks(answer)) {
    return { used: false, files: [], failures: [], appliedCount: 0, working };
  }
  let blocks;
  try {
    blocks = findOriginalUpdateBlocks(answer, undefined, options.validPaths ?? null);
  } catch (error) {
    if (!(error instanceof EditBlockParseError)) throw error;
    const detail = error.message.split("\n").slice(-12).join("\n");
    return {
      used: true,
      files: [],
      failures: [{ block: { filePath: "", search: "", replace: "" }, kind: "malformed", detail }],
      appliedCount: 0,
      working,
    };
  }
  const applied = await applyEditBlocks(blocks, readCurrent, { start: working, acceptAlreadyApplied: options.start !== undefined });
  const files: DraftFile[] = applied.files.map((file) => ({ filePath: file.filePath, newContent: file.newContent }));
  const nextWorking: EditWorkingSet = new Map(applied.files.map((file) => [file.filePath, { content: file.newContent, isNew: file.isNew }]));
  // Full-file blocks for files the edit blocks do not touch (a new file in
  // Format B next to edits). A "file block" that wraps edit markers is an
  // edit block seen through a heading, never a file body.
  const fullFiles = parseFileBlocks(answer)?.files ?? [];
  for (const file of fullFiles) {
    if (MARKER.test(file.newContent)) continue;
    if (nextWorking.has(file.filePath)) continue;
    files.push(file);
  }
  return { used: true, files, failures: applied.failures, appliedCount: applied.applied.length, working: nextWorking };
}

/** Unique file paths of failed blocks (malformed ones have none). */
export function failedEditPaths(failures: readonly EditFailure[]): string[] {
  return Array.from(new Set(failures.map((failure) => failure.block.filePath).filter(Boolean)));
}
