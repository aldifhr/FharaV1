# Plan 073: Preserve atomicity for asynchronous mutations

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

- Priority: P1
- Size: L
- Risk: MEDIUM
- Dependencies: 068
- Planned at: commit `955da48cb9`, 2026-11-23

## Why this is needed

The local runtime can let concurrent workers claim the same task. `claimNextTask`
awaits `firstClaimableTask` before writing the claim (`apps/api/functions/orchestration.ts:370-379`).
The local executor invokes the async handler inside a synchronous SQLite transaction,
then returns/awaits its promise only after that transaction callback has returned
(`packages/runtime/src/runtime/executor.ts:89-97`). The transaction therefore ends
before the handler's asynchronous continuation performs its writes. A concurrent
claim can observe the same queued row and also return it as claimed.

## Target behaviour

- Concurrent state-changing mutations are serialized or otherwise isolated so each
  handler's full asynchronous work commits atomically.
- A failing asynchronous mutation rolls back all writes made by that mutation.
- Existing nested `runMutation` behavior and scheduler calls remain safe.
- The task claim race regression passes with exactly one winner.

## Current state

- `packages/runtime/src/runtime/executor.ts` now serializes top-level queries and
  mutations and keeps nested calls in their active execution context.
- `packages/runtime/src/db.ts` now holds `BEGIN IMMEDIATE` through asynchronous
  mutation completion and rolls back rejected handlers.
- `apps/api/functions/orchestration.ts:366-389` awaits a queue read, then patches
  the selected task and returns it as claimed.
- `apps/api/functions/regressLeaseFencing.test.ts:36-48` expects two concurrent
  claims to produce exactly one winner; it now passes.

## Decisions that must not change during execution

- Preserve task lease fencing and terminal task immutability.
- Keep the local SQLite backend and public function contracts intact.
- Do not weaken or remove the existing regression test.

## Steps

### Step 1: Define async transaction semantics

Choose an approach that safely holds atomicity across async handler execution,
nested mutations, and concurrent calls. Confirm SQLite/Drizzle supports the chosen
approach; do not assume a synchronous transaction callback can await.

**Check**: focused runtime transaction tests cover async success, rollback after
rejection, nested mutation calls, and two overlapping mutations.

### Step 2: Implement and test the runtime transaction boundary

Apply the selected transaction/serialization design in the local runtime. Add tests
that prove writes from asynchronous handlers remain inside the transaction and that
concurrent handlers cannot interleave their read/modify/write sequences.

**Check**: runtime transaction tests pass; runtime package typecheck passes.

### Step 3: Verify task claim and backend invariants

Run the claim race and lease fencing tests, then the focused backend suite. Confirm
all tests still enforce the terminal guard and service-token gate.

**Check**: `pnpm --filter @fhara/api exec vitest run functions/regressLeaseFencing.test.ts functions/securityInvariants.test.ts`
passes, including exactly one task-claim winner.

## Test plan

- Async mutation commits only after its promise resolves.
- Async mutation rejection rolls back its writes.
- Nested `runMutation` calls do not commit the outer mutation early.
- Concurrent claims of one queued task yield a single winner.
- Lease fencing and terminal status invariants continue to hold.

## Completion criteria

- [x] No async mutation can commit before its handler finishes.
- [x] Failed async mutations leave no partial writes.
- [x] Claim race and focused backend invariant tests pass.
- [x] Runtime and API typechecks pass.

## STOP conditions

- Correct transaction isolation requires changing a task status, lease, auth, or
  approval invariant.
- The chosen design cannot preserve rollback semantics for async handlers.
- A check fails twice after a reasonable fix.
