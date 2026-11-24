import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildChildEnv } from "@/api/functions/lib/childEnv";

const execFileAsync = promisify(execFile);

/** W4: a runner-internal git call, not an agent command, so not via the agent allowlist (as listWorkspaceChanges). */
export const hostGit = (cwd: string, args: string[], signal?: AbortSignal) =>
  execFileAsync("git", args, { cwd, env: buildChildEnv(), shell: false, windowsHide: true, signal });

/** Current HEAD sha, or null when the workspace is not a git repo. */
export async function readGitHead(workspacePath: string, signal?: AbortSignal): Promise<string | null> {
  try {
    return (await hostGit(workspacePath, ["rev-parse", "HEAD"], signal)).stdout.trim() || null;
  } catch {
    return null;
  }
}
