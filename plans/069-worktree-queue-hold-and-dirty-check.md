# Plan 069: Persistent worktree queue hold and precise dirty check

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

- Priority: P1
- Size: M
- Risk: MEDIUM
- Dependencies: 068 (local SQLite backend)
- Planned at: commit `c1d0fc37af`, 2026-11-23

## Why this is needed

A failed worktree setup currently fails only the task that attempted it. Every
other queued task for the project remains claimable and can silently run in the
real checkout, which mixes worktree and non-worktree execution. The hold must be
persisted so a worker restart cannot lose it, and only an explicit user action
may release it. Separately, the auto-isolation dirty check treats install output
such as `package-lock.json` as a user edit, so worktree isolation is switched off
after an ordinary install.

## Target behaviour

| After this change | Today |
| --- | --- |
| A failed worktree setup holds the project's queued work; the failing task ends failed with a reason that says how to resume | Only the failing task ends failed; other queued tasks still run |
| The hold survives a worker restart (stored in SQLite through the task/project schema) | No persisted hold |
| `taskControl.resume` clears the project hold and every held queued task | Resume does not know about a queue hold |
| The dirty check ignores `node_modules`, lockfiles and build output, but counts ignored generated/declaration/env inputs that checks actually read | Lockfile edits count as dirty; ignored check inputs are not inspected |

## Current state

- `packages/worker/src/services/taskRunner.ts:164-202` creates the worktree and
  fails only the current task when `createBranch` throws.
- `apps/api/functions/lib/claimQueue.ts:16-24` scans queued tasks and skips only
  legacy direct and automation-held tasks.
- `apps/api/functions/schema.ts:416-531` defines tasks and their indexes;
  `apps/api/functions/schema.ts:266` defines projects.
- `packages/runtime/src/db.ts:296-320` adds new schema fields additively to an
  existing SQLite file.
- `apps/api/functions/taskControl.ts:93-143` handles explicit resume; it only
  understands `paused` tasks.
- `apps/web/components/TaskHoldNotice.tsx:11-38` renders provider/repo holds and
  their Resume button.
- `packages/worker/src/services/runner/isolationPolicy.ts:68-109` parses
  `git status --porcelain` and filters generated paths and untracked lockfiles.

## Decisions that must not change during execution

1. The hold is project-wide, not per task. A new task queued while the hold is
   active is not claimed until the user resumes the queue.
2. The failing task still ends `failed`; the hold applies to queued work. This
   keeps terminal semantics unchanged.
3. Only a user mutation releases the hold. No worker, watchdog, scheduler or
   automatic backoff may clear it.
4. Schema additions are optional and additive. The legacy column remains
   readable; no destructive migration.
5. Worker-facing writes keep the `workerToken` action wrapper and
   `assertServiceToken`.
6. The dirty check never counts `node_modules` or any path under it. It counts
   ignored files only when they match generated/declaration/env check inputs.

## Steps

### Step 1: Persist the queue hold

Add optional `worktreeQueueHold` to `projects` and optional `queueHeld` to
`tasks` in `apps/api/functions/schema.ts`. Add an internal mutation in
`apps/api/functions/orchestration.ts` that resolves the project from the task,
sets the project hold, marks queued tasks `queueHeld: true`, and emits task
events. Add a token-gated wrapper in `apps/api/functions/worker.ts` and a
`WorkerApi.holdWorktreeQueue` method.

**Check**: `npm run --workspace=@fhara/api typecheck` and
`npm run --workspace=@fhara/worker typecheck` → no errors.

### Step 2: Skip held queued work and make resume explicit

Update `apps/api/functions/lib/claimQueue.ts` to skip tasks with
`queueHeld === true` or a project `worktreeQueueHold`. Extend
`apps/api/functions/taskControl.ts#resume` to clear both when a task belongs to
a held queue, emitting `task.resumed`. Update
`packages/worker/src/services/taskRunner.ts` so a worktree setup failure calls
the hold API before ending the task failed, with resume guidance in the error.

**Check**: `npx --workspace=@fhara/api vitest run worktreeQueue.test.ts`
→ hold, claim skip, restart persistence and explicit resume pass.

### Step 3: Surface the hold in the UI

Teach `apps/web/components/TaskHoldNotice.tsx` to render a queue hold with a
Resume button, and include `queueHeld` in `BoardTaskCard`'s held flag. Use the
existing `taskControl.resume` mutation; do not add a second resume path.

**Check**: `npm run --workspace=@fhara/web typecheck` → no errors.

### Step 4: Make the dirty check precise

In `packages/worker/src/services/runner/isolationPolicy.ts`, ignore lockfiles in
all statuses, parse ignored paths from
`git ls-files -z --others --ignored --exclude-standard --directory`, and count
only ignored check inputs (`\.(generated|astro)/`, `.d.ts`, `.env*`) outside
`node_modules`. Keep the existing tracked/untracked status check.

**Check**: `npx --workspace=@fhara/worker vitest run tests/isolationPolicy.test.ts`
→ all dirty-check tests pass, including the new node_modules/ignored-input cases.

## Test plan

- A held project's queued tasks are not claimed, including a task queued after
  the hold was set.
- Explicit resume clears the project hold and every `queueHeld` flag; the next
  claim takes the oldest queued task.
- A non-worktree failure does not hold the queue.
- `node_modules`, lockfiles and build folders never make a checkout dirty.
- Ignored `.env`, `.d.ts` and `.generated/` files do make it dirty; other
  ignored files and anything under `node_modules` do not.

## Completion criteria

- `npm run --workspace=@fhara/api typecheck`
- `npm run --workspace=@fhara/worker typecheck`
- `npm run --workspace=@fhara/web typecheck`
- `npx --workspace=@fhara/api vitest run worktreeQueue.test.ts`
- `npx --workspace=@fhara/worker vitest run tests/isolationPolicy.test.ts`

## STOP conditions

- A non-negotiable rule in `AGENTS.md` must change.
- A schema change needs a destructive migration.
- A check fails twice after a reasonable fix.
- The change needs work outside this repository.
