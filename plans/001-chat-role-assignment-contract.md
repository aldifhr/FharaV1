# Plan 001: Chat role-assignment contract

## Status

- Priority: P1
- Size: L
- Risk: HIGH
- Dependencies: —
- Planned at: commit `caf816104b`, 2026-11-27

## Why this is needed

No role mismatch gets a task that cannot be executed. Today a user who
`@mentions` QA, Lead or Designer for a file change gets that read-only role as
the task assignee; the classifier accepts `{role:"qa", kind:"implementation"}`
without checking capabilities; and the offer path still uses the old
`FRONTEND_WORDS`/`BACKEND_WORDS` scorer while claiming keyword routing is gone.
The worker then refuses the write (`rolePolicy.ts:66-69`) and the task stalls.

## Target behaviour

| Request | Result |
| --- | --- |
| `@QA` + "create index.html" | No QA assignee; role-choice card or a code-writing owner |
| Classifier returns `qa` + `implementation` | Rejected or downgraded; never a code task owner |
| Offer from a CTO reply | Assignee comes from the validated routing role, not a keyword score |
| Low/no-confidence write request | Ask the role, do not auto-create a task in the same turn |

## Current state

- `apps/api/functions/lib/chat/writeOffer.ts:62-63` — `mentioned` selects the speaker even when `isCodeWritingRole` is false; `hard:true` at `:74`.
- `apps/api/functions/lib/chat/writeOffer.ts:58-59,80-89` — `codeRoleForRequest` (`lib/chat/intent.ts:562-568`) decides the fallback assignee and offer hint.
- `apps/api/functions/lib/chat/routingClassification.ts:35-49,52-55` — validates fields in isolation; `kind`/`role` pair unchecked.
- `apps/api/functions/lib/chat/taskAssignees.ts:31-43` — `routedOwners` excludes only the CTO.
- `apps/api/functions/chat.ts:1207-1232` — role-choice card and `dispatchTaskFromChat` can run in the same turn with `routing === null`.
- `apps/api/functions/chat.ts:1236,1279,1353` — `routeInfo` carries `domain`/`topic` only, never `routing.role`.
- Worker enforcement: `packages/worker/src/utils/rolePolicy.ts:24-26,66-69`.
- Shared capability source: `apps/api/functions/lib/roles.ts:368-370`.

## Decisions that must not change during execution

- The classifier remains the only owner decision; no second keyword/domain router may be added.
- The CTO is never an implementation owner.
- Low confidence never guesses a role and never falls back to Backend.
- Capability/permission truth stays in `lib/roles.ts`; the worker keeps denying writes at execution time.

## Steps

### Step 1: Validate the role/kind pair at the classification boundary

Extend `actionableRouting` (or the caller in `chat.ts`) so `kind:"implementation"`
requires a code-writing role resolved through `lib/roles.ts`. Invalid pairs are
treated as no owner.

**Check**: new `routingClassification.test.ts` covers `qa`+implementation,
`lead`+implementation, `frontend`+implementation, and low confidence.

### Step 2: Remove the read-only assignee path

In `writeOffer.ts:62-63`, require a code-writing role when `mentioned` is true;
otherwise use the file-derived role or no assignee. Keep the mention binding
for the reply text only.

**Check**: `writeOffer.test.ts` passes and a new case pins `@QA` + a file change
to no QA assignee.

### Step 3: Carry the validated role into the offer

Pass `routing.role` into `planWriteOffer` and prefer it over
`codeRoleForRequest` when building `assignee`/`hintFor`. Keep the file scorer
only as a topic hint for file paths, never as an owner.

**Check**: `chat.ts` call sites and `writeOffer.test.ts` updated; no diff in
tests that only assert keyword behaviour is weakened.

### Step 4: Stop the double action on low confidence

Skip `postRoleChoiceCard` when `autoCreated` is true, or make
`shouldAutoCreateTask` require an actionable routing for write work. The user's
pick must be able to redirect the task.

**Check**: a runtime test where the classifier returns no role creates no task
and posts exactly one role-choice card.

## Test plan

- `@QA` + write request → no QA in `assignedAgentIds`.
- Invalid classifier pair → no owner, role-choice card.
- Valid `frontend` + implementation → Frontend assignee and hard hint.
- Low-confidence work request → card only, zero tasks.
- A retry of the same request does not create a second task.

## Completion criteria

- [ ] No code-writing decision comes from `codeRoleForRequest`.
- [ ] No read-only role can appear as `assigneeAgentId` for implementation work.
- [ ] `pnpm --filter @fhara/api run typecheck` passes.
- [ ] Focused API chat/assignee/offers tests pass; new cases fail before the fix.

## STOP conditions

- A non-negotiable rule in `AGENTS.md` must change.
- A check fails twice after a reasonable fix.
- The change needs work outside this repository.
