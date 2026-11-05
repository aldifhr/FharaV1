import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveSandboxPath } from "./sandbox";

const execFileAsync = promisify(execFile);

export interface FileDiff {
  filePath: string;
  changeType: "new" | "modified" | "deleted";
  oldContent?: string;
  newContent?: string;
  diff: string;
}

export async function computeDiff(
  workspaceRoot: string,
  filePath: string,
  newContent: string
): Promise<FileDiff> {
  const resolved = resolveSandboxPath(workspaceRoot, filePath);
  let oldContent: string | undefined;
  let changeType: "new" | "modified" | "deleted" = "modified";

  try {
    oldContent = await fs.readFile(resolved, "utf-8");
  } catch {
    changeType = "new";
    oldContent = undefined;
  }

  const diff = makeUnifiedDiff(filePath, oldContent ?? "", newContent);
  return {
    filePath,
    changeType,
    oldContent,
    newContent,
    diff,
  };
}

export async function gitDiff(workspaceRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--no-color"], {
      cwd: workspaceRoot,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return "";
  }
}

function makeUnifiedDiff(filePath: string, oldContent: string, newContent: string): string {
  // ponytail: diff baris sederhana tanpa library; cukup untuk preview MVP.
  // Upgrade: pakai `diff` package untuk hunk yang akurat.
  const oldLines = oldContent === "" ? [] : oldContent.split("\n");
  const newLines = newContent === "" ? [] : newContent.split("\n");
  const lines: string[] = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
  ];
  for (const l of oldLines) lines.push(`-${l}`);
  for (const l of newLines) lines.push(`+${l}`);
  return lines.join("\n");
}

export function applyDiffStaged(workspaceRoot: string, diff: FileDiff): string {
  // ponytail: simpan newContent langsung, bukan patch replay.
  void workspaceRoot;
  void diff.diff;
  return diff.newContent ?? "";
}

export async function writeStaged(workspaceRoot: string, diff: FileDiff): Promise<void> {
  if (diff.changeType === "deleted") return;
  const resolved = resolveSandboxPath(workspaceRoot, diff.filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, diff.newContent ?? "", "utf-8");
}
