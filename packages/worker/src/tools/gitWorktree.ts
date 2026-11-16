import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildChildEnv } from "@/api/convex/lib/childEnv";
import { gitIdentityArgs } from "@/api/convex/lib/gitIdentity";

const execFileAsync = promisify(execFile);

export interface CommitWorktreeOptions {
  /**
   * R9: build the message from the staged diff (`git diff --cached`). A
   * null / empty result or a throw keeps `message` (the fallback).
   */
  messageFromDiff?: (diff: string) => Promise<string | null>;
}

export async function commitWorktree(
  worktreePath: string,
  message: string,
  files?: string[],
  options: CommitWorktreeOptions = {}
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
  let finalMessage = message;
  if (options.messageFromDiff) {
    try {
      const { stdout: diff } = await execFileAsync("git", ["diff", "--cached", "--no-color", "--no-ext-diff"], {
        cwd: worktreePath,
        shell: false,
        windowsHide: true,
        env: buildChildEnv(),
        maxBuffer: 16 * 1024 * 1024,
      });
      const generated = diff.trim() ? await options.messageFromDiff(diff) : null;
      if (generated && generated.trim()) finalMessage = generated.trim();
    } catch {
      // Best effort: the fallback message stays.
    }
  }
  await execFileAsync(
    "git",
    // Identity per command: the scrubbed child env carries no GIT_AUTHOR_*
    // and a fresh clone has no user.name/email (FHARA_GIT_AUTHOR_* override).
    [...gitIdentityArgs(), "commit", "-m", finalMessage],
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
  const countNumstat = (output: string) => {
    // -z keeps paths out of the parse: records end in NUL, fields in TAB.
    for (const record of output.split("\0")) {
      const [add, del] = record.split("\t");
      if (add === undefined || del === undefined) continue;
      filesChanged += 1;
      // Binary files report "-": counted as a file, not as lines.
      const added = Number(add);
      const deleted = Number(del);
      if (Number.isFinite(added)) additions += added;
      if (Number.isFinite(deleted)) deletions += deleted;
    }
  };
  try {
    await git(["rev-parse", "--verify", "--quiet", `${baseBranch}^{commit}`]);
    comparedTo = baseBranch;
    countNumstat(await git(["diff", "--numstat", "-z", `${baseBranch}...HEAD`]));
    const counts = await git(["rev-list", "--left-right", "--count", `${baseBranch}...HEAD`]);
    const parts = counts.split(/\s+/);
    const left = Number(parts[0]);
    const right = Number(parts[1]);
    if (Number.isFinite(left) && Number.isFinite(right)) {
      behind = left;
      ahead = right;
    }
  } catch {
    // No local base branch: fall back to HEAD's own diff stat.
    countNumstat(await git(["show", "--numstat", "-z", "--format=", "HEAD"]));
  }
  return { sha, message, filesChanged, additions, deletions, ahead, behind, comparedTo };
}
