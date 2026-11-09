# Plan 021: Decision visibility (Plan Inspector, Task Estimator, Routing, Decomposer graph)

## Status

- Priority: P1
- Size: L
- Risk: MEDIUM (adds an approval kind and a pause between planning and execution)
- Dependencies: 019 (chat cards), 020 (permission modes — honoured when present)
- Planned at: commit `ceb5a82`, 2026-11-09

## Why this is needed

The user could not see, before money and time were spent, what the planner
decided (subtasks, roles, files), what the run would roughly cost, or —
afterwards — why a request was classified and routed the way it was. A bad
plan could only be stopped by cancelling the whole task.

## Target behaviour

1. **Plan Inspector.** Project setting `planReview` (`off` default |
   `medium_plus` | `always`, `lib/planReviewPolicy.ts`). When it applies, the
   worker stops after `plan.created` (`services/runner/planReview.ts`
   `planReviewGate`): a `plan` approval, task `needs_approval`, task event
   `task.stage {stage: "waiting_plan_approval"}`, one Plan card message
   (`card.kind = "plan"`, live state from `planReview.forTask`).
   - Approve → `approvals.approve` → `planReview.onPlanApproved` re-queues
     the task; the next claim adopts the approved stored plan (validated by
     `validateStoredPlan`) and the gate passes because that version is
     approved. (Same re-queue path as the plan-013 `ask_user` answer, so
     the run keeps its replan loop.)
   - Reject → task `rejected`, pending subtasks `skipped`.
   - Edit (title / description / role from enabled agents / remove with
     dependents re-linked or refused) → `planReview.editPlan` →
     `lib/planEdit.ts` → the shared plan validator → version N+1,
     `createdBy: "user"`, recomputed estimate, old approval `cancelled`
     (superseded), new pending approval. Invalid edits are refused whole.
   - Replan with note → `tasks.planReviewNote` + re-queue; the worker plans
     afresh with the note as planner feedback; the next planner `savePlan`
     clears the note.
   - Permission modes: `full_access` skips review unless the setting is
     `always` (`plan.review_skipped` event).
2. **Task Estimator.** Pure `lib/estimate.ts` (no LLM call), computed by the
   worker right after planning from routed roles, the resolver's expected
   model per agent (`TaskLlmResolver.expectedModelFor`, no random draw) and
   project history (`planReview.estimateSamples`: last 400 tokenUsage rows
   with a subtask key). Stored on `plans.estimate`; a replan carries the
   first estimate forward (`carriedOver`). Shown on the Plan card and the
   runs header; estimate vs actual on the runs page after the run.
3. **Routing Inspector.** `lib/routing.ts` builds classification → planner →
   capability → role (+ why) → hand-offs from existing events only;
   `runs.get` returns it as `routing`.
4. **Decomposer graph.** `runs.get.graph` + `components/runs/PlanGraph.tsx`
   (layered SVG layout, status-dot colours), toggled with the timeline.

The plan validator moved to `apps/api/convex/lib/planValidation.ts` (with
`lib/ownershipPaths.ts`) so the backend validates edits with the same rules;
the worker modules re-export it under their old paths.

## Schema (additive)

`projects.planReview?`, `approvalKind += "plan"`, `plans.createdBy += "user"`,
`plans.estimate?`, `tasks.planReviewNote?`, `messages.card.kind += "plan"`.

## Completion criteria

- [x] `npm run typecheck` (web, api, worker)
- [x] `convex/planReview.test.ts`, `convex/lib/routing.test.ts`
- [x] `tests/planReview.test.ts`, `tests/estimate.test.ts`, `tests/layering.test.ts`
- [ ] Live smoke: a project on `always` pauses, edit + approve runs the edited plan
