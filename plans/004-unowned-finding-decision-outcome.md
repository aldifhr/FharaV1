# Plan 004: Unowned-finding decision outcome

## Status

- Priority: P2
- Size: M
- Risk: MEDIUM
- Dependencies: —
- Planned at: commit `caf816104b`, 2026-11-27

## Why this is needed

"Unowned severe finding" is a legitimate `BLOCKED` outcome, but every
`BLOCKED` observation is mapped to `expectedOutcome:"policy:budget"`, so the
runner halts on a budget path, logs `orchestrator.budget_blocked` and shows a
budget block that never happened. The real reason survives only in free-text
reasoning. Fix-owner selection also keeps a dead QA helper and a second
primary-agent pass that can report an agent the plan never executes.

## Target behaviour

- A non-budget `BLOCKED` outcome has its own outcome id and event, and names
  the open finding.
- A budget halt is reported only when the budget actually halted the run.
- The fix-owner seam has one helper per decision and one primary-agent pass.

## Current state

- `packages/worker/src/orchestrator/delegation.ts:260-264` — `BLOCKED` with "no writable fix owner"; also `:353-371` for other blockers.
- `packages/worker/src/orchestrator/decision.ts:508-515` — every `BLOCKED` → `action:"complete", expectedOutcome:"policy:budget"`.
- `packages/worker/src/services/runner/decision.ts:473-488` — `halt_budget` logs `orchestrator.budget_blocked`.
- `packages/worker/src/orchestrator/decisionEngine/fixOwner.ts:139-146` — `pickQaFixOwner` has no production caller; re-exported from `decisionEngine/index.ts:65`.
- `packages/worker/src/orchestrator/orchestrator.ts:62-96` — a second `routePrimaryAgent` pass on every plan/replan; the executed primary is recomputed at `:363-368`.
- `fixOwner.ts:102-104` — the review branch dropped the owner's `allowedPaths`; fixed in this audit and pinned by `decisionEngine.fixOwner.test.ts:140-148`.

## Decisions that must not change during execution

- `decisionEngine/` stays the single seam for "what happens next".
- `BLOCKED` still halts new scheduling without killing completed work.
- An unowned severe finding never becomes `COMPLETE`.
- Budget gating stays before every LLM call.

## Steps

### Step 1: Discriminate BLOCKED reasons

Add a typed reason to the `BLOCKED` observation (budget / unowned finding /
missing agent / policy). Map only the budget reason to `policy:budget`; give
the others an explicit outcome and event.

**Check**: `tests/decisionEngine.golden.test.ts` updated with the non-budget
sequence; focused decision tests pass.

### Step 2: Remove the dead fix-owner helper

Delete `pickQaFixOwner` and its re-exports; coverage stays in
`decideFixOwner` through `ownerForFix({ prefer })`.

**Check**: worker typecheck and `knip` show no new dead export.

### Step 3: Remove the second primary-agent pass

Derive the planning event's primary fields from `createAuthoritativePlan`
instead of calling `routePrimaryAgent` again with a reloaded policy.

**Check**: `tests/orchestrator.test.ts` and `planning.test.ts` pass; the
event agent equals the executed primary.

## Test plan

- Severe finding with no writable owner → BLOCKED with a non-budget event, task not `done`.
- Budget exhaustion → unchanged `policy:budget` path.
- Event primary equals the first executed node's agent under a non-default policy.

## Completion criteria

- [ ] No non-budget block is reported as `orchestrator.budget_blocked`.
- [ ] No dead fix-owner helper or duplicate primary pass.
- [ ] Worker typecheck, focused suites and `knip` pass.

## STOP conditions

- A non-negotiable rule in `AGENTS.md` must change.
- A check fails twice after a reasonable fix.
- A schema change is required.
