import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildChildEnv } from "@/api/convex/lib/childEnv";
import { gitIdentityArgs } from "@/api/convex/lib/gitIdentity";

const execFileAsync = promisify(execFile);

export async function commitWorktree(
  worktreePath: string,
  message: string,
  files?: string[]
): Promise<boolean> {
  const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], {
    cwd: worktreePath,
    shell: false,
    windowsHide: true,
    env: buildChildEnv(),
  });
  if (status.trim().length === 0) return false;
  await execFileAsync("git", files && files.length > 0 ? ["add", "--", ...files] : ["add", "-A"], {
    cwd: worktreePath,
    shell: false,
    windowsHide: true,
    env: buildChildEnv(),
  });
  await execFileAsync(
    "git",
    // Identity per command: the scrubbed child env carries no GIT_AUTHOR_*
    // and a fresh clone has no user.name/email (FHARA_GIT_AUTHOR_* override).
    [...gitIdentityArgs(), "commit", "-m", message],
    { cwd: worktreePath, shell: false, windowsHide: true, env: buildChildEnv() }
  );
  return true;
}

export interface CommitSummary {
  sha: string;
  message: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  ahead?: number;
  behind?: number;
  comparedTo?: string;
}

/**
 * Plan 019: what the push card shows for a committed task branch — HEAD's
 * sha/subject plus files, line counts and ahead/behind against the local
 * base branch. Counts are omitted (not guessed) when the base is missing.
 */
export async function describeCommit(worktreePath: string, baseBranch: string): Promise<CommitSummary> {
  const git = async (args: string[]) =>
    (await execFileAsync("git", args, { cwd: worktreePath, shell: false, windowsHide: true, env: buildChildEnv() })).stdout.trim();
  const sha = await git(["rev-parse", "HEAD"]);
  const message = await git(["log", "-1", "--format=%s"]);
  let filesChanged = 0;
  let additions = 0;
  let deletions = 0;
  let ahead: number | undefined;
  let behind: number | undefined;
  let comparedTo: string | undefined;
  try {
    await git(["rev-parse", "--verify", "--quiet", `${baseBranch}^{commit}`]);
    comparedTo = baseBranch;
    const numstat = await git(["diff", "--numstat", `${baseBranch}...HEAD`]);
    for (const line of numstat.split("\n").filter(Boolean)) {
      const [add, del] = line.split("\t");
      filesChanged += 1;
      // Binary files report "-": counted as a file, not as lines.
      if (/^\d+$/.test(add)) additions += Number(add);
      if (/^\d+$/.test(del)) deletions += Number(del);
    }
    const counts = await git(["rev-list", "--left-right", "--count", `${baseBranch}...HEAD`]);
    const [left, right] = counts.split(/\s+/).map(Number);
    if (Number.isFinite(left) && Number.isFinite(right)) {
      behind = left;
      ahead = right;
    }
  } catch {
    // No local base branch: fall back to HEAD's own diff stat.
    const numstat = await git(["show", "--numstat", "--format=", "HEAD"]);
    for (const line of numstat.split("\n").filter(Boolean)) {
      const [add, del] = line.split("\t");
      filesChanged += 1;
      if (/^\d+$/.test(add)) additions += Number(add);
      if (/^\d+$/.test(del)) deletions += Number(del);
    }
  }
  return { sha, message, filesChanged, additions, deletions, ahead, behind, comparedTo };
}
