# Plan 022: Subtask contract, escalation, acceptance gates, idempotent dispatch, user pause, model tiers

## Status

- Priority: P1
- Size: L
- Risk: MEDIUM (new task status `paused`, new acceptance stage between
  "executor done" and "subtask done", additive schema fields only)
- Dependencies: 018 (path ownership / `allowedPaths`), 020 (permission
  modes, used by escalation routing), 021 (plan validator shared by
  backend and worker, Plan card edits)
- Planned at: commit `e9bcf48`, 2026-11-09

## Credit

Several ideas here — a per-subtask contract that states what "done"
means, an executor that stops and escalates instead of widening its own
scope, acceptance checked against evidence rather than the executor's own
claim, idempotent dispatch keys, and a strong-model / worker-model split —
were inspired by the astra-luna project (Apache-2.0). Only the ideas were
adopted; no text or code was copied, and the shapes below are Fhara's own.

## Why this is needed

A subtask was "done" the moment its executor said so. Nothing written down
told the executor where its work ended, so it could quietly add a
dependency, touch the schema or edit files outside its slice, and nobody
checked the result against a stated criterion before the run moved on. A
worker crash could dispatch the same subtask twice, a worker that died
while planning left a task that recovery could only fail, the user had no
way to hold a run without cancelling it, and every role ran on the same
model regardless of how much judgement the role needed.

## Target behaviour

| Area | After the change |
| --- | --- |
| Contract | Every planned subtask can carry `objective`, `constraints[]`, `deliverable` and `acceptance[]`; its **scope** is its existing `allowedPaths`. Shown on the Plan card and `/runs` (`components/runs/Contracts.tsx`). |
| Escalation | A code_change that meets a decision it must not take alone stops with `status: "escalated"`; the CTO routes it by rule (table below); `subtask.escalated` is logged. |
| Acceptance | Executor "done" is `delivered`. An acceptance stage evaluates the gates from evidence and stores `gateResults`; only then is the subtask `accepted` (or `rejected` / `blocked`). |
| Old plans | Plans without a contract still run: gates are derived from the subtask kind. |
| Dispatch | Every execution row gets `dispatchKey = ${taskId}/${subtaskKey}/attempt-N`; a re-dispatch with the same key reuses or skips instead of duplicating. |
| Pause | The user can Pause / Resume a queued or running task (`taskControl.ts`, `PauseResumeButton.tsx`). |
| Model tiers | A project can pick a model for the planner, reviewer and worker tiers. |
| Reviewer | The reviewer role is strictly read-only. |
| Recovery | A task whose worker died during planning is re-queued, not failed. |

## Current state (as implemented on `feat/subtask-contract`)

- Contract vocabulary, parser, default gates, gate evaluation and
  escalation routing: `apps/api/convex/lib/subtaskContract.ts`
  (`defaultGatesForKind` ~L100, `parseContract` ~L170, `evaluateGates`
  L361, `acceptanceFromGates` L442, `parseEscalation` L461,
  `routeEscalation` L512). Pure TS, shared by api, worker and web.
- Convex validators: `apps/api/convex/lib/contractValidators.ts`; schema
  fields in `apps/api/convex/schema.ts` (`subtasks`: contract fields,
  `acceptanceStatus`, `acceptanceReason`, `gateResults`, `escalation`;
  `executions`: `dispatchKey` + `by_dispatch_key`, `leaseLost`; `tasks`:
  status `paused`, `pausedBy`, `pausedAt`; `projects`: `modelTiers`).
- Plan validator and edits honour the contract:
  `apps/api/convex/lib/planValidation.ts`, `lib/planEdit.ts`,
  `lib/planStore.ts`, `planReview.ts`.
- Worker: planner prompt/parser (`src/prompts/planner.ts`,
  `src/orchestrator/planner.ts`), executor prompt
  (`src/prompts/codeChange.ts`), escalation detection
  (`src/execution/escalation.ts`), routing (`src/services/runner/escalation.ts`),
  acceptance stage (`src/services/runner/acceptance.ts`, called from
  `executePlan.ts` ~L271), pause drain (`src/services/runner/pause.ts`,
  `runNodes.ts` ~L332–L433).
- Dispatch keys: `apps/api/convex/orchestration.ts` `dispatchKeyFor`
  (~L845) and the dispatch decision (~L865–L917).
- Planning-interrupted recovery: `orchestration.ts` `recoverStale` (~L462).
- Model tiers: `apps/api/convex/lib/modelTiers.ts`; resolver
  `packages/worker/src/llm/resolver.ts` (`applyModelTier` ~L435).
- Reviewer read-only: `packages/worker/src/governance/registry.ts` (~L40),
  `src/execution/agentExecutor.ts` `READ_ONLY_ROLES`.

## Decisions that must not change during execution

### 1. Contract fields

| Field | Meaning |
| --- | --- |
| `objective` | One concrete outcome, ≤ 500 chars. |
| scope | The subtask's `allowedPaths` (plan 018). Not duplicated. |
| `constraints[]` | What must not change, ≤ 10 entries. |
| `deliverable` | What the executor hands back. |
| `acceptance[]` | ≤ 8 gates `{id, criterion, check, target?, required?}`; `check ∈ test, typecheck, file_exists, command, review, manual`. `manual` gates are optional by default; every other gate is required unless `required: false`. |

All fields are optional in the schema (additive). The shared validator
requires at least one gate on every `code_change`. Plain-string gates from
the planner become optional `manual` gates; a code_change whose gates are
all manual still gets the default typecheck/test gates in front.

### 2. Gates derived from kind (old plans, planner omissions)

| Kind | Default gates |
| --- | --- |
| `code_change` | `typecheck`, `tests` |
| `research` | deliverable non-empty (`review`/`output`), cites sources (`review`/`output:sources`) |
| `audit`, `analysis` | deliverable non-empty |
| `review` | reviewer verdict approves |
| `qa`, `shell`, others | none (they carry their own verdicts) |

### 3. Acceptance stage

Runs after apply / verification / QA, once per planned (not runner-added)
subtask that completed in this run. Evidence mapping:

| Gate check | Evidence |
| --- | --- |
| `typecheck` / `test` | the verification loop's matching named checks (`*:typecheck`, `*:test`) |
| `command` | the verification step **of the same name** (`npm run lint` → `lint`) |
| `review` (no target) | the latest reviewer verdict covering the subtask |
| `review` `output` / `output:sources` | the subtask's own answer |
| `file_exists` | the workspace after apply (staged files count) |
| `manual` | never evaluated automatically (skipped) |

Results are stored as `gateResults[] = {gateId, status: pass|fail|skipped, evidence{kind, ref?, summary}}`
and logged as `acceptance.evaluated`. Acceptance lifecycle (separate from
execution status): `delivered → accepted | rejected | blocked | escalated`.
A failed required gate turns into a bounded replan with the failing
criteria as feedback; with no replans left the subtask is `blocked` and the
task fails with the reason.

### 4. Escalation rules (`routeEscalation`)

Sources: the model put an `escalation` object in its answer, or the runner
detected it from the proposed files before staging (file outside
`allowedPaths`; a schema/migration file not listed explicitly; a new
`package.json` dependency the subtask does not name).

| Escalation | Route |
| --- | --- |
| `ambiguous` | ask the user (with the executor's options) |
| `security` | ask the user |
| same subtask+kind repeated, or no replans left | ask the user |
| `new_dependency` | ask the user in `supervised` mode (or no mode); otherwise allowed → replan with the dependency in scope |
| `schema_change` | replan with a note: its own backend subtask, schema file explicit, additive only |
| `out_of_scope` | replan with a note: widen `allowedPaths` only where needed |

Every escalation records `acceptanceStatus: "escalated"` on the subtask and
a `subtask.escalated` event (kind, reason, detail, source, route,
permission mode, repeated). A replan requested inside a fix loop is asked
instead. Allowances (dependency / schema file) granted by a replan or by a
user answer that does not decline are remembered for the rest of the task
so the deterministic guard does not stop the same change again;
`out_of_scope` widens only through a plan.

### 5. Idempotent dispatch

`dispatchKey = ${taskId}/${subtaskKey}/attempt-N`. A dispatch with an
existing key: in flight on another live worker → refused; same worker or
lease lapsed (`leaseLost`) → reuse the row; finished → skip. Legacy rows
without a key that are still in flight count as the current attempt.
Planning is a dispatch too: `${taskId}/plan/attempt-N`.

### 6. User pause (`paused` status)

- `paused` is non-terminal and distinct from cancelled and blocked.
  Pausable from `queued` and `running` only.
- No new subtask is dispatched; running subtasks finish (drain). The
  worker keeps its lease while draining and calls `releasePausedTask` at
  the next stage boundary.
- Nothing resumes a paused task except the user: `claimNextTask` claims
  only `queued`, `recoverStale` only `running`.
- Resume: still draining on a live worker → back to `running`; otherwise
  `queued` and the next claim continues from the stored plan.
- **Input guard (`lib/taskInputGuard.ts`, from main):** a **steer is
  admitted** while paused. Pausing is the natural moment to redirect a
  run; the steer is stored undelivered in `taskInputs` and the worker
  renders it on its next turn after resume (delivery does not depend on
  task status). An **answer** is still refused (`question_mismatch`),
  because a paused task has no open question.

### 7. Model tiers

`projects.modelTiers = {planner?, reviewer?, worker?}` (llmModels ids).
Resolution per agent: explicit agent assignment (`llmProviderId` /
`llmModelId`) → the role's tier (CTO/orchestrator → planner, reviewer →
reviewer, fixed worker roles → worker) → default pool. The resolver's
normal fallback still applies when the tier model is down; the estimator
uses the same resolution (`expectedModelFor`).

### 8. Reviewer read-only

The reviewer role is denied `write_file` and `run_command` in the tool
registry and listed in `READ_ONLY_ROLES`, regardless of what its agent
row declares.

### Known approximations (accepted, not bugs)

- Escalation routing is rule-based (`routeEscalation`), not an LLM
  decision by the CTO.
- A `command` gate does not run its command: it maps only to a named
  verification step of the same name; anything else is skipped.
- Skipped gates (verification off, no matching script, unknown workspace,
  manual) do not block acceptance.
- The "cites sources" gate is a pattern match (a URL or a file path with an
  extension), not a check that the sources support the claim.

## Steps

1. Contract types, validators, schema (additive). **Check**: `tsc` for
   api, web, worker.
2. Planner prompt + parser + shared validator + plan edits carry the
   contract. **Check**: `contracts.test.ts`, worker `subtaskContract.test.ts`.
3. Executor escalation + runner routing. **Check**: worker
   `subtaskContract.test.ts` escalation cases.
4. Acceptance stage + gateResults + UI. **Check**: same.
5. dispatchKey + planning-interrupted recovery. **Check**:
   `contracts.test.ts`, worker `phase4HardeningRecovery.test.ts`.
6. Pause / Resume + input-guard decision. **Check**: `contracts.test.ts`,
   `taskInputGuard.test.ts`.
7. Model tiers + reviewer read-only. **Check**: worker tests, layering test.

## Test plan

- Old plans (no contract) still validate and get kind-derived gates.
- A code_change with no gates is refused by the shared validator.
- A failed required gate never yields `accepted`; skipped gates do.
- Out-of-scope / schema / new-dependency changes escalate before staging.
- `ambiguous` and `security` always reach the user; a repeat reaches the user.
- The same dispatchKey never creates a second execution row.
- A planning-interrupted task is re-queued with `planning_interrupted`.
- A paused task is never claimed or recovered automatically; a steer is
  admitted, an answer refused.
- A reviewer cannot write files or run commands.

## Completion criteria

- [ ] `tsc` clean for `apps/web`, `apps/api`, `packages/worker`.
- [ ] api tests pass.
- [ ] worker `tests/subtaskContract.test.ts`, `phase4HardeningRecovery`,
  `layering` pass.
- [ ] Live smoke: a run with an escalation, a rejected gate and a
  pause/resume (pending).

## STOP conditions

- A non-negotiable rule in `AGENTS.md` must change.
- A schema change needs a destructive operation.
- A check fails twice after a reasonable fix.
- The change needs work outside this repository.
