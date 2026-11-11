/**
 * Paradev A1: the branch patch worktreeNode.getDiff builds (lib/diffPatch.ts)
 * on a real temp repo. A user gitconfig with diff.noprefix=true (and
 * mnemonicPrefix) must not change the `diff --git a/… b/…` shape, a
 * non-ASCII path stays raw, and a patch over the budget is cut on a file
 * boundary with the truncation marker. The GitRun mirrors worktreeNode's
 * gitRunBounded: execFileSync with a maxBuffer, ENOBUFS kept as overflow.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildBranchPatch, type GitRun } from "@/api/convex/lib/diffPatch";

let repo: string;
let home: string;
let env: NodeJS.ProcessEnv;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8", env });
}

const run: GitRun = (args, maxBuffer) => {
  try {
    return { stdout: execFileSync("git", args, { cwd: repo, encoding: "utf-8", env, maxBuffer }), overflowed: false };
  } catch (err: any) {
    if (err?.code !== "ENOBUFS") throw err;
    return { stdout: String(err.stdout ?? ""), overflowed: true };
  }
};

const lines = (count: number, marker: string) => `${Array.from({ length: count }, (_, i) => `${marker} line ${i}`).join("\n")}\n`;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "fhara-branch-patch-"));
  home = mkdtempSync(join(tmpdir(), "fhara-branch-patch-home-"));
  // The hostile user config lives in a private HOME, so the real one is untouched.
  writeFileSync(
    join(home, ".gitconfig"),
    "[diff]\n\tnoprefix = true\n\tmnemonicPrefix = true\n[core]\n\tquotePath = true\n[user]\n\tname = t\n\temail = t@example.com\n",
  );
  env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" };
  git(["init", "-q"]);
  git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repo, "a.txt"), lines(200, "old"));
  writeFileSync(join(repo, "b.txt"), lines(200, "old"));
  git(["add", "."]);
  git(["commit", "-qm", "initial"]);
  git(["checkout", "-qb", "fhara/t/x"]);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("buildBranchPatch", () => {
  test("keeps a/ b/ prefixes under diff.noprefix and a raw non-ASCII path", () => {
    writeFileSync(join(repo, "a.txt"), lines(200, "new"));
    writeFileSync(join(repo, "café ü.txt"), "hello\n");
    git(["add", "."]);
    git(["commit", "-qm", "change"]);
    // The hostile config is live: a plain diff drops the prefixes.
    expect(git(["diff", "main..fhara/t/x"])).not.toContain("diff --git a/a.txt b/a.txt");

    const out = buildBranchPatch(run, "main", "fhara/t/x");
    expect(out.truncated).toBe(false);
    expect(out.patch).toContain("diff --git a/a.txt b/a.txt");
    expect(out.patch).toContain("diff --git a/café ü.txt b/café ü.txt");
    expect(out.patch).not.toContain("\\303");
    expect(out.files).toEqual([
      { path: "a.txt", status: "modified", additions: 200, deletions: 200, source: "branch" },
      { path: "café ü.txt", status: "added", additions: 1, deletions: 0, source: "branch" },
    ]);
  });

  test("lists a rename with its old path", () => {
    git(["mv", "b.txt", "b2.txt"]);
    git(["commit", "-qm", "rename"]);
    const out = buildBranchPatch(run, "main", "fhara/t/x");
    expect(out.files).toEqual([{ path: "b2.txt", oldPath: "b.txt", status: "renamed", additions: 0, deletions: 0, source: "branch" }]);
  });

  test("a patch over the budget is cut on a file boundary with a marker", () => {
    for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(repo, name), lines(400, "new"));
    git(["add", "."]);
    git(["commit", "-qm", "big"]);
    const full = buildBranchPatch(run, "main", "fhara/t/x");
    expect(full.truncated).toBe(false);
    const sections = full.patch.split(/(?=^diff --git )/m);
    expect(sections).toHaveLength(3);

    // Room for the first section and part of the second.
    const budget = Buffer.byteLength(sections[0]) + 100;
    const cut = buildBranchPatch(run, "main", "fhara/t/x", budget);
    expect(cut.truncated).toBe(true);
    expect(cut.patch.startsWith(sections[0])).toBe(true);
    expect(cut.patch).not.toContain("diff --git a/b.txt");
    expect(cut.patch.endsWith("\\ Fhara: diff truncated at " + budget + " bytes; later files are listed but not shown\n")).toBe(true);
    // The file list is bounded separately and stays whole.
    expect(cut.files.map((f) => f.path)).toEqual(["a.txt", "b.txt", "c.txt"]);

    // A budget exactly at a section boundary keeps that whole section.
    const exact = buildBranchPatch(run, "main", "fhara/t/x", Buffer.byteLength(sections[0] + sections[1]));
    expect(exact.patch.startsWith(sections[0] + sections[1])).toBe(true);
    expect(exact.patch).not.toContain("diff --git a/c.txt");
  });
});
