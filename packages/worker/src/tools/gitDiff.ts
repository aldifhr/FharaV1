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

export async function computeDiff(
  workspaceRoot: string,
  filePath: string,
  newContent: string
): Promise<FileDiff> {
  const resolved = await resolveSandboxPathAsync(workspaceRoot, filePath);
  let oldContent: string | undefined;
  let changeType: "new" | "modified" | "deleted" = "modified";

  try {
    oldContent = await fs.readFile(resolved, "utf-8");
  } catch (error) {
    if (isMissing(error)) {
      changeType = "new";
      oldContent = undefined;
    } else {
      throw error;
    }
  }

  return {
    filePath,
    changeType,
    oldContent,
    newContent,
    oldContentHash: hashContent(oldContent ?? ""),
    newContentHash: hashContent(newContent),
    diff: makeUnifiedDiff(filePath, oldContent ?? "", newContent),
  };
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
