# Plan 026: Decision Outcome Calibration

## Status

- Priority: P1
- Size: L
- Risk: MEDIUM (additive schema; one hook on the central event path; no
  behaviour change until a person applies a recommendation)
- Dependencies: 021 (routing / estimator visibility), 022 (subtask
  contract), 025 (requirements + coverage), replan intelligence
  (`plans.payload.replan`, 46f04fd), context snapshots (a52987d)
- Principle: deterministic first. No LLM call anywhere in this plan. The
  LLM never changes a prompt or a policy; every change is a person's
  explicit, audited Apply after seeing the diff.
- Planned at: commit `59b8508`, 2026-11-09

## Why

The orchestrator makes decisions (plan, routing pick, delegation, replan,
escalation route, QA/review loop continue/stop, decision-engine action),
and the run records them as events, but nothing ever asked whether a
decision turned out well. Routing priority, the Task Estimator and the
planner could be wrong in the same way run after run without anyone
seeing it.

## What landed

| Part | Where |
| --- | --- |
| Ledger table `decisions` (one row per decision: task, subtask, type, chosen, alternatives, reason, expected outcome = subtask objective / acceptance / requirement ids + texts, `snapshotId`, `sourceEventId`, `dedupeKey`, outcome + label) and `calibrationActions` (Apply / Dismiss) | `apps/api/convex/schema.ts` (end of file), validators in `apps/api/convex/lib/calibration/validators.ts` |
| Capture: pure `decisionFromEvent` over the events the run already writes (`plan.created`, `subtask.routed` incl. `loadAware` / a future `performance` payload, `orchestrator.delegation`, `plan.replan_diff`, `subtask.escalated`, `qa.fix_started` / `review.fix_started`, `qa.loop_stopped` / `review.loop_stopped`, `stall.repeated_output`, `orchestrator.decision`) | `apps/api/convex/lib/calibration/capture.ts` |
| One central hook: `orchestration.logEvent` (every worker event) plus the two backend inserts that bypass it (`plan.created` in `lib/planStore.ts:194`, `recordDelegation`) | `apps/api/convex/orchestration.ts:2050`, `:2689` |
| Worker: the only new events are the loops' max-round stop (`qa.loop_stopped`, `review.loop_stopped`) | `packages/worker/src/services/runner/qaLoop.ts:306`, `reviewLoop.ts:119` |
| Outcome: pure `buildTaskEvidence` + `labelDecision` (rules below) | `apps/api/convex/lib/calibration/outcome.ts` |
| Evaluation is scheduled (never awaited) when a task ends (`completeTask`, `tasks.cancel`, plan rejection) and, provisionally, when a subtask completes/fails; skipped for runs with no decision | `orchestration.ts:1689`, `:1835`, `tasks.ts:300`, `approvals.ts:77` |
| Signals + recommendations (pure) | `apps/api/convex/lib/calibration/aggregate.ts` |
| Queries / mutations: `calibration.forTask`, `calibration.summary`, `calibration.apply`, `calibration.dismiss`; internal `calibration.evaluateTask`, `calibration.backfill`, `calibration.backfillAll` | `apps/api/convex/calibration.ts` |
| Estimator multiplier setting `projects.estimatorMultipliers[{role, complexity?, tokens?, duration?}]`, applied by `estimatePlan` (exact complexity, then role-wide, else 1), passed by the worker (`planning.ts:160`) and the plan-edit recompute | `apps/api/convex/lib/estimate.ts`, `packages/worker/src/services/runner/planReview.ts` |
| UI: `/calibration` (Insights menu) and the Decisions section on `/runs/[taskId]` (decision → expected → label → factors, Inputs opens the Context Snapshot) | `apps/web/app/calibration/page.tsx`, `apps/web/components/runs/Decisions.tsx` |

## Labelling rules

Any "bad" factor → bad; else any "suboptimal" factor → suboptimal; else
the type's default. Unknown until the evidence exists; `final` once the
task is terminal.

- routing: bad = subtask failed/blocked, acceptance rejected/blocked, its
  key in a replan's failed set, a person rejected its file change.
  Suboptimal = >1 attempt, acceptance escalated, review requested changes
  on files it wrote (`fileChanges.subtaskKey` × finding `filePath`), a
  check that passed before it failed after it (regression), tokens or
  duration ≥ 3× its estimate. 2× is only noted. Prior history ("agent X
  failed capability Y 3/4 times", ≥ 3 prior, ≥ 50 % bad) is a note.
- plan vN: bad = rejected by the user, task failed on vN (final), final
  with `completed_with_gaps`. Suboptimal = replaced by a replan, edited by
  the user, planner missed requirements (coverage `uncovered` > 0 while vN
  was active), QA failed while active, task tokens ≥ 3× the estimate.
- replan: bad = task failed with the new version final, or its new nodes
  failed again and the task failed. Suboptimal = a later replan re-failed
  the same keys (repeated strategy), the quality check rejected a repeated
  strategy first, the new version was replaced again.
- escalation: repeated → suboptimal; then task done → good, else bad.
- QA / review loop: continue → next verdict passed = good, later passed =
  suboptimal, never passed or same output repeated = bad. Stop → repeated
  output = good; max rounds while findings still shrank = suboptimal.
- engine: dispatch actions by the target subtask; complete by task status
  and coverage; replan / ask_user by the task; step limit = bad.
- delegation: APPROVE/COMPLETE by the task; REJECT/REVISE done = good,
  else suboptimal; BLOCKED = unknown.

## Thresholds (recommendations)

| Signal | Minimum samples | Fires when | Apply |
| --- | --- | --- | --- |
| Routing per agent × capability | 5 labelled | good rate ≤ 40 % and another enabled agent declares the capability | agent priority → min(current − 1, best alternative − 1) (`agents.priority`, global per agent) |
| Estimator per project × role × complexity | 5 subtasks | median actual/estimate ≥ 1.5 or ≤ 0.67 (tokens and duration separately) | multiplier × ratio, clamped 0.25–10, 0.1 steps |
| Replan effectiveness | 5 labelled | good rate < 50 % | none (advisory, Dismiss only) |
| Planner requirement-miss | 5 plans with a coverage check | miss rate ≥ 30 % | none (advisory) |

Apply re-computes the recommendation server-side, refuses a stale diff
(`expectedFrom`/`expectedTo` must match and the setting must still hold
`from`), writes the setting's own audit row (`agent.update` /
`project.update`, `source: "calibration"`) plus `calibration.apply`.
Dismiss writes `calibration.dismiss`. An applied or dismissed
recommendation only comes back when decisions made after that action
meet the threshold on their own.

## Backfill

`npx convex run calibration:backfillAll '{"days":30}'` (internal). Days ≤
90, batches of ≤ 50 tasks, ≤ 1000 tasks per run, newest first with a
creation-time cursor. Idempotent: rows are keyed by `dedupeKey`, and the
evaluation patches only changed outcomes.

## Not done / open

- perf-routing's performance scores are not linked yet (only a pointer
  line on /calibration); `subtask.routed.performance` is captured when it
  appears.
- QA findings carry no file path, so a QA failure is attributed to the
  plan and the QA loop, not to individual routing picks.
- Live smoke and browser check pending.

## Checks

- `apps/api/convex/calibration.test.ts` (labelling rules, aggregation,
  thresholds, dismiss/apply resurfacing, no auto-apply + audit, backfill
  idempotence, live hook dedupe, terminal scheduling).
- `packages/worker/tests/estimate.test.ts` (multiplier reaches the worker
  estimate).
