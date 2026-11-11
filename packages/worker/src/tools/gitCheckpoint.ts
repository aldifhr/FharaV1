/**
 * GOAT G5: capture a task worktree as a hidden-ref checkpoint
 * (`refs/fhara/checkpoints/<taskId>/<n>`, lib/checkpointRefs.ts).
 *
 * The whole tree (tracked edits, deletions and untracked files that are not
 * ignored) is staged into a temporary GIT_INDEX_FILE, then `write-tree`,
 * `commit-tree -p HEAD` and a create-only `update-ref`. HEAD, the branch
 * and the worktree's real index are never written: only the temp index,
 * new objects and the hidden ref.
 *
 * The command sequence is a pattern from GOAT apps/server/src/vcs/GitVcsDriver.ts
 * (`captureTree`), MIT, Copyright (c) 2026 T3 Tools Inc. and goat-si
 * contributors; see THIRD_PARTY_NOTICES.md. Re-expressed with execFile.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, rm } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { buildChildEnv } from "@/api/convex/lib/childEnv";
import { checkpointNumber, checkpointRefName, checkpointRefPrefix } from "@/api/convex/lib/checkpointRefs";
import { parseTurnDiffFilesFromNumstat, type TurnDiffFileSummary } from "@/vendor/goat/diffs";

const execFileAsync = promisify(execFile);

/** Scratch-index writes must not touch the real index's fsmonitor or split-index state. */
const INDEX_CONFIG = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.splitIndex=false",
  "-c",
  "splitIndex.sharedIndexExpire=never",
];

/** Checkpoint commits carry a fixed identity: the scrubbed child env has none, and no user config is read for it. */
const CHECKPOINT_IDENTITY = {
  GIT_AUTHOR_NAME: "Fhara",
  GIT_AUTHOR_EMAIL: "checkpoint@fhara.invalid",
  GIT_COMMITTER_NAME: "Fhara",
  GIT_COMMITTER_EMAIL: "checkpoint@fhara.invalid",
};

const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
/** Create-only ref writes retried with the next number when a parallel capture took this one. */
const REF_RACE_RETRIES = 5;

export interface CapturedCheckpoint {
  n: number;
  ref: string;
  commitSha: string;
  treeSha: string;
  /** HEAD at capture (the commit's parent), null on an unborn branch. */
  headSha: string | null;
  /** What `files` is measured against: the previous checkpoint, else HEAD, else the empty tree. */
  previousSha: string | null;
  files: TurnDiffFileSummary[];
  additions: number;
  deletions: number;
}

type Git = (args: string[], extraEnv?: Record<string, string>) => Promise<string>;

function gitIn(cwd: string): Git {
  return async (args, extraEnv) =>
    (
      await execFileAsync("git", args, {
        cwd,
        shell: false,
        windowsHide: true,
        env: buildChildEnv(extraEnv),
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        encoding: "utf8",
      })
    ).stdout;
}

async function tryRev(git: Git, rev: string): Promise<string | null> {
  try {
    const sha = (await git(["rev-parse", "--verify", "-q", `${rev}^{commit}`])).trim();
    return sha || null;
  } catch {
    return null;
  }
}

/** The task's checkpoint numbers in use, ascending. */
async function usedNumbers(git: Git, taskId: string): Promise<number[]> {
  const out = await git(["for-each-ref", "--format=%(refname)", checkpointRefPrefix(taskId)]);
  return out
    .split("\n")
    .map((ref) => checkpointNumber(ref.trim(), taskId))
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
}

/** Stages the whole worktree into a temp index and writes its tree. The real index is only read (copied). */
async function writeWorktreeTree(git: Git, headSha: string | null): Promise<string> {
  const gitDir = (await git(["rev-parse", "--absolute-git-dir"])).trim();
  const realIndex = path.resolve(gitDir, "index");
  const tempIndex = path.join(gitDir, `fhara-checkpoint-index-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: tempIndex };
  try {
    if (headSha) {
      // A copy of the real index keeps its stat cache, so `add -A` hashes only changed files.
      let copied = false;
      try {
        await copyFile(realIndex, tempIndex);
        copied = true;
      } catch {}
      await git([...INDEX_CONFIG, "read-tree", ...(copied ? ["--reset"] : []), headSha], env);
    }
    await git([...INDEX_CONFIG, "add", "-A", "--", "."], env);
    const tree = (await git([...INDEX_CONFIG, "write-tree"], env)).trim();
    if (!tree) throw new Error("git write-tree returned an empty tree id");
    return tree;
  } finally {
    // A killed git can leave the temp index's lock behind.
    await Promise.all([rm(tempIndex, { force: true }), rm(`${tempIndex}.lock`, { force: true })]);
  }
}

async function numstatSince(git: Git, previousSha: string | null, commitSha: string): Promise<TurnDiffFileSummary[]> {
  const base = ["--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--numstat", "-z"];
  const out = previousSha
    ? await git(["diff", ...base, previousSha, commitSha])
    : await git(["diff-tree", "-r", "--root", "--no-commit-id", ...base, commitSha]);
  return [...parseTurnDiffFilesFromNumstat(out)];
}

/**
 * Captures `cwd` (a task worktree, or any directory inside it) as the
 * task's next checkpoint. Throws when git fails; callers treat a capture
 * as best effort.
 */
export async function captureCheckpoint(cwd: string, taskId: string): Promise<CapturedCheckpoint> {
  const top = (await gitIn(cwd)(["rev-parse", "--show-toplevel"])).trim();
  const git = gitIn(top);
  const headSha = await tryRev(git, "HEAD");
  const treeSha = await writeWorktreeTree(git, headSha);
  const used = await usedNumbers(git, taskId);
  let n = (used.at(-1) ?? 0) + 1;
  for (let attempt = 0; ; attempt += 1) {
    const ref = checkpointRefName(taskId, n);
    const commitSha = (
      await git(
        ["commit-tree", treeSha, ...(headSha ? ["-p", headSha] : []), "-m", `fhara checkpoint ref=${ref}`],
        CHECKPOINT_IDENTITY
      )
    ).trim();
    if (!commitSha) throw new Error("git commit-tree returned an empty commit id");
    try {
      // Empty old value: create only, never move an existing checkpoint.
      await git(["update-ref", ref, commitSha, ""]);
    } catch (err) {
      if (attempt >= REF_RACE_RETRIES) throw err;
      n += 1;
      continue;
    }
    const previousSha = (n > 1 ? await tryRev(git, checkpointRefName(taskId, n - 1)) : null) ?? headSha;
    const files = await numstatSince(git, previousSha, commitSha);
    return {
      n,
      ref,
      commitSha,
      treeSha,
      headSha,
      previousSha,
      files,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    };
  }
}
