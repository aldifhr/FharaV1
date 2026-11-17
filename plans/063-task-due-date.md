# 063 — Task due date

## Goal

Tasks can carry a due date, shown like the reference flow ("Build pricing A ·
due Thu 30 Oct"). The date is extracted at planning time from the user's own
stated deadline — never invented.

## Changes

1. Schema (additive): `tasks.dueAt: v.optional(v.number())` — ms epoch.
2. Worker: the planner may output top-level `"due"` (ISO date) when the
   request states a deadline; `parsePlanDue` normalizes it to `dueAt` on the
   `ExecutionPlan` (pure, unit-tested). `finalize` forwards it to `savePlan`.
3. Backend: `worker.savePlan` / `orchestration.savePlan` accept `dueAt`;
   `planStore.writePlanVersion` patches the task. `tasks.create` also accepts
   `dueAt` for future setters.
4. Web: the docked task list (`TaskDock`) and the task thread header
   (`TaskThreadHeader`) show "due <Mon DD>"; overdue + not finished renders in
   the warn tone.

## Definition of done

- Worker tests pass (`parsePlanDue` cases); backend typecheck + suite pass.
- No field dropped; legacy tasks without `dueAt` render unchanged.
