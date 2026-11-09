import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildChildEnv } from "@/api/convex/lib/childEnv";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { resolveSandboxPathAsync } from "./sandbox";

const execFileAsync = promisify(execFile);

export interface FileDiff {
  filePath: string;
  changeType: "new" | "modified" | "deleted";
  oldContent?: string;
  newContent?: string;
  oldContentHash?: string;
  newContentHash?: string;
  diff: string;
}

export class StaleFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleFileError";
  }
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function snapshotIdForChanges(changes: FileDiff[]): string {
  const lines = changes
    .map((change) => `${change.filePath}:${change.oldContentHash ?? ""}->${change.newContentHash ?? ""}`)
    .sort();
  return hashContent(lines.join("\n"));
}

export async function computeDiff(
  workspaceRoot: string,
  filePath: string,
  newContent: string
): Promise<FileDiff> {
  const resolved = await resolveSandboxPathAsync(workspaceRoot, filePath);
  let oldContent: string | undefined;
  try {
    oldContent = await fs.readFile(resolved, "utf-8");
  } catch (error) {
    if (isMissing(error)) {
      oldContent = undefined;
    } else {
      throw error;
    }
  }
  return diffFromContents(filePath, oldContent, newContent);
}

/**
 * A diff from explicit before/after contents. `oldContent === undefined`
 * means the file did not exist before (a "new" file).
 */
export function diffFromContents(
  filePath: string,
  oldContent: string | undefined,
  newContent: string
): FileDiff {
  return {
    filePath,
    changeType: oldContent === undefined ? "new" : "modified",
    oldContent,
    newContent,
    oldContentHash: hashContent(oldContent ?? ""),
    newContentHash: hashContent(newContent),
    diff: makeUnifiedDiff(filePath, oldContent ?? "", newContent),
  };
}

/** A "modified" change whose new content is byte-identical to the old. */
export function isNoOpChange(change: FileDiff): boolean {
  return (
    change.changeType === "modified" &&
    change.oldContentHash !== undefined &&
    change.oldContentHash === change.newContentHash
  );
}

/**
 * Content of `filePath` at HEAD, or `undefined` when the file is not
 * tracked at HEAD (or the workspace is not a git repo).
 */
export async function readHeadContent(
  workspaceRoot: string,
  filePath: string
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["show", `HEAD:${filePath}`], {
      cwd: workspaceRoot,
      env: buildChildEnv(),
      maxBuffer: 10 * 1024 * 1024,
      shell: false,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

/**
 * Paths `git status --porcelain` reports as dirty, with their current
 * content (`null` when the path does not exist on disk). Taken before a
 * runtime that writes straight to disk, so pre-existing edits are neither
 * attributed to the agent nor used as a wrong baseline.
 */
export async function snapshotDirtyFiles(
  workspaceRoot: string
): Promise<Map<string, string | null>> {
  const snapshot = new Map<string, string | null>();
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: workspaceRoot,
      env: buildChildEnv(),
      maxBuffer: 10 * 1024 * 1024,
      shell: false,
      windowsHide: true,
    }));
  } catch {
    return snapshot;
  }
  for (const line of stdout.split(/\r?\n/)) {
    const filePath = line.slice(3).trim();
    if (!filePath) continue;
    try {
      const resolved = await resolveSandboxPathAsync(workspaceRoot, filePath);
      snapshot.set(filePath, await readIfExists(resolved));
    } catch {
      // Paths outside the sandbox are not ours to track.
    }
  }
  return snapshot;
}

export async function gitDiff(workspaceRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--no-color"], {
      cwd: workspaceRoot,
      env: buildChildEnv(),
      maxBuffer: 10 * 1024 * 1024,
      shell: false,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return "";
  }
}

/**
 * Applies an approved change only if the file on disk still matches the
 * content that was proposed. Prevents overwriting edits made after approval.
 */
export async function applyFileChange(
  workspaceRoot: string,
  change: FileDiff
): Promise<void> {
  const resolved = await resolveSandboxPathAsync(workspaceRoot, change.filePath);
  const expectedOld =
    change.oldContentHash ??
    (change.oldContent !== undefined ? hashContent(change.oldContent) : undefined);
  const expectedNew =
    change.newContentHash ??
    (change.newContent !== undefined ? hashContent(change.newContent) : undefined);

  if (change.changeType === "deleted") {
    const current = await readIfExists(resolved);
    if (current === null) return;
    if (expectedOld && hashContent(current) !== expectedOld) {
      throw new StaleFileError(
        `${change.filePath} changed after approval; refusing to delete`
      );
    }
    await fs.unlink(resolved);
    return;
  }

  const newContent = change.newContent ?? "";
  const current = await readIfExists(resolved);

  if (change.changeType === "new") {
    if (current !== null) {
      if (expectedNew && hashContent(current) === expectedNew) return;
      throw new StaleFileError(
        `${change.filePath} was created after approval; refusing to overwrite`
      );
    }
  } else {
    if (current === null) {
      throw new StaleFileError(
        `${change.filePath} was removed after approval; refusing to recreate`
      );
    }
    if (expectedNew !== undefined && hashContent(current) === expectedNew) return;
    if (expectedOld && hashContent(current) !== expectedOld) {
      throw new StaleFileError(
        `${change.filePath} changed after approval; refusing to overwrite`
      );
    }
  }

  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, newContent, "utf-8");

  if (expectedNew) {
    const written = await fs.readFile(resolved, "utf-8");
    if (hashContent(written) !== expectedNew) {
      throw new Error(`Verification failed after writing ${change.filePath}`);
    }
  }
}

async function readIfExists(target: string): Promise<string | null> {
  try {
    return await fs.readFile(target, "utf-8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

const DIFF_CONTEXT_LINES = 3;
/** Above this many LCS cells the diff falls back to a whole-file rewrite. */
const MAX_LCS_CELLS = 4_000_000;

type DiffOp = { type: " " | "-" | "+"; line: string };

function splitLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.split("\n");
  // A trailing newline terminates the last line; it is not an extra line.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function lineOps(oldLines: string[], newLines: string[]): DiffOp[] {
  // Trim the common prefix/suffix first: most edits touch a small window.
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1;
  const a = oldLines.slice(prefix, oldLines.length - suffix);
  const b = newLines.slice(prefix, newLines.length - suffix);
  const ops: DiffOp[] = oldLines.slice(0, prefix).map((line) => ({ type: " ", line }));

  if ((a.length + 1) * (b.length + 1) > MAX_LCS_CELLS) {
    for (const line of a) ops.push({ type: "-", line });
    for (const line of b) ops.push({ type: "+", line });
  } else {
    // LCS table from the end so the walk below goes forward.
    const width = b.length + 1;
    const table = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        table[i * width + j] =
          a[i] === b[j]
            ? table[(i + 1) * width + j + 1] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        ops.push({ type: " ", line: a[i] });
        i += 1;
        j += 1;
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
        ops.push({ type: "-", line: a[i] });
        i += 1;
      } else {
        ops.push({ type: "+", line: b[j] });
        j += 1;
      }
    }
    for (; i < a.length; i += 1) ops.push({ type: "-", line: a[i] });
    for (; j < b.length; j += 1) ops.push({ type: "+", line: b[j] });
  }

  for (const line of oldLines.slice(oldLines.length - suffix)) ops.push({ type: " ", line });
  return ops;
}

/**
 * Unified diff with real hunks (3 lines of context), so approval views and
 * the reviewer prompt see what changed instead of a whole-file rewrite.
 */
export function makeUnifiedDiff(filePath: string, oldContent: string, newContent: string): string {
  const ops = lineOps(splitLines(oldContent), splitLines(newContent));
  const header = [`--- a/${filePath}`, `+++ b/${filePath}`];
  const changed = ops.map((op, index) => (op.type === " " ? -1 : index)).filter((index) => index >= 0);
  if (changed.length === 0) return header.join("\n");

  // Group changes whose context windows touch into one hunk.
  const ranges: Array<[number, number]> = [];
  for (const index of changed) {
    const from = Math.max(0, index - DIFF_CONTEXT_LINES);
    const to = Math.min(ops.length - 1, index + DIFF_CONTEXT_LINES);
    const last = ranges[ranges.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }

  // Line numbers (1-based) of each op in the old and new file.
  const oldAt: number[] = [];
  const newAt: number[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const op of ops) {
    oldAt.push(oldLine);
    newAt.push(newLine);
    if (op.type !== "+") oldLine += 1;
    if (op.type !== "-") newLine += 1;
  }

  const lines = [...header];
  for (const [from, to] of ranges) {
    const slice = ops.slice(from, to + 1);
    const oldCount = slice.filter((op) => op.type !== "+").length;
    const newCount = slice.filter((op) => op.type !== "-").length;
    const oldStart = oldCount === 0 ? oldAt[from] - 1 : oldAt[from];
    const newStart = newCount === 0 ? newAt[from] - 1 : newAt[from];
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of slice) lines.push(`${op.type}${op.line}`);
  }
  return lines.join("\n");
}
