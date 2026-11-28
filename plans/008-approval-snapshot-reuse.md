# Plan 008: Reuse an approved apply snapshot instead of re-asking

## Status

- Priority: P0 (live approval loop, 12 cards for one file)
- Size: M
- Risk: HIGH (touches the human approval gate)
- Dependencies: —
- Planned at: commit `2fd2247176`, 2026-11-28
- State: DONE 2026-11-28

## Why this is needed

A live run (`tasks:mx002obj`) produced 12 `approval.requested` cards for the
same `apply_changes` on `src/App.tsx` in ~30 seconds. Each approval triggered
`task.claimed` with reason `approval_resume`, the run re-planned and requested
approval again. The user approved 11 times before cancelling. The approval
gate itself was never bypassed; the same already-approved snapshot was asked
again and again.

## Current state

- `apps/api/functions/orchestration.ts:1410` — `requestApproval` deduped only
  pending rows; an approved row never matched, so a new pending card was
  inserted and the task moved back to `needs_approval`.
- `packages/worker/src/services/runner/applyStage.ts:66,166` — both approval
  request paths always returned `waiting_approval`, even when the backend had
  already granted the identical batch.
- `packages/worker/src/services/runner/execute/phases/approval.ts:18,31` — the
  legacy and verified gates exited with `waiting_approval` unconditionally.

## Target behaviour

- A repeated request for the same task/kind/subtaskKey/planVersion/filePaths
  reuses the existing approved row: no new card, no `needs_approval` pause,
  and an `approval.reused` event records the decision.
- A different file set, a new plan version, or a rejected approval still asks
  again. The approval gate is never auto-advanced without a recorded approval.
- Terminal-status and lease guards are unchanged.

## Steps

### Step 1: Backend idempotent reuse

`requestApproval` returns `{ approvalId, reused }` and matches an approved row
on literal file-path equality, kind, subtaskKey and planVersion.

**Check**: `pnpm --filter @fhara/api exec vitest run functions/coreFixes.test.ts`
→ 28/28 pass (two new cases).

### Step 2: Worker honours reuse

Both request paths return `approved` on reuse; the legacy/verified phases and
the permission broker continue instead of pausing.

**Check**: `pnpm --filter @fhara/worker run typecheck` → exit 0; full worker
suite shows no new deterministic failures (baseline 28–31 pre-existing).

### Step 3: Rebuild

**Check**: `pnpm --filter @fhara/runtime run build:functions` → success; the
bundle contains `approval.reused`.

## Completion criteria

- [x] Repeated identical apply approval returns `reused: true` without a new row.
- [x] A changed file set still creates a new pending approval.
- [x] Task stays `running` after a reused approval.
- [x] Typechecks pass; no new deterministic worker test failures.
- [x] Runtime bundle rebuilt.

## STOP conditions

- Reuse could occur for a different file set, plan version or subtask.
- A pending or rejected approval is treated as approved.
- Terminal-status or lease guards are weakened.
