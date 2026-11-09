# Plan 018: Path ownership, review snapshot binding, worktree isolation

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

- Priority: P1
- Size: M
- Risk: MEDIUM (Step 4 HIGH — needs live smoke)
- Dependencies: 012 (taskRunner split), 013 (decision engine)
- Planned at: commit `a6c7709`, 2026-11-09

## Why this is needed

Borrowed from Nebula (fork of pingdotgg/t3code): declared per-task path
ownership + deny rules checked against the whole delta, shared-resource
leases serializing write contention, independent review bound to an immutable
snapshot, bounded retry/remediation, and an Integration Engine that applies
artifacts in a separate worktree. Fhara today has global forbidden paths
and sandboxing, a FIFO scheduler (`maxConcurrency: 1`), review over the staged
diff, and worktree infrastructure that is wired in the backend but disabled in
the runner — so two subtasks can claim the same file, a review verdict is not
provably bound to the exact bytes that get applied, and there is no isolation
between a task's edits and the user's dirty main workspace.

## Target behaviour

| Capability | After |
| --- | --- |
| Per-subtask `allowedPaths` | Planner declares scope; executor refuses files outside it (fail closed, permanent error); scheduler defers a node while a running node owns overlapping paths |
| Review snapshot id | Every review verdict carries `snapshotId` = hash of the exact staged change set; apply refuses if the set changed since the approving review |
| Worktree isolation (opt-in) | `ORCHESTRATOR_WORKTREE_ISOLATION=1` runs the task in a git worktree and integrates via merge after approval; default off = today's behaviour |

## Current state

- `packages/worker/src/orchestrator/types.ts:52-60` — `PlanSubtask` has no path scope.
- `packages/worker/src/orchestrator/planValidator.ts:94-106` — validator normalizes subtasks; no ownership parsing.
- `packages/worker/src/orchestrator/planner.ts:246-247,281` — planning prompt + schema example have no ownership rule.
- `packages/worker/src/execution/agentExecutor.ts:548-568` — code_change staging enforces `isForbiddenPath`/`validateFilePath` only; native runtime staging at `:343-369` same.
- `packages/worker/src/scheduler/dagScheduler.ts:3-6,340-355` — `SchedulerNode` is `{id, dependencies}`; ready scan has no path overlap gate. `runNodes.ts:217` hardcodes `maxConcurrency: 1` (FIFO), so overlap is future-proofing for when concurrency rises.
- `packages/worker/src/execution/agentExecutor.ts:583-665` — review already reads the staged diff snapshot passed in (`runNodes.ts:111`), but the verdict carries no snapshot identity.
- `packages/worker/src/services/taskRunner.ts:1316` — `applyStaged` resolves the main workspace directly, ignoring `input.workspacePath`; `:217-225` worktree isolation disabled with the upgrade path recorded.
- `apps/api/convex/worktreeNode.ts:22-201` — `createBranch/getDiff/mergeBranch/discardBranch` live and token-gated via `worker.ts`; never called from `taskRunner`.
- `apps/api/convex/schema.ts:194-221` — subtask rows have no path scope field.

## Decisions that must not change during execution

- `allowedPaths` is **optional and additive** everywhere (plan field, DB field). Absent = today's unrestricted behaviour. No existing plan, row, or test changes meaning.
- Ownership refusal is a **permanent** subtask error (no retry burn), mirroring the forbidden-path pattern.
- The approval gate stays authoritative: snapshot binding never auto-approves; apply after human approval still re-checks disk hashes (`gitDiff.ts:80-137`).
- Step 4 stays **default off** until a live smoke passes. No change to `runCommand` allowlist or sandbox; git plumbing follows the internal `gitDiff.ts` execFile pattern, never an agent tool.
- Retry classification (transient/permanent + budget/deadline veto) is **not** replaced by Nebula-style bounded retry.

## Steps

### Step 1: Path ownership (worker + backend)

Add `allowedPaths?: string[]` to `PlanSubtask`; normalize/validate in
`planValidator` (workspace-relative, no `..`/absolute, dedupe, cap); teach the
planner prompt to declare tight scope for `code_change`; enforce in
`executeCodeChange` and the native-runtime staging filter; add `paths` to
`SchedulerNode` + overlap deferral in the ready scan; persist the field on
subtask rows (`schema.ts` optional field + `savePlan`/`upsertDynamicSubtasks`
arg validators and inserts).

**Check**: `npm run --workspace=@fhara/worker typecheck` and
`npm run --workspace=@fhara/api typecheck` → clean.

### Step 2: Review snapshot binding

`snapshotIdForChanges` (sha256 over sorted `filePath:oldHash->newHash`) in
`gitDiff.ts`; `executeReview` computes it from the frozen staged set and
returns it in meta + the `review.completed` event; `decision.ts` stores it on
the verdict; `executePlan` recomputes it from the change set about to be
applied and fails closed (`review.snapshot_mismatch` event) when an approving
verdict's id differs; approval payload carries `reviewSnapshotId`.

**Check**: `npx --workspace=@fhara/worker vitest run tests/reviewLoop.test.ts` → green.

### Step 3: applyStaged workspace alignment (prep, behaviour-neutral)

`applyStaged` resolves `input.workspacePath` instead of re-deriving the main
workspace, so a future worktree run applies where the agents worked.

**Check**: worker typecheck + `npm test` (worker) → green.

### Step 4: Worktree isolation + integration merge (flagged, smoke required)

`ORCHESTRATOR_WORKTREE_ISOLATION` policy knob (default false, `policy.ts`).
When on: `processTask` calls `api.createBranch`, runs executors and
`applyStaged` in the worktree, commits the applied delta on the worktree
branch (internal git helper, `tools/` pattern), then after approval +
verification calls `api.mergeBranch`; merge conflict surfaces the existing
`branch.merge_conflict` event and fails the task for human attention instead
of overwriting. `resumeTask` reuses the persisted `worktreePath`. Smoke on a
throwaway git repo before any default flip.

**Check**: smoke recipe in this plan's Test plan; unit tests for the commit
helper only — no live-provider tests in the default suite.

## Test plan

- Ownership unit: normalize rejects `../`, absolute, empty; match is
  prefix-correct (`apps` does not match `apps2`); overlap symmetric.
- Validator: plan without `allowedPaths` validates unchanged; invalid entry fails closed.
- Scheduler: with concurrency 2, a node whose paths overlap a running node is deferred, then runs after it settles; non-overlapping nodes run in parallel.
- Executor: code_change returning a file outside `allowedPaths` fails with the permanent ownership error and stages nothing.
- Snapshot: verdict id equals the id of the reviewed set; mutating one staged file after review makes apply fail closed.
- Backend: subtask row round-trips `allowedPaths`; legacy rows without it read as undefined.

## Completion criteria

- [ ] Steps 1–3 landed, checks green, plan state updated.
- [ ] Step 4 landed behind the flag with smoke evidence, or explicitly deferred with this plan left IN PROGRESS.
- [ ] No non-negotiable rule changed; schema change additive only.

## STOP conditions

- A non-negotiable rule in `AGENTS.md` must change.
- A schema change needs a destructive operation.
- A check fails twice after a reasonable fix.
- The change needs work outside this repository.
- Worktree merge would overwrite a dirty main workspace silently (Step 4).
