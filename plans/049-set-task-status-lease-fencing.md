# Plan 049: Lease fencing for `setTaskStatus`

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

- Priority: P3
- Size: S
- Risk: LOW
- Dependencies: none
- Planned at: `improve` backend audit, 2026-11-13

## Why this is needed

Every worker write that changes task state is fenced to the worker that owns the
lease. `setTaskStatus` is the exception: it takes no `workerId`, checks no
lease, and accepts any `taskStatus` value. Its only guard is the terminal-status
absorbing rule. A worker that no longer owns a task — because recovery requeued
it and another worker claimed it — can still drive its status, which is exactly
what the module's own fencing doc says must never happen
(`apps/api/convex/orchestration.ts:120-138`).

## Target behaviour

| Caller | Before | After |
| --- | --- | --- |
| The worker that owns the task lease | `setTaskStatus` applies | unchanged |
| A displaced worker (lost the lease) | `setTaskStatus` applies | refused as a value (`false` / `lease_lost`), the caller stops |
| A task that is already terminal | refused (unchanged) | refused (unchanged) |

## Current state

- `apps/api/convex/orchestration.ts:1898` — `setTaskStatus` args are
  `{ taskId, status }`; the handler reads the task, applies the terminal guard,
  then patches the status. It never calls `holdsTaskLease`.
- `apps/api/convex/orchestration.ts:139` — `holdsTaskLease(ctx, taskId,
  workerId, options)`: strict by design, a write with no `workerId` is refused.
- `apps/api/convex/orchestration.ts:1803` — `completeTask` is the model: takes
  `workerId`, fences, and returns `{ applied: false, reason }` on a late write.
- `apps/api/convex/worker.ts:717` — the token-gated action forwards only
  `{ taskId, status }` to the internal mutation.
- `packages/worker/src/workerApi.ts:414` — `WorkerApi.setTaskStatus` forwards
  the input unchanged.
- `packages/worker/src/services/runner/resume.ts:102` — the only caller:
  `setTaskStatus({ taskId, status: "running" })` after
  `orchestration.claimResumableTask` (`apps/api/convex/orchestration.ts:1602`)
  set this worker's lease.
- `apps/api/convex/securityInvariants.test.ts` — protects the terminal-status
  guard; the lease fence is not covered there today.

## Decisions that must not change during execution

- The terminal-status absorbing rule stays: a terminal task is never
  resurrected, and rewriting the same terminal status stays allowed.
- The worker-facing action stays token-gated (`withoutToken`); this change
  adds no new action and no new auth path.
- The refusal shape stays a value, never a thrown error, matching
  `completeTask` / `pauseForInput`; the worker branches on it.
- Local single-user mode is untouched (this is worker-to-backend, not viewer
  authorization).

## Steps

### Step 1: Add `workerId` to the internal mutation and fence it

In `apps/api/convex/orchestration.ts` `setTaskStatus`:

- add `workerId: v.optional(v.string())` to `args` (optional so the validator
  stays additive; the handler treats a missing id as a lost lease);
- after the terminal guard, return `false` when
  `!(await holdsTaskLease(ctx, args.taskId, args.workerId))`;
- keep the `needs_approval` + `pausedBy` drain branch and the status patch as
  they are.

**Check**: `npm run --workspace=@fhara/api typecheck` → clean.

### Step 2: Forward the id from the worker action

In `apps/api/convex/worker.ts` `setTaskStatus`, add
`workerId: v.optional(v.string())` to `args`, pass it through to
`internal.orchestration.setTaskStatus`, and **return** the mutation's boolean
result (today the handler discards it, so the worker cannot branch).

### Step 3: Send the id from the worker

- `packages/worker/src/services/runner/resume.ts:102` — pass
  `workerId: deps.workerId` and stop the run when the write is refused:
  `const applied = await deps.api.setTaskStatus({ taskId, workerId: deps.workerId, status: "running" }); if (!applied) return;`
  (the task is terminal or no longer this worker's; the run must not execute).
- If `WorkerApi.setTaskStatus` narrows its input/return type, widen it with the
  same optional field and the boolean result
  (`packages/worker/src/workerApi.ts:414`).

**Check**: `npm run --workspace=@fhara/worker typecheck` → clean.

### Step 4: Extend the invariant test

In `apps/api/convex/securityInvariants.test.ts`, add a case: seed a task owned
by `worker-a` with a live lease, then call
`internal.orchestration.setTaskStatus` with `workerId: "worker-b"` (and with no
`workerId`) → `false`, status unchanged; with `workerId: "worker-a"` → `true`,
status applied. A terminal task still refuses a different status.

**Check**: `npx --workspace=@fhara/api vitest run convex/securityInvariants.test.ts`
→ all pass.

## Test plan

- Invariant: only the lease owner may move a task's status.
- Negative: displaced worker (different id) refused; no id refused; terminal
  task refused; expired lease refused.
- Positive: the owner applies `running` after a resume claim.

## Completion criteria

- [ ] `setTaskStatus` takes `workerId` and refuses without a held lease.
- [ ] The worker passes `deps.workerId` on the resume path.
- [ ] `securityInvariants.test.ts` covers owner / displaced / no-id / terminal.
- [ ] `npm run --workspace=@fhara/api typecheck` and
      `npm run --workspace=@fhara/worker typecheck` are clean.
- [ ] `plans/README.md` row updated.

## STOP conditions

- A non-negotiable rule in `AGENTS.md` must change.
- The resume path legitimately needs to write a status while not holding the
  lease (it does not today: `claimResumableTask` sets the lease first).
- A check fails twice after a reasonable fix.
- The change needs work outside this repository.
