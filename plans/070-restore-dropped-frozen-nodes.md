# Plan 070: Restore dropped frozen nodes during replanning

## Status

- State: DONE (2026-11-23; focused worker tests and worker typecheck passed)
- Priority: P1
- Size: S
- Risk: LOW
- Dependencies: 013
- Planned at: commit `955da48cb9`, 2026-11-23

## Why this is needed

When the planner omits a completed frozen node, `preserveFrozen` leaves it out and `checkReplanQuality` rejects the candidate. The bounded retry can repeat the same omission and fail the task even though the completed node should be carried forward.

## Target behaviour

- Every frozen completed node is present in the guarded plan with its original definition.
- A candidate that omits only frozen nodes can pass replan quality after the guard restores them.
- Carried outputs remain completed and are not executed again after an accepted replan.

## Current state

- `packages/worker/src/orchestrator/replanIntelligence.ts` restores omitted frozen nodes from the previous plan in deterministic order and reports them as restored.
- `packages/worker/src/services/runner/replan.ts` applies the guard before quality validation and carries frozen outputs forward after accepting a plan.
- `packages/worker/tests/replanIntelligence.test.ts` verifies an omitted frozen node is restored verbatim and the repaired candidate passes quality checks.
- `packages/worker/tests/replanPreservation.test.ts` verifies accepted replanning restores omitted completed work without re-executing it.

## Decisions that must not change during execution

- Completed work is never re-run after an accepted replan.
- Failed or impacted work remains eligible for replacement.
- Existing task approval, sandbox, and command policies remain unchanged.

## Steps

### Step 1: Restore omitted frozen nodes

Update `preserveFrozen` to insert omitted frozen nodes from the previous plan and report them as restored. Ensure ordering remains deterministic and preserve their original dependencies.

**Check**: unit test verifies restoration and that the guarded candidate passes `checkReplanQuality`.

### Step 2: Cover end-to-end execution

Change the replan-preservation fixture so the planner omits a completed frozen node. Verify the node remains in the accepted plan, its output carries forward, and its executor runs once total.

**Check**: `npx --workspace=@fhara/worker vitest run tests/replanIntelligence.test.ts tests/replanPreservation.test.ts`.

## Test plan

- Omitted frozen node is restored verbatim and reported.
- Replan quality accepts the guarded plan when all other constraints pass.
- End-to-end replan preserves completed output without re-executing that node.
- Existing failure-strategy, cycle, and dangling-dependency guards continue to reject invalid plans.

## Completion criteria

- Both focused worker test files pass (15 tests).
- Worker typecheck passes (`tsc --noEmit`).
- Replan records show the restored node as preserved and do not show it as removed.

## STOP conditions

- Restoring a frozen node creates a dependency cycle or changes a non-negotiable execution rule.
- A check fails twice after a reasonable fix.
