// Portions adapted from Paradev, formerly Superset (https://github.com/paradevai/paradev, cloned from github.com/superset-sh/superset @ ce98da26),
// apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/utils/getPRFlowState/getPRFlowState.test.ts
// (the getPRFlowState / selector cases). MIT License, Copyright (c) 2025-2026 Superset Inc.
// See THIRD_PARTY_NOTICES.md.
//
// Changed by Fhara (Paradev A1): vitest instead of bun:test, the cases
// re-targeted at getChangesFlowState's Fhara states, plus file-model cases.
import { describe, expect, test } from "vitest";
import {
  type ChangesPr,
  type ChangesPush,
  filesFromFileChanges,
  filesFromGitZ,
  getChangesFlowState,
  type GetChangesFlowStateInput,
  selectActionButton,
  selectPrLink,
  selectStatusLabel,
} from "./changeset";

const pr = (overrides: Partial<ChangesPr> = {}): ChangesPr => ({
  number: 42,
  url: "https://github.com/org/repo/pull/42",
  title: "Feature X",
  state: "open",
  ciChecks: [],
  ...overrides,
});

const push = (overrides: Partial<ChangesPush> = {}): ChangesPush => ({ status: "ready", pr: null, ...overrides });

const input = (overrides: Partial<GetChangesFlowStateInput> = {}): GetChangesFlowStateInput => ({
  proposedCount: 0,
  branchName: "fhara/t/feature-x",
  worktreePath: "/repo/.moagent-worktrees/p/fhara/t/feature-x",
  push: null,
  isFixRunning: false,
  loadError: null,
  ...overrides,
});

describe("getChangesFlowState", () => {
  test("error when load failed and no data", () => {
    expect(getChangesFlowState(input({ loadError: "boom" }))).toEqual({ kind: "error", pr: null, message: "boom" });
  });

  test("a load error with data keeps the data state", () => {
    expect(getChangesFlowState(input({ loadError: "boom", proposedCount: 2 })).kind).toBe("proposed");
  });

  test("fix-running overrides actionable states (Paradev busy)", () => {
    const p = pr();
    expect(getChangesFlowState(input({ push: push({ pr: p }), isFixRunning: true }))).toEqual({ kind: "fix-running", pr: p });
    expect(getChangesFlowState(input({ isFixRunning: true }))).toEqual({ kind: "fix-running", pr: null });
  });

  test("no-branch when nothing was proposed or committed", () => {
    expect(getChangesFlowState(input({ branchName: undefined, worktreePath: undefined }))).toEqual({ kind: "no-branch" });
    expect(getChangesFlowState(input())).toEqual({ kind: "no-branch" });
  });

  test("proposed before Accept", () => {
    expect(getChangesFlowState(input({ proposedCount: 3 }))).toEqual({ kind: "proposed", fileCount: 3 });
  });

  test("worktree-gone: a branch without its worktree", () => {
    expect(getChangesFlowState(input({ worktreePath: undefined }))).toEqual({ kind: "worktree-gone", push: null });
    const p = push();
    expect(getChangesFlowState(input({ worktreePath: undefined, push: p }))).toEqual({ kind: "worktree-gone", push: p });
  });

  test("committed after recordTaskCommit", () => {
    const p = push();
    expect(getChangesFlowState(input({ proposedCount: 3, push: p }))).toEqual({ kind: "committed", push: p });
  });

  test("pushed without a PR", () => {
    const p = push({ status: "pushed" });
    expect(getChangesFlowState(input({ push: p }))).toEqual({ kind: "pushed", push: p });
  });

  test("pr-exists when a PR is present, even after the worktree went", () => {
    const p = pr();
    const state = getChangesFlowState(input({ worktreePath: undefined, push: push({ status: "pushed", pr: p }) }));
    expect(state.kind).toBe("pr-exists");
    if (state.kind === "pr-exists") expect(state.pr).toBe(p);
  });

  test("error when the push failed", () => {
    expect(getChangesFlowState(input({ push: push({ status: "failed", error: "rejected" }) }))).toEqual({
      kind: "error",
      pr: null,
      message: "rejected",
    });
  });
});

describe("selectActionButton", () => {
  test("committed (ready) → open-pr", () => {
    expect(selectActionButton({ kind: "committed", push: push() })).toEqual({ kind: "open-pr" });
  });
  test("committed with a push in flight → hidden", () => {
    expect(selectActionButton({ kind: "committed", push: push({ status: "requested" }) })).toEqual({ kind: "hidden" });
  });
  test("fix-running → hidden", () => {
    expect(selectActionButton({ kind: "fix-running", pr: null })).toEqual({ kind: "hidden" });
  });
  test("error → retry", () => {
    expect(selectActionButton({ kind: "error", pr: null, message: "x" })).toEqual({ kind: "retry" });
  });
  test("pr-exists → refresh-pr", () => {
    expect(selectActionButton({ kind: "pr-exists", pr: pr(), push: push() })).toEqual({ kind: "refresh-pr" });
  });
  test("no-branch / worktree-gone → disabled with reason", () => {
    expect(selectActionButton({ kind: "no-branch" })).toEqual({ kind: "disabled", reason: "no-branch" });
    expect(selectActionButton({ kind: "worktree-gone", push: null })).toMatchObject({ kind: "disabled", reason: "worktree-gone" });
  });
});

describe("selectPrLink", () => {
  test("none when no PR", () => {
    expect(selectPrLink({ kind: "committed", push: push() })).toEqual({ kind: "none" });
  });
  test("open PR link", () => {
    const p = pr({ number: 9 });
    expect(selectPrLink({ kind: "pr-exists", pr: p, push: push() })).toEqual({ kind: "pr-link", state: "open", number: 9, url: p.url });
  });
  test("draft / merged / closed PR links", () => {
    for (const state of ["draft", "merged", "closed"] as const) {
      expect(selectPrLink({ kind: "pr-exists", pr: pr({ state }), push: push() })).toMatchObject({ state });
    }
  });
  test("PR link still visible while a fix runs or after an error", () => {
    expect(selectPrLink({ kind: "fix-running", pr: pr() })).toMatchObject({ kind: "pr-link" });
    expect(selectPrLink({ kind: "error", pr: pr(), message: "x" })).toMatchObject({ kind: "pr-link" });
  });
});

describe("selectStatusLabel", () => {
  test("proposed singular / plural", () => {
    expect(selectStatusLabel({ kind: "proposed", fileCount: 1 })).toBe("1 proposed file");
    expect(selectStatusLabel({ kind: "proposed", fileCount: 3 })).toBe("3 proposed files");
  });
  test("committed variants", () => {
    expect(selectStatusLabel({ kind: "committed", push: push() })).toBe("Committed, not pushed");
    expect(selectStatusLabel({ kind: "committed", push: push({ status: "requested" }) })).toBe("Push requested");
    expect(selectStatusLabel({ kind: "committed", push: push({ status: "pushing" }) })).toBe("Pushing");
  });
  test("PR states", () => {
    expect(selectStatusLabel({ kind: "pr-exists", pr: pr(), push: push() })).toBe("Open");
    expect(selectStatusLabel({ kind: "pr-exists", pr: pr({ state: "merged" }), push: push() })).toBe("Merged");
  });
  test("other states", () => {
    expect(selectStatusLabel({ kind: "no-branch" })).toBe("No changes yet");
    expect(selectStatusLabel({ kind: "worktree-gone", push: null })).toBe("Worktree removed");
    expect(selectStatusLabel({ kind: "fix-running", pr: null })).toBe("Agent working…");
  });
});

describe("file model", () => {
  test("filesFromFileChanges keeps the newest row per path and counts lines", () => {
    const files = filesFromFileChanges([
      { filePath: "b.ts", changeType: "modified", diff: "--- a/b.ts\n+++ b/b.ts\n@@\n-x\n+y\n", _creationTime: 1 },
      { filePath: "a.ts", changeType: "new", diff: "+1\n+2\n", _creationTime: 2 },
      { filePath: "b.ts", changeType: "deleted", diff: "-y\n", _creationTime: 3 },
    ]);
    expect(files).toEqual([
      { path: "a.ts", status: "added", additions: 2, deletions: 0, source: "proposed" },
      { path: "b.ts", status: "deleted", additions: 0, deletions: 1, source: "proposed" },
    ]);
  });

  test("filesFromGitZ parses renames, binaries and odd paths", () => {
    const nameStatus = ["M", "src/a.ts", "R087", "old name.ts", "new\tname.ts", "A", "img.png", ""].join("\0");
    const numstat = ["3\t1\tsrc/a.ts", "2\t2\t", "old name.ts", "new\tname.ts", "-\t-\timg.png", ""].join("\0");
    expect(filesFromGitZ(nameStatus, numstat)).toEqual([
      { path: "src/a.ts", status: "modified", additions: 3, deletions: 1, source: "branch" },
      { path: "new\tname.ts", oldPath: "old name.ts", status: "renamed", additions: 2, deletions: 2, source: "branch" },
      { path: "img.png", status: "added", additions: 0, deletions: 0, isBinary: true, source: "branch" },
    ]);
  });
});
