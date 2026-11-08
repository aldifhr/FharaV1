# Plan 013: Real orchestrator decisions and effective completion guards

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

- Priority: P1
- Size: L
- Risk: MEDIUM
- Dependencies: 011 (owns QA verdict semantics), 012 (hard — execute after the
  split lands; the engine decision block moves to `services/runner/decision.ts`)
- Planned at: commit `013bba8`, 2026-11-08

## Why this is needed

Users report that agents make poor decisions and unsatisfying results are
marked done. The audit shows the LLM is barely in the loop: the decision
advisor is effectively never consulted (deterministic mappings cover every
evaluation verdict, and the advisor wiring falls back to an env-only config
with a hardcoded model), `replan`/`ask_user` are recorded no-ops, outstanding
issues never resolve, and finalize completes tasks whose verification is
inconclusive. "Is the model bad?" cannot even be evaluated until the wiring is
fixed and the guards actually guard.

## Target behaviour

- The decision advisor runs on the task's own provider chain (resolver
  handles), metered via `onTokenUsage` and gated by `llmTaskGate` + the
  pre-call budget gate. No env-only or hardcoded-model advisor path remains.
- The advisor is consulted where judgment matters: ambiguous observations and
  unmet objectives. Deterministic policy vetoes (budget BLOCKED, step limit)
  still win; `validateDecision` still vets every advisor output.
- `replan` re-plans through the single planning authority, bounded by
  `policy.maxReplans`; exhaustion fails the task with the missing list.
- `ask_user` pauses the task in a new non-terminal `waiting_input` status with
  the question visible; the user's answer re-queues and resumes the task.
- `complete`/BLOCKED end scheduling for real (halt latch), not a dead branch.
- Issues resolve when later work satisfies them; open critical/high issues
  and inconclusive verification block `done`.
- The planner prompt matches `reviewMode`/`qaMode`; one decision path remains
  (legacy engine branch deleted); delegation side effects are identical in
  warn and enforce budget modes.

## Current state

Verified at `013bba8`. Plan 012 is actively splitting `taskRunner.ts` while
this plan is written: for `taskRunner.ts` citations, re-locate by symbol after
the split (engine decision block → `services/runner/decision.ts`, finalize →
`services/runner/finalize.ts`, which already exists).

Decision layer:

- `packages/worker/src/orchestrator/decision.ts:700` — advisor consulted only
  when mode is `always` or the observation is `ambiguous`;
  `decision.ts:548` `nextDeterministicDecision` maps every evaluation verdict,
  so `ambiguous` effectively never fires. Default mode `ambiguous`:
  `packages/worker/src/orchestrator/policy.ts:221`.
- `packages/worker/src/services/taskRunner.ts:2064` (pre-split line) — the
  `decideWithLlm` wiring passes no `llmResolver`/`llmConfig`/`onTokenUsage`/
  `llmTaskGate`.
- `packages/worker/src/orchestrator/decisionLlm.ts:136-145` — without a
  resolver, falls back to `input.llmConfig ?? getGlobalLLMConfig()`;
  `packages/worker/src/llm.ts:32-39` — env-only config with hardcoded default
  model `claude-sonnet-4-20250514`. Advisor tokens are unmetered because
  `onTokenUsage` is never passed (`decisionLlm.ts:160`).
- `packages/worker/src/services/taskRunner.ts:2182-2188` (pre-split line) —
  objective-unmet downgrades the decision to `replan`/`ask_user`;
  `decision.ts:776-781` — both are recorded no-ops. `decision.ts:723-728` —
  `AppliedDecision.halt` is always false, so the runner's `applied.halt`
  branch is dead code.
- `packages/worker/src/orchestrator/taskContext.ts:79` — issue status
  `"resolved"` has no writers anywhere; `decision.ts:182` `evaluateObjective`
  fails on any open critical/high issue, so once replan is wired without an
  issue lifecycle, recovery can never succeed.
- `packages/worker/src/services/runner/finalize.ts:148-163` — inconclusive
  verification still completes the task as `done`;
  `packages/worker/src/orchestrator/evaluator.ts:45` `evaluateTask` never
  reads `outstandingIssues` or the objective.

Planning authority:

- `packages/worker/src/orchestrator/orchestrator.ts:377-389` —
  `createAuthoritativePlan` calls `createPlan` without `hasQaUrl`
  (`AuthoritativePlanInput` at `orchestrator.ts:286` lacks the field; the
  planner supports it at `planner.ts:55`/`planner.ts:136`).
- `packages/worker/src/services/taskRunner.ts:428`/`:681`/`:786` (current
  lines) — initial planning and replans call `createPlan` directly, bypassing
  `createAuthoritativePlan`.
- `packages/worker/src/orchestrator/planner.ts:244` — the prompt mandates a
  review node for every code change regardless of `policy.reviewMode`
  (`policy.ts:234`); `applyPlanningHints` (`planner.ts:265`) never removes
  nodes, so mode `never` cannot win.

Engine parity:

- `packages/worker/src/services/taskRunner.ts:1663` (current line) —
  delegations are counted only in enforce mode; `recordDelegation` and the
  `@agent` handoff message exist only in the legacy branch
  (`taskRunner.ts:1875`/`:1888`, current lines).
- The legacy `onOutcome` branch behind `ORCHESTRATOR_DECISION_ENGINE`
  (`policy.ts:217`, default true) duplicates the engine's decision handling.

Dead or divergent:

- `packages/worker/src/orchestrator/budget.ts:278` `resolveModelConfig` and
  `budget.ts:290` `shouldUseLLMEvaluation` — zero consumers.
- `taskRunner.ts` `kindForCapability` (no `normalizeCapability`) vs
  `decision.ts:799` (normalizes) — two implementations of one routing decision.
- `packages/worker/src/orchestrator/orchestrator.ts:74` —
  `createOrchestratorPlan` builds `steps` no consumer reads.
- `packages/worker/src/orchestrator/taskContext.ts:207-215` — a
  `delegationRecommendation` alone pushes an `APPROVE` decision into the trail.

Schema:

- `apps/api/convex/schema.ts:4-11` — `taskStatus` has no waiting-for-input
  state (`queued`/`running`/`needs_approval`/`done`/`rejected`/`failed`).

## Decisions that must not change during execution

- All `AGENTS.md` non-negotiables stay: budget gate before EVERY LLM call
  (advisor included), the human approval gate, tool sandboxing, service-token
  gating on every worker-facing function, terminal-task immutability, and
  credential handling.
- One planning authority: every (re)plan goes through
  `createAuthoritativePlan`. No second planner or routing path.
- No hardcoded models in agent paths: the advisor uses the task's resolver
  chain. The advisor's env fallback is DELETED, not repaired.
  `getGlobalLLMConfig` itself stays — executor/planner/resolver still use it
  as a legacy fallback (`agentExecutor.ts:105`, `planner.ts:94`,
  `llm/resolver.ts:260`); removing those is out of scope.
- `validateDecision` remains the contract/policy/routing veto over advisor
  output. The LLM never overrides deterministic policy decisions (budget
  BLOCKED, decision step limit).
- Replans are bounded by the existing `policy.maxReplans`
  (`policy.ts:147`, default 1, max 3). No new unbounded recovery loop.
- The schema change is additive only: new `taskStatus` literal
  `"waiting_input"` + `tasks.pendingQuestion: v.optional(v.string())`.
  Nothing is removed or renamed. `waiting_input` is non-terminal; the
  `completeTask` terminal guard is untouched.
- Plan 011 owns QA verdict semantics (inconclusive QA blocks; only planned QA
  nodes are objective requirements). This plan wires the final
  objective/issue guard and the recovery outcomes; it does not redefine QA
  verdicts.
- Out of scope: rewriting the regex classifier or routing algorithm, executor
  prompt tuning, model-registry changes, removing the executor/planner env
  fallbacks, and any web redesign beyond the minimal question/answer UI.

## Steps

### Step 1: Wire the advisor to the task's LLM chain

- At the engine's `decide()` call (post-012: `services/runner/decision.ts`;
  pre-split: `taskRunner.ts:2064`), pass `llmResolver`, `llmConfig`,
  `llmTaskGate`, `signal`, and an `onTokenUsage` adapter to the runner's
  usage recorder.
- In `decisionLlm.ts` `runRealCall` (`:130`), delete the
  `getGlobalLLMConfig` fallback: no resolver and no `llmConfig` → throw
  `"decision advisor has no task LLM chain"`. `decide()` already converts a
  throw into a recorded deterministic fallback (`decision.ts:715-720`).
- Tests: advisor call is metered and gated; missing chain → explicit fallback
  reason, never an env-based call.

**Check**: `npm run --workspace=@moagent/worker typecheck` &&
`npx --workspace=@moagent/worker vitest run tests/decision.test.ts tests/orchestrator.test.ts`
→ green.

### Step 2: Issue lifecycle and the final completion guard

- `taskContext.ts`: resolve an open issue when a later review approves its
  `relatedFiles` or a planned QA node passes. Conservative matching: resolve
  only issues whose `relatedFiles` are all in the applied-and-approved set;
  issues without `relatedFiles` resolve only on an approving review of the
  same capability domain. `"ignored"` stays user-driven (not written here).
- `evaluator.ts` `evaluateTask` (`:45`): gain the open-critical/high-issue and
  objective checks. `runner/finalize.ts:148-163`: inconclusive verification
  or open critical/high issues → `failed` with the missing list, never a
  silent `done`.
- This step lands BEFORE replan becomes real, so recovery can never loop on
  permanently-unmet objectives.

**Check**: `npm run --workspace=@moagent/worker typecheck` &&
`npx --workspace=@moagent/worker vitest run tests/taskContext.test.ts tests/evaluator.test.ts tests/phase6Completion.test.ts`
→ green.

### Step 3: Real replan, complete, and halt outcomes

- `applyDecision` (`decision.ts:735`) returns a discriminated outcome
  (`nodes` for execute/delegate/parallel, plus `replan`/`complete`/`halt`
  outcomes) instead of no-op notes. Make `AppliedDecision.halt` real or delete
  the dead branch — one representation, not both.
- Runner: `replan` → bounded by `policy.maxReplans`; call
  `createAuthoritativePlan` with `feedback` = objective missing list and
  `hasQaUrl` forwarded (add the field to `AuthoritativePlanInput`,
  `orchestrator.ts:286`, forward at `:377-389`); route the existing direct
  `createPlan` call sites (`taskRunner.ts:428`/`:681`/`:786`) through the same
  authority. Persist the new plan version and dynamic subtasks; re-run the
  scheduler. Budget exhausted → `failed` with the missing list.
- `complete`/BLOCKED → latch `shouldHaltNewNodes` and finalize with the
  decision's `expectedOutcome`.
- Until Step 5 lands, the recovery choice stays the current deterministic
  rule (missing work → replan, else ask_user); `ask_user` remains a recorded
  no-op until Step 4 — no behaviour regression between steps.

**Check**: `npm run --workspace=@moagent/worker typecheck` &&
`npx --workspace=@moagent/worker vitest run tests/taskRunner.replan.test.ts tests/phase5Runner.test.ts tests/phase4HardeningRecovery.test.ts`
→ green.

### Step 4: `ask_user` end to end

- Additive schema: `taskStatus` gains `"waiting_input"`;
  `tasks.pendingQuestion: v.optional(v.string())`
  (`apps/api/convex/schema.ts:4-11`).
- Backend: internal mutation to set question + status and one to record the
  answer and re-queue, both behind the `worker.ts` facade pattern where
  worker-facing (`assertServiceToken`); the answer mutation is public
  following the existing task-mutation authz pattern. Extend
  `securityInvariants.test.ts` for the token gate and terminal guard.
- Worker: `applyDecision` `ask_user` → question + `waiting_input`;
  `resumeTask` threads the answer into the shared context and continues.
- Web: minimal — the task view shows the pending question and a reply action
  that calls the answer mutation. Reuse existing components; no redesign.
  Handle the new status wherever the UI switches on `taskStatus`.

**Check**: `npm run --workspace=@moagent/api typecheck` &&
`npx --workspace=@moagent/api vitest run convex/securityInvariants.test.ts` &&
`npm run --workspace=@moagent/web typecheck` &&
`npm run --workspace=@moagent/worker typecheck` → green; worker recovery test
exercises pause → answer → resume.

### Step 5: Consult the advisor where judgment matters

- `DecisionObservation` gains objective state (`met`, `missing[]`,
  `evidence`), computed by the runner via `evaluateObjective`.
- `decide()` (`decision.ts:659`): consult the advisor when the deterministic
  result is `ambiguous` OR the objective is unmet (mode ≠ `off`).
  Deterministic vetoes (BLOCKED, step limit) are evaluated first and never
  consult. Advisor unavailable → the deterministic recovery rule from Step 3.
- Remove the runner's post-hoc objective downgrade (pre-split
  `taskRunner.ts:2182-2188`); the recovery decision now comes from `decide()`
  and every outcome is real (Steps 3–4).

**Check**: `npm run --workspace=@moagent/worker typecheck` &&
`npx --workspace=@moagent/worker vitest run tests/decision.test.ts tests/orchestrator.test.ts`
→ green. New cases: unmet objective consults the advisor; mode `off` →
deterministic recovery; BLOCKED/step-limit never consult; invalid advisor
output falls back with a recorded reason.

### Step 6: Planner prompt follows policy

- `planner.ts:244`: replace the unconditional review mandate with lines
  conditioned on `policy.reviewMode`/`qaMode` — `always` → mandate,
  `never` → forbid adding, `auto` → describe the risk/verification signals.
  The hints layer (`applyPlanningHints`) stays as the enforcement layer and
  still never removes LLM-provided nodes.

**Check**: `npm run --workspace=@moagent/worker typecheck` &&
`npx --workspace=@moagent/worker vitest run tests/planner.test.ts` → green
for all three modes.

### Step 7: One decision path, parity, dead code

- Parity first: `recordDelegation`, the `@agent` handoff message, and
  delegation counting run in engine mode too; counting is independent of
  `budgetMode` (enforcement stays mode-dependent).
- Then delete the legacy `onOutcome` branch and the
  `ORCHESTRATOR_DECISION_ENGINE` flag (`policy.ts:217`; default ON since plan
  005, suite green forced-on).
- Dead code: delete `budget.ts:278`/`:290`; unify `kindForCapability` on
  `decision.ts:799` (runner imports it); delete the unread
  `createOrchestratorPlan` `steps` (`orchestrator.ts:74`); remove the premature
  `APPROVE` trail push (`taskContext.ts:207-215`); dedupe the
  `DelegationDecision` type (`taskContext.ts:6` vs `delegation.ts:14`).

**Check**: `npm test` (full worker suite) && `npm run knip` &&
`npm run typecheck` (root — shared contracts changed) → green.

## Test plan

- Advisor: every advisor call is metered (`onTokenUsage`) and passes
  `llmTaskGate` + the pre-call budget gate; no resolver/config → explicit
  fallback, never an env call; invalid advisor JSON/validation → recorded
  fallback, deterministic decision stands.
- Policy veto: budget BLOCKED and step-limit decisions never consult the
  advisor and are never overridden by it.
- Replan: bounded by `maxReplans`; exhaustion → `failed` with the missing
  list; every replan goes through `createAuthoritativePlan` with `hasQaUrl`
  forwarded; dynamic subtasks persisted.
- `ask_user`: task enters `waiting_input` (non-terminal); answer re-queues and
  resumes with the answer in context; a terminal task refuses the transition
  (`task_already_terminal`); the worker-facing mutation rejects a bad token.
- Guards: open critical/high issue blocks `done`; inconclusive verification
  → `failed`; issues resolve only when later approved work covers them.
- Prompt: `never` mode produces no mandated review line; `always` mandates;
  `auto` describes signals.
- Parity: delegation counted in warn mode; handoff message emitted in engine
  mode; no legacy branch remains (`grep ORCHESTRATOR_DECISION_ENGINE` → only
  historical plan docs).
- Negative: no path completes a task with open critical issues; no path
  issues an unmetered LLM call; no second planner entry point.

## Completion criteria

- [ ] Worker, API, and web typechecks pass; full worker suite green;
      `npm run knip` clean; root `npm run typecheck` passes.
- [ ] Live smoke task: `orchestrator.decision` events show `decidedBy: "llm"`
      on an unmet-objective branch (or an explicit `decision_fallback` reason
      when the chain is unavailable); advisor tokens appear in `tokenUsage`.
- [ ] Live smoke: a forced unsatisfying result does NOT end `done` (open
      critical issue or inconclusive verification → `failed`/replan).
- [ ] Live smoke: `ask_user` pauses in `waiting_input`, an answer resumes the
      task, and the answer influences the resumed run.
- [ ] `grep -r "ORCHESTRATOR_DECISION_ENGINE" packages/worker/src` → no hits.
- [ ] State column updated in `plans/README.md`.

## STOP conditions

- A non-negotiable rule in `AGENTS.md` must change.
- The schema change needs anything beyond the additive literal + optional
  field recorded above.
- Plan 012 has moved or rewritten the cited code: re-locate by symbol and
  re-verify the claim; never revert or overwrite the split to make a step fit.
- A check fails twice after a reasonable fix.
- The change needs work outside this repository.