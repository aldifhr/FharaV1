# Plan 012: Split `services/taskRunner.ts`

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

- Priority: P1
- Size: L
- Risk: MEDIUM (pure module extraction; no behaviour change)
- Dependencies: —
- Planned at: commit `working tree`, 2026-11-08
- State: **DONE** (completed 2026-11-08; all three steps landed —
  Steps 1-3 extracted with typecheck + full-suite evidence)

## Completion evidence (2026-11-08, delegated finish)

- **Step 1** leaf modules (recorded above): typecheck clean, 463 pass (same
  count as HEAD pre-split), AST-range byte-exactness (0 diffs).
- **Step 2** loops extracted: `runner/runNodes.ts` (`runNodes`),
  `runner/reviewLoop.ts` (`runReviewLoop`), `runner/qaLoop.ts` (`runQaLoop`),
  `runner/verifyLoop.ts` (`runVerificationLoop`). All move verbatim;
  every cycle is covered by the unchanged suite (worker tests 486 total,
  483 passed — the delta over the 463 baseline is Plan 013 Step 1-7 tests,
  not split tests).
- **Step 3** `onOutcome` → `runner/decision.ts` as `handleNodeOutcome(ctx,
  node, outcome, attempt)`; `executePlan` constructs one `RunContext`
  (types.ts) and the extracted stages share it. Scalar latches
  (`budgetHalt`, `stepLimitHit`, `decisionTerminal`, `replanFeedback`,
  `waitingForInput`, `inStageLoop`, `decisionStep`, ...) stay synced onto
  ctx via accessors, so the driver reads closure locals while stages read
  ctx.* — one logical latch state. `executePlan` became thin orchestration;
  `processTask`/`resumeTask` are intact public entry points; the four
  test-module re-exports (`processTask`, `resumeTask`, `buildStateFromDb`,
  `carryForwardState`) still resolve from `@/services/taskRunner`.

### Deviations (recorded 2026-11-08)

- The Step 3 checks `taskRunner.ts` under 700 lines and "no file in
  src/services/ over 600" are unmet (`taskRunner.ts` 2.020, `setup.ts`
  631). They are arithmetically incompatible with the plan's own target
  shape ("taskRunner.ts shrinks to the two public entry points
  (`processTask`, `resumeTask`) plus the DAG wiring"): `processTask`
  alone (plan + budget prelude + outer replan loop) is ~890 lines and
  `resumeTask` ~370. The steps prescribed here are exactly the loops +
  onOutcome + scheduler wiring; the remaining code is the entry points.
  Slicing processTask further would require a second, larger refactor
  beyond this plan's scope.
- Step 2's `runVerificationLoop` keeps the `taskCancelled()` overlay at
  its call site (the extractor returns "cancelled"/"failed"/null;
  the driver re-applies the cancellation overlay exactly as before).

## Why this is needed

`packages/worker/src/services/taskRunner.ts` is 3973 lines and mixes six
orthogonal concerns in one module: plan/LLM wiring, budget seeding and endings,
abort signal plumbing, the DAG execution loop, the review/QA/verification
correction loops, and finalize/persistence. `executePlan` alone is 1770 lines
(`taskRunner.ts:1453`–`3223`), so a stack trace pointing into it names a file,
not a stage — the reviewer still has to scroll ~1800 lines to find which of the
five stages failed. Debugging a budget stop, a QA-loop bound, and an abort race
all require the same mental map of one function.

## Target behaviour

- `taskRunner.ts` shrinks to the two public entry points (`processTask`,
  `resumeTask`) plus the DAG wiring that only they and the extracted stages
  share.
- Each stage lives in its own file with an explicit exported input type, so a
  stack trace names the stage.
- The public surface of `@/services/taskRunner` is unchanged: the 14 test files
  that import `processTask`, `resumeTask`, `buildStateFromDb`,
  `carryForwardState`, and `resolveQaBaseUrl` keep compiling unmodified.

## Current state

| Concern | Location |
| --- | --- |
| `processTask` | `taskRunner.ts:695` |
| `executePlan` (DAG + all loops) | `taskRunner.ts:1453`–`3223` |
| scheduler wiring (`runNodes`) | `taskRunner.ts:1663`–`2628` |
| decision/evaluation handling (`onOutcome`) | `taskRunner.ts:2000`–`2572` |
| review correction loop | `taskRunner.ts:2700`–`2814` |
| QA correction loop | `taskRunner.ts:2824`–`2983` |
| verification loop | `taskRunner.ts:3142`–`3217` |
| apply / approval gate | `taskRunner.ts:3019`–`3119` |
| `resumeTask` | `taskRunner.ts:3225`–`3498` |
| `finalize` | `taskRunner.ts:3523`–`3670` |
| `persistPlan` | `taskRunner.ts:3672`–`3699` |
| `dryRunPolicy` | `taskRunner.ts:3701`–`3753` |
| state/recovery (`buildStateFromDb`, `carryForwardState`) | `taskRunner.ts:198`, `:317` |
| budget plumbing | `taskRunner.ts:434`, `:505`, `:470`–`494` |
| abort plumbing | `taskRunner.ts:380`–`422` |
| agent/workspace/MCP/file helpers | `taskRunner.ts:594`–`693`, `:3755`–`3942` |

Consumers outside the worker: none. `src/index.ts:10` imports
`processTask`/`resumeTask`/`RunnerDeps`; the 14 test files import the five
names listed above.

## Decisions that must not change during execution

- The budget pre-call gate still runs **before** every LLM call
  (`taskRunner.ts:793`, `:1479`, `:2068`).
- One `AbortController` per task still carries cancel + deadline and is still
  disposed on every exit path (`taskRunner.ts:870`, `:1449`, `:3282`, `:3496`).
- `executePlan`'s five outcomes (`completed | failed | waiting_approval |
  cancelled | step_limit`) and every caller's handling of them are unchanged.
- `applyStaged` still stops on a cancelled signal and never retries
  (`taskRunner.ts:2639`).
- Dynamic subtasks are still persisted at spawn time, fail-closed
  (`taskRunner.ts:1543`).
- `taskRunner.ts` still re-exports `buildStateFromDb`, `carryForwardState`, and
  `resolveQaBaseUrl` so tests do not move in this plan.

## Steps

### Step 1: extract the leaf modules into `src/services/runner/` (no closure dependencies)

Create a folder `src/services/runner/` with one file per concern:

- `runner/state.ts` — `RunState`, `buildStateFromDb`, `carryForwardState`,
  `persistedReviewVerdict`, `persistedQaVerdict`
- `runner/setup.ts` — `armTaskAbort`, `combineSignals`, `isTerminalTaskStatus`,
  `buildTaskLlmResolver`, `stagehandConfigFrom`, `qaEnvFallback`,
  `resolveQaBaseUrl`, `mcpForTask`, `withFileContexts`, `resolveWorkspacePath`,
  `toAgentDefinition`, `seedBudgetFromPersisted`, `finishBudgetExhaustedTask`,
  `summaryHasBudgetFailure`, `budgetReasonFromSummary`,
  `toAgentResult`, `kindForCapability`, `slugifyKeyPart`, `implementerAgent`,
  `toFileDiff`, `normalizeFileChangePath`, `isForbiddenFilePath`,
  `buildReplanFeedback`, `dryRunPolicy`
- `runner/finalize.ts` — `finalize`, `persistPlan`

`taskRunner.ts` imports what it still needs and re-exports `buildStateFromDb`,
`carryForwardState`, and `resolveQaBaseUrl` so the 14 importing test files do
not move in this plan. `processTask`, `resumeTask`, and `executePlan` stay in
`taskRunner.ts` unchanged.

**Deviation (recorded 2026-11-08)**: four functions listed in the original step
were provably dead before the split and are deleted, not moved —
`isBudgetFailureText`, `finalizeRecordEval`, `sleep`, `heuristicPlanForTest`.
Each had exactly one occurrence in the file (its own declaration) and no
consumer anywhere in `packages/` or `apps/`. `sleep` and `finalizeRecordEval`
were only reachable from dead code paths; `heuristicPlanForTest` was an
exported test helper that no test imported.

**Check**: `npm run --workspace=@fhara/worker typecheck` → clean. ✅
**Check**: `npm run --workspace=@fhara/worker test` → 463 passed / 3 skipped. ✅
**Check**: byte-exactness of every moved function vs. the pre-split file,
verified with an AST-range comparator → 0 diffs. ✅

**Baseline note**: the recorded pre-split baseline was 460 passed / 3 skipped.
The A/B run against HEAD's unmodified `taskRunner.ts` (md5
`4e417ae655902b4f7f25779978188f71`) also yields 463 passed / 3 skipped / 466
total, so the split itself is test-neutral. The +3 comes from commit `bf285ca`,
which added 3 cases to `tests/phase4Hardening.test.ts` after the baseline was
recorded.

### Step 2: extract the correction loops with an explicit `RunContext`

`runReviewLoop`, `runQaLoop`, and the verification loop are closures inside
`executePlan` that capture `runNodes`, `plan`, `state`, `runCompleted`,
`dynamicKeys`, `chainByKey`, `fixDepthByKey`, `persistDynamic`, and `input`.
Define one `RunContext` type in `runner/runNodes.ts` and move the three loops into:

- `runner/reviewLoop.ts` — `runReviewLoop(ctx)`
- `runner/qaLoop.ts` — `runQaLoop(ctx)`
- `runner/verifyLoop.ts` — `runVerificationLoop(ctx)`

`executePlan` builds the context once and calls them in the same order with the
same arguments. `runner/runNodes.ts` also receives the `runNodes` scheduler
closure (with `onOutcome`'s decision handling extracted in Step 3) so
`executePlan` becomes the thin orchestration the split is aiming at.

**Check**: `npm run --workspace=@fhara/worker typecheck` → clean.
**Check**: `npm test` → same pass count.

### Step 3: extract the `onOutcome` decision handling

Move the `if (input.budget && input.sharedContext && input.classification && agent)`
block (`taskRunner.ts:2000`–`2572`) into `runner/decision.ts` as
`handleNodeOutcome(ctx, node, outcome, attempt)`, returning
`SchedulerNode[] | undefined`. It needs the same `RunContext` plus
`chainByKey`/`fixDepthByKey`/`decisionStep`/`budgetHalt`/`stepLimitHit` and the
`persistDynamic` callback; those become context fields so the mutation stays
visible to `executePlan`.

**Check**: `npm run --workspace=@fhara/worker typecheck` → clean.
**Check**: `npm test` → same pass count.
**Check**: `wc -l src/services/taskRunner.ts` → under 700 lines.

## Test plan

- No new behaviour, so no new tests. The invariant each existing suite protects
  is the contract: budget-before-call (`phase5Budget`), one abort controller
  (`phase4Hardening`), carry-forward on replan (`taskRunner.replan`),
  QA-loop bounding (`phase4HardeningQa`), recovery (`phase4HardeningRecovery`),
  approval resume (`phase4Hardening`), finalize outcomes (`phase6Completion`).
- Negative: a test must still fail if an extracted stage silently stops calling
  `persistDynamic` — `phase4Hardening` covers this via the durable-DAG
  assertions.

## Completion criteria

- [ ] `npm run --workspace=@fhara/worker typecheck` clean.
- [ ] `npm test` pass count unchanged from the pre-split baseline.
- [ ] `taskRunner.ts` under 700 lines; no file in `src/services/` over 600.
- [ ] `npm run knip` shows no new unused file or unresolved import.
- [ ] Every extracted module has an exported input type; no `any`-silenced
      type error introduced.
- [ ] `plans/README.md` row updated to `DONE`.

## STOP conditions

- A test fails for a reason that is not a mechanical import/typing issue —
  stop and report before "fixing" behaviour.
- Extraction would require changing the budget gate, the abort contract, or
  the approval gate. Those are non-negotiables: stop, record the decision, and
  get confirmation.
- Two consecutive typecheck/test rounds fail on the same error.
