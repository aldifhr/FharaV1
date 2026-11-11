# Plan 046: Drain an aborted scheduler attempt before a retry

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

- Priority: P1
- Size: M
- Risk: MEDIUM
- Dependencies: —
- Planned at: commit `a277b41a71cfa5c8347673f75e6a6fdc3b5d51e1`, `2026-11-11`

## Why this is needed

A node attempt that hits its subtask timeout (or the stall watchdog) is
resolved by `Promise.race` the moment the timer fires. The timer aborts the
node's `AbortController`, but the scheduler does not wait for the executor's
promise to settle: the race's winner is returned, the node is deleted from
`running`, and the scheduler is free to start the retry on the next scan pass.
If the executor (or a subprocess it spawned) does not stop on the abort
signal, two attempts run at once and can stage changes to the same files —
overwriting each other, producing non-deterministic diffs and a task status
that does not reflect the live process.

## Target behaviour

- After a timeout or stall abort, the scheduler waits for the aborted
  executor to actually settle before the node may be retried.
- The wait is bounded by a grace period (`abortGraceMs`, default 5000).
- If the executor settles within the grace, the normal failure/retry path
  runs (the timeout/stall outcome is unchanged).
- If it does not settle within the grace, the node is failed as
  `execution-uncertain` and is never retried automatically.

## Current state

- `packages/worker/src/scheduler/dagScheduler.ts:393-405` — the timeout promise
  aborts the controller and resolves `failed` immediately.
- `packages/worker/src/scheduler/dagScheduler.ts:420-435` — the stall promise
  does the same.
- `packages/worker/src/scheduler/dagScheduler.ts:436-467` — the per-attempt
  IIFE races `execute(...)` against the timers; on `timedOut` it returns at
  once, dropping the still-pending `execute` promise.
- `packages/worker/src/scheduler/dagScheduler.ts:468` — `running.set(node.id, promise)`.
- `packages/worker/src/scheduler/dagScheduler.ts:700-708` — the main loop
  deletes the settled node from `running` and calls `settle`, which may
  re-queue it as `pending` for a retry.
- `packages/worker/tests/dagScheduler.test.ts:138-162` — "stops timed-out work
  before retrying" only asserts the executor settles; `retries: 0`, so it does
  not exercise the overlap.

## Decisions that must not change during execution

- The timeout/stall outcome text and status stay exactly as they are
  (`Subtask timed out after Nms`, the stall error); replan/retry classification
  depends on them.
- The retry budget, permanent/transient classification, `shouldRetryNode`
  veto, and dynamic-subtask admission are unchanged.
- Cancellation semantics are unchanged: one `AbortController` per task/attempt,
  and a cancelled run still drains before it ends.
- No change to the approval gate or the sandbox.

## Steps

### Step 1: Capture the executor promise and drain it on abort

In `start()` (`dagScheduler.ts:436-467`):

- Assign `execute(...)` to a local `execution` variable.
- Add a `stalled` flag set by the stall promise alongside `timedOut`.
- When the race is lost (`timedOut || stalled`), await `execution` bounded by
  `abortGraceMs`:
  - settled → return the normal timeout/stall outcome.
  - not settled → return the same outcome plus `executionUncertain: true`.
- Clear the grace timer when the executor settles first.

Add `abortGraceMs?: number` to `SchedulerHooks` (default 5000).

**Check**: `npm run --workspace=@fhara/worker typecheck` → clean.

### Step 2: Refuse automatic retry on an uncertain execution

- Extend the `running` promise result and `settle` with `executionUncertain`.
- In `settle`, after the `waiting_approval` branch and before the
  stalled/permanent/retry classification, fail immediately with
  `Execution uncertain: the aborted attempt did not stop within Nms; not
  retried automatically`.

**Check**: `npm run --workspace=@fhara/worker typecheck` → clean.

### Step 3: Tests

In `packages/worker/tests/dagScheduler.test.ts`:

1. A timed-out attempt whose executor settles after the abort: the retry
   starts only after the first attempt settles (assert start/settle ordering,
   and that the two attempts never overlap).
2. A timed-out attempt whose executor never settles: with a small
   `abortGraceMs`, the node fails with the `Execution uncertain` error and the
   executor is invoked exactly once (no retry).
3. The existing timeout/stall/retry tests still pass.

**Check**: `npx --workspace=@fhara/worker vitest run tests/dagScheduler.test.ts tests/stallDetector.test.ts tests/approvalWaitPause.test.ts` → all pass.

## Test plan

- Invariant: two attempts of the same node never run concurrently.
- Invariant: an executor that ignores the abort cannot be retried blindly.
- Negative: a settled-after-abort executor still allows the normal retry.
- Negative: a normal (non-aborted) failure keeps its existing retry behaviour.

## Completion criteria

- [ ] `npm run --workspace=@fhara/worker typecheck` clean.
- [ ] The three new/updated tests pass, plus the scheduler/stall/approval suites.
- [ ] No change to `PERMANENT_SUBTASK_ERROR_PATTERNS` or the retry budget.
- [ ] Plan state set to DONE in `plans/README.md`.

## STOP conditions

- The drain needs to change the `AbortController`/cancellation contract.
- A check fails twice after a reasonable fix.
- The change needs work outside this repository.
