# Plan 081 — short task branch names

- Date: 2026-11-23
- State: DONE (2026-11-23)

## Context

`makeTaskBranchName` builds `fhara/<taskIdForBranch(taskId)>/<title slug>`.
`taskIdForBranch` keeps up to 80 bytes of `tasks:<table>:<uuid>`, producing
branches like
`fhara/tasks-mwt5dxt5-e2a69e3a-6a2b-46bf-928c-a0721113c50d/add-a-brief-comment-to-src-about-tsx-say`.

Production only needs the short id to find this task's own worktrees
(`taskBranchPrefixes`); `parseTaskBranch` is not used to look a task up by
branch. The full id is stored on the task row, so a shorter deterministic id
is safe for new branches.

## Decision

1. New branches use `fhara/<12-hex-uuid-prefix>/<title slug>`, e.g.
   `fhara/e2a69e3a6a2b/add-a-brief-comment-to-src-about-tsx-say`.
2. Non-UUID task ids (tests, synthetic ids) keep their safe form, capped at
   24 chars, unchanged when shorter.
3. `taskBranchPrefixes` returns both the new short prefix and the legacy full
   prefix so existing worktrees are still found and cleaned up.
4. `parseTaskBranch` accepts both forms. Existing `task.branchName` values are
   never rewritten; only future branches change.

## Files

- `apps/api/functions/lib/taskBranch.ts`
- `packages/worker/tests/gitIdentity.test.ts`
- `packages/worker/tests/gitInitLane.test.ts` if needed
- Generated runtime bundle.

## STOP conditions

- Do not rewrite existing branch names or remote branches.
- Keep `git check-ref-format` safety: no colon, spaces or leading dash.
- Do not break worktree lookup for legacy long branches.

## Verification log

- `gitIdentity` + `gitInitLane` worker tests: 15/15 pass, including the legacy
  full-id prefix still being found for worktree cleanup.
- `codegen:offline` regenerated the runtime bundle; API and web typechecks pass.
- Existing branches and task rows are untouched; only newly created task
  branches use the short form.
