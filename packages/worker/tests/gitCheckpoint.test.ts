/**
 * GOAT G5: hidden-ref checkpoints on real temp repos.
 * - capture leaves HEAD, the branch, the real index and `git status` as they were;
 * - the checkpoint tree is the whole worktree (edits, deletions, untracked, not ignored);
 * - numstat parse (vendor/goat/diffs.ts) with renames, on synthetic and real output;
 * - the worktree sweep (lib/checkpointRefs.ts removeTaskGitState) deletes the task's refs only;
 * - the N..M diff reuses lib/diffPatch.ts (buildBranchPatch) on checkpoint commits.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { captureCheckpoint } from "@/tools/gitCheckpoint";
import { parseTurnDiffFilesFromNumstat } from "@/vendor/goat/diffs";
import { checkpointRefName, listTaskCheckpointRefs, removeTaskGitState } from "@/api/convex/lib/checkpointRefs";
import { buildBranchPatch, type GitRun } from "@/api/convex/lib/diffPatch";
import { checkpointRecordArgs } from "@/services/runner/checkpoints";
import { CHECKPOINT_FILES_LIMIT } from "@/api/convex/lib/checkpointValidators";

const TASK = "k17abc123task";
let root: string;
let repo: string;

function git(args: string[], cwd = repo): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], {
    cwd,
    encoding: "utf-8",
  });
}

/** Raw bytes of the real index: read with no git command in between, since `git status` may refresh it. */
function indexBytes(cwd = repo): string {
  return readFileSync(join(git(["rev-parse", "--absolute-git-dir"], cwd).trim(), "index")).toString("base64");
}

function state(cwd = repo) {
  return {
    head: git(["rev-parse", "HEAD"], cwd),
    branch: git(["symbolic-ref", "HEAD"], cwd),
    index: git(["ls-files", "--stage"], cwd),
    staged: git(["diff", "--cached", "--name-status"], cwd),
    status: git(["status", "--porcelain=v1", "-uall"], cwd),
    refs: git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags"], cwd),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fhara-ckpt-"));
  repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, ".gitignore"), "ignored/\n*.log\n");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(repo, "gone.txt"), "delete me\n");
  writeFileSync(join(repo, "long.txt"), Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") + "\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("captureCheckpoint", () => {
  test("HEAD, branch, index and status are unchanged; the tree is the whole worktree", async () => {
    writeFileSync(join(repo, "a.txt"), "one\nTWO\nthree\nfour\n");
    writeFileSync(join(repo, "staged.txt"), "in the real index\n");
    git(["add", "staged.txt"]);
    writeFileSync(join(repo, "untracked.txt"), "new\n");
    unlinkSync(join(repo, "gone.txt"));
    writeFileSync(join(repo, "debug.log"), "ignored\n");
    const before = state();
    const rawBefore = indexBytes();

    const captured = await captureCheckpoint(repo, TASK);

    expect(indexBytes()).toBe(rawBefore);
    expect(state()).toEqual(before);
    expect(captured.n).toBe(1);
    expect(captured.ref).toBe(checkpointRefName(TASK, 1));
    expect(git(["rev-parse", captured.ref]).trim()).toBe(captured.commitSha);
    expect(captured.headSha).toBe(before.head.trim());
    expect(git(["rev-parse", `${captured.commitSha}^`]).trim()).toBe(captured.headSha);
    const tree = git(["ls-tree", "-r", "--name-only", captured.commitSha]).trim().split("\n");
    expect(tree).toEqual([".gitignore", "a.txt", "long.txt", "staged.txt", "untracked.txt"]);
    expect(git(["show", `${captured.commitSha}:a.txt`])).toBe("one\nTWO\nthree\nfour\n");
    expect(captured.files.map((f) => f.path)).toEqual(["a.txt", "gone.txt", "staged.txt", "untracked.txt"]);
    expect(captured.files.find((f) => f.path === "a.txt")).toMatchObject({ additions: 2, deletions: 1 });
    // No temp index or lock left in the git dir.
    expect(readdirSync(join(repo, ".git")).filter((name) => name.startsWith("fhara-checkpoint-index"))).toEqual([]);
  });

  test("numbers advance, files are measured since the previous checkpoint, renames are detected", async () => {
    const first = await captureCheckpoint(repo, TASK);
    renameSync(join(repo, "long.txt"), join(repo, "renamed.txt"));
    writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\nmore\n");
    const second = await captureCheckpoint(repo, TASK);
    expect(first.files).toEqual([]);
    expect(second.n).toBe(2);
    expect(second.previousSha).toBe(first.commitSha);
    expect(second.files).toEqual([
      { path: "a.txt", additions: 1, deletions: 0 },
      { path: "renamed.txt", previousPath: "long.txt", additions: 0, deletions: 0 },
    ]);
    expect(listTaskCheckpointRefs((args) => git(args), TASK)).toEqual([
      checkpointRefName(TASK, 1),
      checkpointRefName(TASK, 2),
    ]);
  });

  test("an unborn branch is captured against the empty tree", async () => {
    const fresh = join(root, "fresh");
    execFileSync("git", ["init", "-q", "-b", "main", fresh]);
    writeFileSync(join(fresh, "x.txt"), "x\n");
    const captured = await captureCheckpoint(fresh, TASK);
    expect(captured.headSha).toBeNull();
    expect(captured.files).toEqual([{ path: "x.txt", additions: 1, deletions: 0 }]);
    expect(() => git(["rev-parse", "--verify", "-q", "HEAD"], fresh)).toThrow();
  });
});

describe("parseTurnDiffFilesFromNumstat", () => {
  test("plain, binary and rename records, sorted by path", () => {
    const numstat = ["3\t1\tsrc/b.ts", "-\t-\timg.png", "0\t0\t", "old/name.ts", "new/name.ts", "2\t0\ta.ts", ""].join("\0");
    expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
      { path: "a.ts", additions: 2, deletions: 0 },
      { path: "img.png", additions: 0, deletions: 0 },
      { path: "new/name.ts", previousPath: "old/name.ts", additions: 0, deletions: 0 },
      { path: "src/b.ts", additions: 3, deletions: 1 },
    ]);
  });

  test("empty output", () => {
    expect(parseTurnDiffFilesFromNumstat("")).toEqual([]);
  });
});

describe("worktree sweep", () => {
  test("removes the task worktree and its checkpoint refs; the branch and other tasks' refs stay", async () => {
    const wt = join(root, "wts", "task");
    git(["worktree", "add", "-q", "-b", `fhara/${TASK}/demo`, wt, "main"]);
    writeFileSync(join(wt, "a.txt"), "changed in the worktree\n");
    const captured = await captureCheckpoint(wt, TASK);
    // Refs are shared: the main checkout sees the worktree's checkpoint.
    expect(git(["rev-parse", captured.ref]).trim()).toBe(captured.commitSha);
    const other = await captureCheckpoint(repo, "otherTask");
    const mainBefore = state();

    const main = resolve(repo);
    const result = removeTaskGitState((args) => git(args), TASK, (path) => resolve(path) === main);

    expect(result.removed.map((path) => resolve(path))).toEqual([resolve(wt)]);
    expect(result.refsDeleted).toEqual([captured.ref]);
    expect(existsSync(wt)).toBe(false);
    expect(listTaskCheckpointRefs((args) => git(args), TASK)).toEqual([]);
    expect(git(["rev-parse", other.ref]).trim()).toBe(other.commitSha);
    expect(git(["branch", "--list", `fhara/${TASK}/demo`]).trim()).toContain(`fhara/${TASK}/demo`);
    expect(state()).toEqual(mainBefore);
  });
});

describe("checkpoint N..M diff", () => {
  test("buildBranchPatch on two checkpoint commits lists the rename and bounds the patch", async () => {
    const first = await captureCheckpoint(repo, TASK);
    renameSync(join(repo, "long.txt"), join(repo, "moved.txt"));
    writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\nafter\n");
    const second = await captureCheckpoint(repo, TASK);
    const run: GitRun = (args, maxBuffer) => ({ stdout: execFileSync("git", args, { cwd: repo, encoding: "utf-8", maxBuffer }), overflowed: false });
    const out = buildBranchPatch(run, first.commitSha, second.commitSha);
    expect(out.truncated).toBe(false);
    expect(out.patch).toContain("diff --git a/a.txt b/a.txt");
    expect(out.patch).toContain("rename from long.txt");
    const moved = out.files.find((file) => file.path === "moved.txt");
    expect(moved).toBeTruthy();
    expect(JSON.stringify(moved)).toContain("long.txt");
  });
});

describe("checkpointRecordArgs", () => {
  test("caps the stored files and flags the rest", () => {
    const files = Array.from({ length: CHECKPOINT_FILES_LIMIT + 5 }, (_, i) => ({ path: `f${i}`, additions: 1, deletions: 0 }));
    const args = checkpointRecordArgs(TASK, {
      n: 3, ref: checkpointRefName(TASK, 3), commitSha: "c".repeat(40), treeSha: "t".repeat(40),
      headSha: null, previousSha: null, files, additions: files.length, deletions: 0,
    }, "subtask", "impl-1");
    expect(args.files).toHaveLength(CHECKPOINT_FILES_LIMIT);
    expect(args.filesTruncated).toBe(true);
    expect(args.filesChanged).toBe(CHECKPOINT_FILES_LIMIT + 5);
    expect(args).not.toHaveProperty("headSha");
    expect(args.subtaskKey).toBe("impl-1");
  });
});
