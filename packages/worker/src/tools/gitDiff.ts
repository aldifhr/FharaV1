import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

function makeUnifiedDiff(filePath: string, oldContent: string, newContent: string): string {
  const oldLines = oldContent === "" ? [] : oldContent.split("\n");
  const newLines = newContent === "" ? [] : newContent.split("\n");
  const lines: string[] = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
  ];
  for (const line of oldLines) lines.push(`-${line}`);
  for (const line of newLines) lines.push(`+${line}`);
  return lines.join("\n");
}
