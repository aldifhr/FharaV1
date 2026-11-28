# Plan 005: Clear project activity

> Implement every step and run its check. Stop on a STOP condition and report.
> Set the state in `plans/README.md` when the completion criteria pass.

## Status

- Priority: P3
- Size: S
- Risk: MEDIUM (deletes rows)
- Dependencies: —
- Planned at: commit `2fd2247176`, 2026-11-27

## Why this is needed

The `/activity` page (`apps/web/app/activity/page.tsx:63`) shows task events but offers no way to remove them. The user wants a "Clear all activity" action on the project-scoped view (`?project=…`).

## Target behaviour

On `/activity?project=<id>`, a "Clear all activity" button asks for confirmation, then removes every `taskEvents` row of that project. The all-projects view has no clear button.

## Current state

- `apps/web/app/activity/page.tsx:65` reads `api.taskEvents.listAll` / `listByProject`; `:88` has no header actions.
- `apps/api/functions/taskEvents.ts:1-137` is query-only; no delete function exists.
- `taskEvents` requires `projectId` and has a `by_project` index (`apps/api/functions/schema.ts:951-976`).
- `apps/api/functions/auditLog.ts:152-170` is the capped delete-many pattern; `apps/web/app/audit/page.tsx:207-249` is the confirm + chunked-delete UI pattern.

## Decisions that must not change during execution

- Scope is one project only. No global/all-projects clear: `listAll` filters after `.take()` (`taskEvents.ts:12-17`), so a global sweep cannot be made complete or safe with the same shape.
- The mutation checks `assertProjectAccess` exactly like `listByProject` (`taskEvents.ts:24`).
- Deletes are capped per call (200) and the UI repeats while `more` is true; every call remains one indexed query.
- Clearing activity does not touch tasks, runs, `agentEvents`, or the `audit` table.
- Confirmation is required; no auto-clear, no bypass.

## Steps

### Step 1: Add the backend mutation

Add `clearByProject({ projectId })` to `apps/api/functions/taskEvents.ts`: `assertProjectAccess`, indexed `by_project` read capped at 200, delete each row, return `{ deleted, more }`.

**Check**: `pnpm --workspace=@fhara/api typecheck` and a new case in `apps/api/functions/taskEventSequence.test.ts` proving another project's events survive.

### Step 2: Wire the button

In `apps/web/app/activity/page.tsx`, add `useMutation`, `ConfirmDialog`, `useToast`, a `busy`/confirm state, the header action shown only when `projectId` is set, and a loop that deletes until `more` is false.

**Check**: `pnpm --filter @fhara/web typecheck` → passes.

## Test plan

- Positive: all events of the selected project disappear; `more` is reported so the UI can repeat for >200 rows.
- Negative: events of another project remain; unauthorised project access is refused by `assertProjectAccess`.
- UI: button hidden in the all-projects view; disabled while busy; confirmation required.

## Completion criteria

- [ ] Mutation exists with an authz check and a bounded loop.
- [ ] Backend test covers cross-project isolation.
- [ ] Web typecheck and build pass.
- [ ] `plans/README.md` marks this plan DONE.

## STOP conditions

- A non-negotiable rule in `AGENTS.md` must change.
- A schema change needs a destructive operation.
- A check fails twice after a reasonable fix.
