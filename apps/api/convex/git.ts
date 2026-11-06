"use node";

import { execSync } from "node:child_process";
import * as path from "node:path";

export function gitExec(cwd: string, args: string[]): string {
  return execSync(`git ${args.join(" ")}`, { cwd, encoding: "utf-8", windowsHide: true });
}

export function makeBranchName(taskId: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `moagent/${taskId}/${slug || "task"}`;
}

export function resolveWorktreesBase(wsPath: string, worktreesPath?: string): string {
  return worktreesPath ?? path.join(wsPath, ".moagent-worktrees");
}
