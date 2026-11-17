# 065 — Worktrees live under `~/.fhara/worktrees`, old branding cleaned

## Goal

Task worktrees no longer pollute the project folder. The default base moves
from `<repoRoot>/.moagent-worktrees` (old MOAgent branding, inside the user's
checkout) to `~/.fhara/worktrees/<project>/fhara/<taskId>/<slug>`. Legacy
worktrees at the old base keep being recognized and are auto-removed when
their task ends; the empty legacy folder disappears with them.

## Changes

1. `apps/api/convex/lib/repoReadiness.ts` — `worktreesBaseFor` gains a
   `homeDir` param (default `os.homedir()`); configured `projects.worktreesPath`
   still wins and stays repoRoot-relative. `WORKTREES_DIR` becomes
   `LEGACY_WORKTREES_DIR = ".moagent-worktrees"`.
2. `packages/worker/src/services/runner/isolationPolicy.ts` — dirty-file check
   ignores the legacy dir (until cleanup finishes) and `.fhara` (in case a
   project's `worktreesPath` opts back into the repo).
3. `packages/worker/src/tools/repoRead.ts` — the deny-read list keeps
   `.moagent-worktrees` and gains `.fhara`.
4. `apps/api/convex/worktreeNode.ts` — after removing a task's worktrees,
   best-effort empty-dir rmdir up the legacy base so it disappears with its
   last worktree. Comment updates.
5. Copy sweep: `open-in/route.ts` comment, `docs/mock-fixtures.md`,
   `taskBranch.ts` header comment. `layout.tsx` keeps the functional
   `'moagent'` localStorage migration key (it must match the old keys).
6. Tests: repoReadiness / isolationPolicy / worktreeNode fixtures updated.

## Definition of done

- Typechecks (api + worker) green; touched vitest files pass.
- A fresh task creates its worktree under `~/.fhara/worktrees/...` and the
  project folder shows no Fhara directories; legacy `.moagent-worktrees`
  (e.g. testproject) still recognized for merge/discard/cleanup.
