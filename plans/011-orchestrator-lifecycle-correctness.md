# Plan 011: Orchestrator lifecycle correctness

## Status

- Priority: P1
- Size: L
- Risk: MEDIUM
- Dependencies: 005, 006, 010
- Planned at: commit `d768a49`, 2026-11-08
- State: **DONE** (completed 2026-11-08; all five steps verified and
  covered by regression tests)

## Why this is needed

Tasks can create duplicate dynamic delegation nodes, misreport structural QA as responsive visual testing, and fail completion after QA has passed. The worker lifecycle needs one authoritative distinction between planned objective nodes and dynamic recovery work.

## Target behaviour

- Only planned QA nodes are objective requirements.
- QA passes only when the scheduler completed and every planned QA verdict is explicitly `passed`.
- Structural QA never claims viewport or responsive testing.
- Dynamic recovery remains bounded and cannot create duplicate objective requirements.
- A task run updates completion state immediately when a node succeeds.

## Current state

- `packages/worker/src/services/taskRunner.ts:1968-1975` checks persisted `completedKeys` during a live run.
- `packages/worker/src/services/taskRunner.ts:2664-2691` treats any verdict other than `failed` as success.
- `packages/worker/src/services/taskRunner.ts:2683-2688` emits a hardcoded responsive QA message.
- `packages/worker/src/execution/agentExecutor.ts:518-549` derives visual QA from command regex and returns `inconclusive` as completed.
- `packages/worker/src/execution/qa.ts:154-249` uses a structural viewport and labels it as a viewport check.
- `packages/worker/src/services/taskRunner.ts:1585-1591` runs subsets with dependencies filtered to the subset.

## Decisions that must not change during execution

- Preserve approval, budget, sandbox, service-token, terminal-task immutability, and durable dynamic-subtask rules.
- Do not add a second planner or routing authority.
- Structural QA may check reachability, DOM structure, console errors, and network errors only.
- Visual QA is opt-in and must never run when explicitly prohibited.

## Steps

### Step 1: Make QA verdict handling fail closed

Require scheduler completion and explicit `passed` verdicts. Treat `inconclusive` as blocking.

**Check**: focused QA/task-runner tests.

### Step 2: Make QA reporting reflect actual checks

Remove hardcoded responsive claims. Build the message from the actual report and distinguish structural from visual checks.

**Check**: worker tests and grep for prohibited responsive claims.

### Step 3: Carry explicit visual-QA intent

Replace duplicated command regex decisions with planner metadata threaded into execution.

**Check**: planner and QA tests for positive and negated visual requests.

### Step 4: Fix live completion and dependency semantics

Use a run-local completion set and preserve prerequisite semantics when running review/QA subsets. Add regression tests for same-run completion and subset dependencies.

**Check**: worker typecheck and focused orchestration tests.

### Step 5: Bound dynamic recovery task-wide

Track dynamic-node additions for the whole task and reject duplicate recovery/delegation requests after objective completion.

**Check**: delegation/recovery tests and clean live smoke task.

## Test plan

- Inconclusive QA cannot emit `qa.passed`.
- Structural QA output contains no desktop/tablet/mobile or responsive-testing claim.
- Explicit visual prohibition never captures screenshots.
- Dynamic QA/recovery nodes do not become objective requirements.
- A node completed earlier in the same run is not pending.
- Dependency prerequisites are not silently removed.

## Completion criteria

- Focused worker tests pass.
- Worker typecheck passes without new errors.
- One clean live task has one planned QA verdict, no screenshot/viewport events for structural QA, no duplicate delegation loop, and final approval.

## STOP conditions

- A schema or non-negotiable security rule must change.
- Existing local modifications make attribution impossible; stop and report rather than overwrite them.

## Completion evidence (2026-11-08)

- **Step 1 (fail-closed verdicts)** — `executeQa` returns a *failed* node
  outcome for `inconclusive` (verdict preserved in meta); `runQaLoop`
  and `evaluateObjective` both require exactly `passed`. Regression tests
  in `tests/qaThreading.test.ts` (inconclusive verdict → failed outcome +
  preserved meta) and `tests/decision.test.ts`.
- **Step 2 (honest reporting)** — structural mode checks are labelled
  `structural check` (no viewport/responsive language; `checkLabelFor`
  in `execution/qa.ts`); the verdict summary names the URL and the checks
  that actually ran. Code grep: no screenshot/baseline/viewport claims in
  structural paths; positive and negated visual requests both covered by
  `tests/planner.test.ts` + `tests/qaThreading.test.ts`.
- **Step 3 (explicit visual intent)** — `plan.visualQa` is the planner
  metadata threaded runner → executor; `wantsVisualQa()` is the heuristic
  fallback for pre-011 plans only (prohibition-safe: plural-tolerant).
- **Step 4 (completion + dependencies)** — run-local `runCompleted` set
  seeded once from `completedKeys`; review/QA loops deliberately clear
  their own keys before re-runs; `runNodes` fails closed on unmet
  non-stage prerequisites (subset semantics preserved).
- **Step 5 (bounded dynamic recovery)** — `dynamicKeys` keeps dynamic
  nodes out of objective requirements; delegation count + depth +
  circularity gates bound creation; the `plannedCapabilities` guard
  suppresses both the deterministic QA heuristic and agent
  `delegationRecommendation`s for capabilities the plan already
  schedules, including short capability aliases ("QA" ==
  "browser-testing").

### Live verification (smoke)

Task `md76gre1tcsynhghwd8qpgf0gd8ht0rx` (structural-only QA with
prohibitions): plan v1 only (implement → review → qa), one `qa.passed`
with exactly two structural checks, no screenshot/baseline/viewport
events, no duplicate delegation, no replan, approval auto-granted
(auto mode), final CTO summary, task `done`.

### Follow-ups (not in this plan)

- The chat message for Q&A picks used to auto-create tasks (fixed);
  task-level pause-for-input remains a separate design if wanted.
- Screenshot/baseline QA only ever runs when the plan says visual;
  Playwright browser revision must match the worker's playwright build
  (environment maintenance, not code).
