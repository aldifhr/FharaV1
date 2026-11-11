/**
 * GOAT G6 on real temp repos (lib/checkpointRestore.ts):
 * - restore leaves the tree identical to the checkpoint, including deleted,
 *   untracked, ignored and tracked-ignored files (multi-pass clean), HEAD
 *   rewound to the checkpoint's base; preserved caches stay;
 * - a pushed branch refuses restore and offers a revert commit, which adds
 *   history instead;
 * - the sweep snapshots the worktree before removing it (and keeps it when
 *   the snapshot fails), the snapshot restores it, and retention prunes old
 *   snapshot refs only.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { captureCheckpoint } from "@/tools/gitCheckpoint";
import { listTaskCheckpointRefs, removeTaskGitState } from "@/api/convex/lib/checkpointRefs";
import {
  captureWorktreeSnapshot,
  listWorktreeSnapshots,
  pruneWorktreeSnapshots,
  restoreToCheckpoint,
  restoreWorktreeSnapshot,
  revertCommitToCheckpoint,
  SNAPSHOT_RETENTION_MS,
} from "@/api/convex/lib/checkpointRestore";

const TASK = "k17abc123task";
const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid"];
let root: string;
let repo: string;

function git(args: string[], cwd = repo, env?: Record<string, string>): string {
  return execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf-8", env: { ...process.env, ...env } });
}
const gitAt = (cwd: string) => (args: string[]) => git(args, cwd);

/** Every file under `dir` (not .git) with its content: the tree as the user sees it. */
function snapshotFs(dir: string, skip: (rel: string) => boolean = () => false): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const rel = relative(dir, full);
      if (name === ".git" || skip(rel)) continue;
      if (lstatSync(full).isDirectory()) walk(full);
      else out[rel] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

const write = (dir: string, rel: string, text: string) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), text);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fhara-restore-"));
  repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  write(repo, ".gitignore", "build/\n*.log\nnode_modules/\n.env\n");
  write(repo, "a.txt", "one\n");
  write(repo, "gone.txt", "delete me\n");
  write(repo, "keep.log", "tracked although ignored\n");
  git(["add", "-A"]);
  git(["add", "-f", "keep.log"]);
  git(["commit", "-q", "-m", "init"]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("restoreToCheckpoint", () => {
  test("the tree becomes identical to the checkpoint: deleted, untracked and ignored files", async () => {
    write(repo, "a.txt", "one\ntwo\n");
    write(repo, "new.txt", "untracked at checkpoint\n");
    write(repo, "src/deep/file.ts", "export {}\n");
    const cp = await captureCheckpoint(repo, TASK);
    const expected = snapshotFs(repo);

    // After the checkpoint: edits, deletions (incl. a tracked-ignored file),
    // a committed change, new untracked and ignored files, a nested repo.
    write(repo, "a.txt", "changed\n");
    unlinkSync(join(repo, "gone.txt"));
    unlinkSync(join(repo, "keep.log"));
    rmSync(join(repo, "src"), { recursive: true });
    write(repo, "later.txt", "x\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "apply"]);
    write(repo, "stray/dir/f.txt", "untracked\n");
    write(repo, "build/out.js", "ignored output\n");
    write(repo, "debug.log", "ignored\n");
    execFileSync("git", ["init", "-q", join(repo, "nested")]);
    write(repo, "nested/x.txt", "nested repo\n");
    write(repo, "node_modules/dep/index.js", "kept cache\n");
    write(repo, ".env", "SECRET=kept\n");

    const result = restoreToCheckpoint(gitAt(repo), { commitSha: cp.commitSha, headSha: cp.headSha! });

    expect(result).toEqual({ status: "ok", headSha: cp.headSha, rewound: true });
    expect(git(["rev-parse", "HEAD"]).trim()).toBe(cp.headSha);
    expect(git(["symbolic-ref", "HEAD"]).trim()).toBe("refs/heads/main");
    expect(snapshotFs(repo, (rel) => rel.startsWith("node_modules") || rel === ".env")).toEqual(expected);
    expect(existsSync(join(repo, "nested"))).toBe(false);
    expect(existsSync(join(repo, "build"))).toBe(false);
    expect(readFileSync(join(repo, "node_modules/dep/index.js"), "utf8")).toBe("kept cache\n");
    expect(readFileSync(join(repo, ".env"), "utf8")).toBe("SECRET=kept\n");
    // The index equals HEAD; the worktree tree is the checkpoint's tree.
    expect(git(["diff", "--cached", "--name-only"])).toBe("");
    const wtTree = (() => {
      const index = join(root, "verify-index");
      git(["read-tree", "HEAD"], repo, { GIT_INDEX_FILE: index });
      git(["add", "-A"], repo, { GIT_INDEX_FILE: index });
      return git(["write-tree"], repo, { GIT_INDEX_FILE: index }).trim();
    })();
    expect(wtTree).toBe(cp.treeSha);
  });

  test("a pushed branch refuses restore and offers a revert commit, which only adds history", async () => {
    const remote = join(root, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    git(["remote", "add", "origin", remote]);
    git(["checkout", "-q", "-b", "fhara/k17abc123task/x"]);
    write(repo, "a.txt", "checkpointed\n");
    const cp = await captureCheckpoint(repo, TASK);
    write(repo, "a.txt", "applied\n");
    git(["commit", "-q", "-am", "apply"]);
    git(["push", "-q", "origin", "HEAD"]);
    const pushedHead = git(["rev-parse", "HEAD"]).trim();
    write(repo, "scratch.txt", "after push\n");

    const refused = restoreToCheckpoint(gitAt(repo), { commitSha: cp.commitSha, headSha: cp.headSha! });
    expect(refused).toEqual({ status: "pushed", remoteRef: "origin/fhara/k17abc123task/x", offer: "revert-commit" });
    expect(git(["rev-parse", "HEAD"]).trim()).toBe(pushedHead);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("applied\n");
    expect(existsSync(join(repo, "scratch.txt"))).toBe(true);

    // A push row in Fhara refuses even with no remote-tracking ref.
    const local = join(root, "local");
    execFileSync("git", ["clone", "-q", repo, local]);
    expect(restoreToCheckpoint(gitAt(local), { commitSha: git(["rev-parse", "HEAD"], local).trim() }, { pushedInFhara: true }).status).toBe("pushed");

    const reverted = revertCommitToCheckpoint(gitAt(repo), { commitSha: cp.commitSha, n: cp.n }, IDENTITY);
    expect(reverted.status).toBe("ok");
    expect(git(["rev-parse", "HEAD~1"]).trim()).toBe(pushedHead);
    expect(git(["rev-parse", "HEAD^{tree}"]).trim()).toBe(cp.treeSha);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("checkpointed\n");
    expect(existsSync(join(repo, "scratch.txt"))).toBe(false);
    expect(git(["status", "--porcelain"])).toBe("");
    expect(revertCommitToCheckpoint(gitAt(repo), { commitSha: cp.commitSha, n: cp.n }, IDENTITY).status).toBe("unchanged");
  });

  test("a missing checkpoint commit is reported, nothing changes", () => {
    const before = snapshotFs(repo);
    expect(restoreToCheckpoint(gitAt(repo), { commitSha: "f".repeat(40) }).status).toBe("missing");
    expect(snapshotFs(repo)).toEqual(before);
  });
});

describe("snapshot before the worktree sweep", () => {
  function addTaskWorktree(): string {
    const wt = join(root, "wts", "task");
    git(["worktree", "add", "-q", "-b", `fhara/${TASK}/fix`, wt]);
    return wt;
  }
  const snapDeps = (wt: string) => ({
    git: (args: string[], env?: Record<string, string>) => git(args, wt, env),
    removeFile: (file: string) => rmSync(file, { force: true }),
  });

  test("a swept worktree is restorable from its snapshot: tree, index and branch", async () => {
    const wt = addTaskWorktree();
    write(wt, "a.txt", "work in progress\n");
    write(wt, "staged.txt", "staged only\n");
    git(["add", "staged.txt"], wt);
    unlinkSync(join(wt, "gone.txt"));
    write(wt, "untracked/u.txt", "untracked\n");
    write(wt, "build/x.js", "ignored, not kept\n");
    await captureCheckpoint(wt, TASK);
    const expectedFs = snapshotFs(wt, (rel) => rel.startsWith("build"));
    const expectedIndex = git(["ls-files", "--stage"], wt);
    const head = git(["rev-parse", "HEAD"], wt).trim();
    const main = resolve(repo);

    const taken: string[] = [];
    const swept = removeTaskGitState(gitAt(repo), TASK, (p) => resolve(p) === main, (p) => {
      taken.push(captureWorktreeSnapshot(snapDeps(p), TASK, Date.now(), { worktreePath: p }).ref);
    });
    expect(swept.kept).toEqual([]);
    expect(swept.removed.map((p) => resolve(p))).toEqual([resolve(wt)]);
    expect(existsSync(wt)).toBe(false);
    expect(listTaskCheckpointRefs(gitAt(repo), TASK)).toEqual([]);

    const snapshots = listWorktreeSnapshots(gitAt(repo), TASK);
    expect(snapshots.map((s) => s.ref)).toEqual(taken);
    expect(snapshots[0]).toMatchObject({ headSha: head, branch: `fhara/${TASK}/fix`, worktreePath: wt });

    const restored = restoreWorktreeSnapshot(gitAt, repo, snapshots[0]!);
    expect(restored).toEqual({ status: "ok", worktreePath: wt, branch: `fhara/${TASK}/fix`, createdBranch: false });
    expect(snapshotFs(wt)).toEqual(expectedFs);
    expect(git(["ls-files", "--stage"], wt)).toBe(expectedIndex);
    expect(git(["rev-parse", "HEAD"], wt).trim()).toBe(head);
    expect(restoreWorktreeSnapshot(gitAt, repo, snapshots[0]!).status).toBe("worktree-exists");
  });

  test("restore refuses a moved branch and re-creates a deleted one", () => {
    const wt = addTaskWorktree();
    write(wt, "a.txt", "snap\n");
    const snap = captureWorktreeSnapshot(snapDeps(wt), TASK, 1_000, { worktreePath: wt });
    git(["worktree", "remove", "--force", wt]);
    git(["commit", "-q", "--allow-empty", "-m", "moved"], repo);
    git(["branch", "-f", `fhara/${TASK}/fix`, "main"]);
    expect(restoreWorktreeSnapshot(gitAt, repo, snap).status).toBe("branch-moved");
    git(["branch", "-D", `fhara/${TASK}/fix`]);
    const result = restoreWorktreeSnapshot(gitAt, repo, snap);
    expect(result).toMatchObject({ status: "ok", createdBranch: true });
    expect(readFileSync(join(wt, "a.txt"), "utf8")).toBe("snap\n");
  });

  test("a failed snapshot keeps the worktree and its checkpoint refs", async () => {
    const wt = addTaskWorktree();
    await captureCheckpoint(wt, TASK);
    const main = resolve(repo);
    const swept = removeTaskGitState(gitAt(repo), TASK, (p) => resolve(p) === main, () => {
      throw new Error("unmerged entries");
    });
    expect(swept).toEqual({ removed: [], refsDeleted: [], kept: [wt] });
    expect(existsSync(wt)).toBe(true);
    expect(listTaskCheckpointRefs(gitAt(repo), TASK)).toHaveLength(1);
  });

  test("retention prunes snapshot refs older than 7 days only, never checkpoint refs", async () => {
    const wt = addTaskWorktree();
    const now = Date.now();
    const old = captureWorktreeSnapshot(snapDeps(wt), TASK, now - SNAPSHOT_RETENTION_MS - 1, { worktreePath: wt });
    const fresh = captureWorktreeSnapshot(snapDeps(wt), TASK, now - 1000, { worktreePath: wt });
    const cp = await captureCheckpoint(wt, TASK);
    expect(pruneWorktreeSnapshots(gitAt(repo), now)).toEqual([old.ref]);
    expect(listWorktreeSnapshots(gitAt(repo), TASK).map((s) => s.ref)).toEqual([fresh.ref]);
    expect(listTaskCheckpointRefs(gitAt(repo), TASK)).toEqual([cp.ref]);
  });
});
