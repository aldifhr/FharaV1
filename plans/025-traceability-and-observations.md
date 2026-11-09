# Plan 025: Intent-to-execution traceability and execution observations

## Status

- Priority: P1
- Size: M
- Risk: MEDIUM (a new gate before "done"; additive schema only; no new
  task status)
- Dependencies: 013 (decision engine, bounded replan), 022 (subtask
  contract, acceptance gates)
- Principle: deterministic first; the LLM only where reasoning is needed
  (extracting requirements from free text, inside the existing planner
  call).

## Why this is needed

A task was "done" when every subtask was accepted and the evaluator
passed. Nothing checked the result against what the user actually asked
for: "login, register, logout, dan refresh token" could finish with three
of the four done, because no subtask was ever planned for the fourth and
every gate that did run passed. The decision engine also read free-text
reasons only; the facts behind them (which gate failed, which files fell
outside scope, a provider 5xx versus a real defect) were not typed.

## Target behaviour

| Area | After the change |
| --- | --- |
| Requirements | At plan time the request (`task.command`, without attached file contents) becomes `requirements[] = {id, text, span, source}`. The planner returns them in the SAME call as the plan (`requirements` + per-subtask `requirementIds`); when that output is missing or unusable, a deterministic splitter runs (bullets, sentences, list items split on commas and `and/dan/serta/plus/&`). Replans reuse the stored list (stable ids) and the prompt lists it. |
| Mapping | Declared ids are kept (planner ids translated to r1…rn, unknown ids dropped). A single requirement is served by every subtask. Otherwise a requirement no subtask declared is linked to the implementing subtasks (not review / QA) whose title, description or objective names it; a requirement nothing names stays unmapped. |
| Storage | `ExecutionPlan.requirements` (plan payload), `subtasks.requirementIds`, `tasks.requirements` (written by `writePlanVersion` from the payload; a version without requirements keeps the stored list), `tasks.requirementCoverage` (last check). |
| Evidence | Per subtask: its `gateResults` (verification typecheck/test/command, review, output, file_exists), the QA verdict of QA nodes, and its changed files. Linked to requirements through `requirementIds`. Runner-added nodes (fix, delegation) are covered by their parent. |
| Coverage check | `lib/requirements.ts#computeRequirementCoverage`, run by the worker after the acceptance stage (`runner/coverage.ts`). `uncovered` = no subtask; `missing_evidence` = a mapped subtask is unfinished, has a rejected/blocked/escalated acceptance or failing evidence, or no mapped subtask has passing evidence (a passing gate, a passing QA verdict, or changed files); `covered` otherwise. Event `requirements.coverage`. |
| Not done | A gap is a bounded replan through the existing path (`replan` outcome, feedback `Requirements not covered: …` listing each gap). With no replan left the task ends **completed with gaps**. |
| Observations | `ExecutionObservation {eventType, source{agentId, subtaskKey, tool}, facts{affectedFiles, errorCode, findings}, evidenceRefs, observedAt}` derived by a fixed table from existing events (`lib/observations.ts`), stored in `executionObservations` (`by_task`) by `logEvent` and `updateExecution`. The decision engine's `DecisionObservation.observations` carries the typed observation for the settled node (additive; every existing field unchanged) and the advisor prompt lists them. |
| UI | `/runs/[taskId]`: a "Requirements" section (requirement → subtasks → acceptance → evidence → state) and an "Observations" list before the events. The task thread shows the same Requirements block under Subtasks. Theme tokens only, divide-y, no pills or tinted cards. |

## Decisions that must not change during execution

### 1. Status semantics: no new task status

"Completed with gaps" is **`status: "failed"`** plus
`requirementCoverage.outcome = "completed_with_gaps"` and an error message
starting with `Completed with gaps. Requirements not covered: …`. This
follows the existing convention for budget exhaustion and cancellation
(terminal `failed` + a distinguishing event/field): the `taskStatus`
union, the terminal guard (`completeTask`), recovery, the board columns
and every status switch are unchanged. A task with gaps is never `done`.
`requirementCoverage.outcome` is `covered` (the check did not block),
`gaps` (a replan was requested), or `completed_with_gaps`.

### 2. Single-requirement requests

A request with one requirement is served by the whole plan. If its only
shortfall is missing evidence, the check does not block (the acceptance
stage and the evaluator already judged that result); an uncovered
requirement always blocks. With two or more requirements every gap
blocks.

### 3. Back-compat

Plans and tasks without requirements (anything planned before this
change) skip the check. Resume after approval has no replan budget, so a
gap there ends completed with gaps directly (same as the acceptance
stage).

### 4. Observations are deterministic

No LLM produces or classifies an observation. Provider errors are
recognised by fixed patterns (429 / rate limit, 401/403, 5xx, network,
circuit breaker). The deadlock & stall detector's `stall.<kind>` events
map 1:1 (`dependency_deadlock` / `no_runnable_nodes` → `dependency_blocked`,
`agent_stalled` / `repeated_output` → `no_progress`,
`provider_unavailable` → `provider_error`); a timed-out subtask is
`no_progress`.

## Steps (done)

1. Shared pure libs `apps/api/convex/lib/requirements.ts`,
   `lib/observations.ts`; validators `lib/traceValidators.ts`;
   `requirementIds` in `subtaskContractFields`.
2. Schema (additive): `tasks.requirements`, `tasks.requirementCoverage`,
   `subtasks.requirementIds`, table `executionObservations` + `by_task`.
3. Planner: prompt asks for / lists requirements; `withRequirements`
   attaches and maps them on LLM and fallback plans; `planValidation`
   carries `requirementIds` and `requirements`.
4. Worker coverage stage after acceptance; replan / completed-with-gaps
   endings; `worker.recordRequirementCoverage` (token-gated, lease-fenced).
5. Observation recording in `logEvent` / `updateExecution`; decision
   engine input; advisor prompt.
6. Queries `traceability.requirements` / `traceability.observations`;
   UI components `components/runs/Requirements.tsx`, `Observations.tsx`.

## Test plan

- `packages/worker/tests/requirementsTrace.test.ts`: fallback extraction
  (auth example with spans, bullets, single request, "A and B" rule), LLM
  normalization and id translation, mapping, coverage states, and
  `processTask` end to end: the auth plan without a refresh-token
  subtask is not done (completed with gaps, `r4` uncovered); with it,
  done; a plan without requirements is not gated.
- `apps/api/convex/traceability.test.ts`: the observation mapping table,
  stored observations from `logEvent` / `updateExecution`, requirements
  stored by `savePlan`, the coverage query, and the lease fence on
  `recordRequirementCoverage`.

## Not verified

- No live run against a real provider: the planner's `requirements`
  output is only exercised through parsing tests.
- The UI sections are typechecked, not browser-verified.
