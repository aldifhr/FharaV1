/**
 * GOAT G6: restore a task worktree to a hidden-ref checkpoint (G5,
 * lib/checkpointRefs.ts), and snapshot a worktree before the sweep removes
 * it (audit/goat-plan-2026-11-11.md, idea #1b).
 *
 * - `restoreWorktreeTree`: the tree becomes identical to a commit's tree.
 *   `git restore --source --worktree --staged` brings back deleted and
 *   tracked-ignored files, then a multi-pass clean removes what the commit
 *   lacks: untracked files, nested repositories and ignored files, except
 *   dependency and tool caches and `.env*` files (PRESERVED_IGNORED), which
 *   a checkpoint never holds. The index ends equal to HEAD.
 * - `restoreToCheckpoint`: refused once the task branch was pushed (an
 *   upstream or a remote-tracking ref of the same name), since it rewinds
 *   HEAD to the commit the checkpoint was captured on. `revertCommitToCheckpoint`
 *   is the pushed-branch alternative: a new commit on top whose tree is the
 *   checkpoint's.
 * - Snapshots: `refs/fhara/snapshots/<taskId>/<unixMs>`, a commit whose tree
 *   is the whole worktree (as a checkpoint) with parents HEAD and an index
 *   commit, and trailers naming the branch and worktree path. They are not
 *   checkpoint refs, so the G5 deletions never touch them; their retention
 *   is SNAPSHOT_RETENTION_MS, pruned by the worktree sweep cron.
 *
 * The restore sequence and the snapshot shape are a pattern from GOAT
 * apps/server/src/vcs/GitVcsDriver.ts (`restoreCheckpoint`) and
 * apps/server/src/worktreeSnapshots/captureSnapshot.ts, MIT, Copyright (c)
 * 2026 T3 Tools Inc. and goat-si contributors; see THIRD_PARTY_NOTICES.md.
 * Pure: git runs through injected functions (no node: imports).
 */
import { CHECKPOINT_REF_ROOT, type GitSync } from "./checkpointRefs";

export const SNAPSHOT_REF_ROOT = "refs/fhara/snapshots";
/** Snapshot refs older than this are deleted by the 6-hourly worktree sweep. */
export const SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** git with an extra environment (temp index, commit identity). */
export type GitEnvSync = (args: string[], env?: Record<string, string>) => string;

/** Fixed identity for snapshot commits, as for checkpoints (tools/gitCheckpoint.ts). */
export const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "Fhara",
  GIT_AUTHOR_EMAIL: "checkpoint@fhara.invalid",
  GIT_COMMITTER_NAME: "Fhara",
  GIT_COMMITTER_EMAIL: "checkpoint@fhara.invalid",
};

/** Ignored paths a restore keeps: installs and caches the checkpoint never captured, and local env files. */
const PRESERVED_IGNORED =
  /(?:^|\/)(?:node_modules|\.venv|venv|__pycache__|\.next|\.turbo|\.cache|\.pnpm-store|\.gradle|\.parcel-cache)(?:\/|$)|(?:^|\/)\.env(?:\.[^/]*)?$/;

export function isPreservedIgnored(path: string): boolean {
  return PRESERVED_IGNORED.test(path);
}

const SHA = /^[0-9a-f]{40,64}$/;
const CLEAN_PASSES = 3;
const PATHSPEC_BATCH = 200;

function nul(out: string): string[] {
  return out.split("\0").filter(Boolean);
}

function tryGit(git: GitSync, args: string[]): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function resolveCommit(git: GitSync, rev: string): string | null {
  const sha = tryGit(git, ["rev-parse", "--verify", "-q", `${rev}^{commit}`])?.trim();
  return sha && SHA.test(sha) ? sha : null;
}

/** Untracked entries git would leave behind after a restore: not ignored, and ignored but not preserved. */
function leftovers(git: GitSync): { untracked: string[]; ignored: string[] } {
  const untracked = nul(git(["ls-files", "--others", "--exclude-standard", "--directory", "-z", "--", "."]));
  const ignored = nul(git(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z", "--", "."]))
    .filter((path) => !isPreservedIgnored(path.replace(/\/$/, "")));
  return { untracked, ignored };
}

/**
 * Multi-pass clean: pass one removes untracked files and nested repos
 * (`-ffd`), pass two removes the listed ignored paths (`-ffdX`, literal
 * pathspecs, preserved ones never listed). A pass can uncover more (a
 * directory that held only now-removed entries), so it repeats until
 * nothing is left or CLEAN_PASSES ran. Returns what is still left.
 */
export function multiPassClean(git: GitSync): string[] {
  let left = leftovers(git);
  for (let pass = 0; pass < CLEAN_PASSES && (left.untracked.length || left.ignored.length); pass++) {
    if (left.untracked.length) git(["clean", "-ffdq", "--", "."]);
    for (let i = 0; i < left.ignored.length; i += PATHSPEC_BATCH) {
      git(["--literal-pathspecs", "clean", "-ffdXq", "--", ...left.ignored.slice(i, i + PATHSPEC_BATCH)]);
    }
    left = leftovers(git);
  }
  return [...left.untracked, ...left.ignored];
}

/**
 * Makes the worktree at `git`'s cwd identical to `commitSha`'s tree and the
 * index equal to HEAD. HEAD is not moved here.
 */
export function restoreWorktreeTree(git: GitSync, commitSha: string): void {
  if (!SHA.test(commitSha)) throw new Error(`Not a commit id: ${JSON.stringify(commitSha)}`);
  const tracked = git(["ls-files", "--cached", `--with-tree=${commitSha}`, "-z", "--", "."]);
  // An empty index and source have nothing for restore's pathspec to match.
  if (tracked.length > 0) git(["restore", "--source", commitSha, "--worktree", "--staged", "--", "."]);
  const left = multiPassClean(git);
  if (left.length) throw new Error(`Restore left ${left.length} path(s) behind: ${left.slice(0, 5).join(", ")}`);
  git(["reset", "--quiet", "--", "."]);
}

export interface PushState {
  pushed: boolean;
  /** The upstream or remote-tracking ref that shows the push. */
  remoteRef?: string;
}

/** The checked-out branch counts as pushed when it has an upstream or a remote-tracking ref of its name. */
export function branchPushState(git: GitSync): PushState {
  const branch = tryGit(git, ["symbolic-ref", "--quiet", "--short", "HEAD"])?.trim();
  if (!branch) return { pushed: false };
  const upstream = tryGit(git, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])?.trim();
  if (upstream) return { pushed: true, remoteRef: upstream };
  const remotes = git(["for-each-ref", "--format=%(refname)", "refs/remotes"]).split("\n").map((ref) => ref.trim());
  const match = remotes.find((ref) => /^refs\/remotes\/[^/]+\//.test(ref) && ref.replace(/^refs\/remotes\/[^/]+\//, "") === branch);
  return match ? { pushed: true, remoteRef: match.replace(/^refs\/remotes\//, "") } : { pushed: false };
}

export type RestoreOutcome =
  | { status: "ok"; headSha: string; rewound: boolean }
  | { status: "pushed"; remoteRef?: string; offer: "revert-commit" }
  | { status: "missing"; detail: string };

/**
 * Rewinds HEAD (soft) to the commit the checkpoint was captured on, then
 * restores the tree. Refused on a pushed branch, or when `fhara` says so
 * (`pushedInFhara`: a push row exists).
 */
export function restoreToCheckpoint(
  git: GitSync,
  checkpoint: { commitSha: string; headSha?: string },
  options: { pushedInFhara?: boolean } = {},
): RestoreOutcome {
  const commit = resolveCommit(git, checkpoint.commitSha);
  if (!commit) return { status: "missing", detail: "checkpoint commit not found" };
  const push = branchPushState(git);
  if (push.pushed || options.pushedInFhara) {
    return { status: "pushed", ...(push.remoteRef ? { remoteRef: push.remoteRef } : {}), offer: "revert-commit" };
  }
  const head = resolveCommit(git, "HEAD");
  const target = checkpoint.headSha ?? resolveCommit(git, `${commit}^`) ?? head;
  if (!target || !resolveCommit(git, target)) return { status: "missing", detail: "checkpoint base commit not found" };
  const rewound = head !== target;
  if (rewound) git(["reset", "--soft", "--quiet", target]);
  restoreWorktreeTree(git, commit);
  return { status: "ok", headSha: target, rewound };
}

export type RevertCommitOutcome =
  | { status: "ok"; commitSha: string }
  | { status: "unchanged"; headSha: string }
  | { status: "missing"; detail: string };

/**
 * The pushed-branch alternative: HEAD stays, the tree becomes the
 * checkpoint's, and the change is committed on top (history is only added
 * to). `commitArgs` carries the identity, e.g. `-c user.name=…`.
 */
export function revertCommitToCheckpoint(
  git: GitSync,
  checkpoint: { commitSha: string; n: number },
  commitArgs: string[],
): RevertCommitOutcome {
  const commit = resolveCommit(git, checkpoint.commitSha);
  if (!commit) return { status: "missing", detail: "checkpoint commit not found" };
  restoreWorktreeTree(git, commit);
  git(["add", "-A", "--", "."]);
  const head = resolveCommit(git, "HEAD");
  if (head && tryGit(git, ["diff", "--cached", "--quiet", "HEAD", "--"]) !== null) return { status: "unchanged", headSha: head };
  git([...commitArgs, "commit", "--quiet", "--no-verify", "-m", `Revert to checkpoint ${checkpoint.n}\n\nFhara-Checkpoint: ${commit}`]);
  return { status: "ok", commitSha: resolveCommit(git, "HEAD")! };
}

// --- Snapshots before the worktree sweep ---

function assertRefSafe(taskId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw new Error(`Invalid task id for a snapshot ref: ${JSON.stringify(taskId)}`);
}

export function snapshotRefPrefix(taskId: string): string {
  assertRefSafe(taskId);
  return `${SNAPSHOT_REF_ROOT}/${taskId}/`;
}

export interface WorktreeSnapshot {
  ref: string;
  commitSha: string;
  createdAt: number;
  headSha: string;
  indexSha: string;
  branch?: string;
  worktreePath?: string;
}

export interface SnapshotDeps {
  /** git in the worktree being snapshotted. */
  git: GitEnvSync;
  removeFile: (path: string) => void;
}

/**
 * Captures HEAD, the index and the whole worktree (not ignored files) as
 * `refs/fhara/snapshots/<taskId>/<now>`. Throws when git fails (unmerged
 * entries, an unborn branch); the sweep then keeps the worktree.
 */
export function captureWorktreeSnapshot(
  deps: SnapshotDeps,
  taskId: string,
  now: number,
  meta: { worktreePath: string },
): WorktreeSnapshot {
  const git = deps.git;
  const head = git(["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  const branch = tryGit(git, ["symbolic-ref", "--quiet", "--short", "HEAD"])?.trim() || undefined;
  const indexTree = git(["write-tree"]).trim();
  const indexSha = git(["commit-tree", indexTree, "-p", head, "-m", "fhara index snapshot"], SNAPSHOT_IDENTITY).trim();
  const gitDir = git(["rev-parse", "--absolute-git-dir"]).trim();
  const tempIndex = `${gitDir}/fhara-snapshot-index-${now}-${Math.random().toString(36).slice(2)}`;
  let tree: string;
  try {
    git(["read-tree", head], { GIT_INDEX_FILE: tempIndex });
    git(["add", "-A", "--", "."], { GIT_INDEX_FILE: tempIndex });
    tree = git(["write-tree"], { GIT_INDEX_FILE: tempIndex }).trim();
  } finally {
    for (const file of [tempIndex, `${tempIndex}.lock`]) {
      try {
        deps.removeFile(file);
      } catch {}
    }
  }
  const message = [
    "fhara worktree snapshot",
    "",
    `Fhara-Task: ${taskId}`,
    ...(branch ? [`Fhara-Branch: ${branch}`] : []),
    `Fhara-Worktree: ${meta.worktreePath}`,
  ].join("\n");
  const commitSha = git(["commit-tree", tree, "-p", head, "-p", indexSha, "-m", message], SNAPSHOT_IDENTITY).trim();
  for (let stamp = now; stamp < now + 5; stamp++) {
    const ref = `${snapshotRefPrefix(taskId)}${stamp}`;
    if (tryGit(git, ["update-ref", ref, commitSha, ""]) === null) continue;
    return { ref, commitSha, createdAt: stamp, headSha: head, indexSha, ...(branch ? { branch } : {}), worktreePath: meta.worktreePath };
  }
  throw new Error("could not create the snapshot ref");
}

/** The task's snapshots, newest first. */
export function listWorktreeSnapshots(git: GitSync, taskId: string): WorktreeSnapshot[] {
  const prefix = snapshotRefPrefix(taskId);
  const out: WorktreeSnapshot[] = [];
  for (const line of git(["for-each-ref", "--format=%(refname) %(objectname)", prefix]).split("\n")) {
    const [ref, commitSha] = line.trim().split(" ");
    const stamp = ref?.slice(prefix.length);
    if (!ref || !commitSha || !stamp || !/^\d+$/.test(stamp)) continue;
    const parents = git(["rev-list", "--parents", "-n", "1", commitSha]).trim().split(" ");
    if (parents.length !== 3) continue;
    const body = git(["log", "-1", "--format=%B", commitSha]);
    const trailer = (key: string) => body.match(new RegExp(`^${key}: (.+)$`, "m"))?.[1]?.trim();
    const branch = trailer("Fhara-Branch");
    const worktreePath = trailer("Fhara-Worktree");
    out.push({
      ref,
      commitSha,
      createdAt: Number(stamp),
      headSha: parents[1]!,
      indexSha: parents[2]!,
      ...(branch ? { branch } : {}),
      ...(worktreePath ? { worktreePath } : {}),
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** Deletes every snapshot ref older than `maxAgeMs` in the repo; returns the deleted names. */
export function pruneWorktreeSnapshots(git: GitSync, now: number, maxAgeMs = SNAPSHOT_RETENTION_MS): string[] {
  const deleted: string[] = [];
  for (const line of git(["for-each-ref", "--format=%(refname)", `${SNAPSHOT_REF_ROOT}/`]).split("\n")) {
    const ref = line.trim();
    const stamp = ref.match(/\/(\d+)$/)?.[1];
    if (!ref.startsWith(`${SNAPSHOT_REF_ROOT}/`) || ref.startsWith(`${CHECKPOINT_REF_ROOT}/`) || !stamp) continue;
    if (now - Number(stamp) <= maxAgeMs) continue;
    if (tryGit(git, ["update-ref", "-d", ref]) !== null) deleted.push(ref);
  }
  return deleted;
}

export type SnapshotRestoreOutcome =
  | { status: "ok"; worktreePath: string; branch: string; createdBranch: boolean }
  | { status: "worktree-exists"; worktreePath: string }
  | { status: "branch-moved"; branch: string; branchSha: string; headSha: string }
  | { status: "missing"; detail: string };

/**
 * Re-creates the swept worktree from a snapshot: `git worktree add` on the
 * kept branch (or a new branch at the snapshot's HEAD when it was deleted),
 * then the worktree tree and the index exactly as snapshotted. Refused when
 * the branch moved since, so a later commit is never dropped.
 */
export function restoreWorktreeSnapshot(
  gitAt: (cwd: string) => GitSync,
  repoPath: string,
  snapshot: WorktreeSnapshot,
  fallback: { worktreePath?: string; branch?: string } = {},
): SnapshotRestoreOutcome {
  const repo = gitAt(repoPath);
  const worktreePath = snapshot.worktreePath ?? fallback.worktreePath;
  const branch = snapshot.branch ?? fallback.branch;
  if (!worktreePath || !branch) return { status: "missing", detail: "snapshot names no worktree path or branch" };
  if (!resolveCommit(repo, snapshot.commitSha)) return { status: "missing", detail: "snapshot commit not found" };
  tryGit(repo, ["worktree", "prune"]);
  const registered = repo(["worktree", "list", "--porcelain"])
    .split("\n")
    .some((line) => line === `worktree ${worktreePath}`);
  if (registered) return { status: "worktree-exists", worktreePath };
  const branchSha = resolveCommit(repo, `refs/heads/${branch}`);
  if (branchSha && branchSha !== snapshot.headSha) return { status: "branch-moved", branch, branchSha, headSha: snapshot.headSha };
  repo(branchSha ? ["worktree", "add", "--quiet", worktreePath, branch] : ["worktree", "add", "--quiet", "-b", branch, worktreePath, snapshot.headSha]);
  const wt = gitAt(worktreePath);
  restoreWorktreeTree(wt, snapshot.commitSha);
  wt(["read-tree", `${snapshot.indexSha}^{tree}`]);
  return { status: "ok", worktreePath, branch, createdBranch: !branchSha };
}
