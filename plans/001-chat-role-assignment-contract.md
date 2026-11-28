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
| `@QA` + "create index.html" | No QA assignee; CTO or a code-writing owner, no role-choice card |
| Classifier returns `qa` + `implementation` | Rejected or downgraded; never a code task owner |
| Offer from a CTO reply | Assignee comes from the validated routing role, not a keyword score |
| Low/no-confidence write request | CTO answers and owns the assignment; no role-choice card, ever |

## Current state

- `apps/api/functions/lib/chat/writeOffer.ts:62-63` — `mentioned` selects the speaker even when `isCodeWritingRole` is false; `hard:true` at `:74`.
- `apps/api/functions/lib/chat/writeOffer.ts:58-59,80-89` — `codeRoleForRequest` (`lib/chat/intent.ts:562-568`) decides the fallback assignee and offer hint.
- `apps/api/functions/lib/chat/routingClassification.ts:35-49,52-55` — validates fields in isolation; `kind`/`role` pair unchecked.
- `apps/api/functions/lib/chat/taskAssignees.ts:31-43` — `routedOwners` excludes only the CTO.
- Auto-created chat tasks are dispatched after the CTO/Lead reply (2026-11-27):
  `chat.ts` passes the first non-CTO structured handoff role as `preferredAgentIds`, so a
  classifier with no role still gets the owner the CTO actually chose. No owner means no
  owner is guessed.
- Assignment cards list only resolved owners (2026-11-27): `startTask.ts:94` no longer falls back to the whole team, and `ChatCard.tsx` hides the empty assignee row. A task with no resolved owner shows no role chips; the orchestrator still decides later.
- Role-choice fallback removed (2026-11-27): `postRoleChoiceCard`, `ROLE_CHOICE_QUESTION`, `lib/chat/roleChoiceCard.ts` and the web `role_choice` card/`onChooseRole` plumbing are gone; the schema literal stays for stored rows. Low-confidence work is answered by the CTO and dispatched once by `dispatchTaskFromChat`.
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

### Step 4: Remove the role-choice fallback entirely — DONE 2026-11-27

Decision recorded from the developer: the CTO always decides the owner; there
is no "ask the user to pick a teammate" path. All three emitters in `chat.ts`
(CTO pick without an owner, low-confidence work, invalid structured reply) were
removed, together with the helper, prompt constant, backend module and the web
card/renderer/`onChooseRole` plumbing. An invalid structured reply now leaves
the CTO's plain answer standing; no extra bubble is posted.

The `role_choice` literal stays in the schema and generated datamodel so stored
rows still validate (additive/reversible rule).

**Check**: no `ROLE_CHOICE_QUESTION` / `postRoleChoiceCard` / `onChooseRole`
references remain; API + web typecheck pass.

## Test plan

- `@QA` + write request → no QA in `assignedAgentIds`.
- Invalid classifier pair → no owner, no role-choice card.
- Valid `frontend` + implementation → Frontend assignee and hard hint.
- Low-confidence work request → CTO answer and at most one task, zero cards.
- A retry of the same request does not create a second task.

## Completion criteria

- [ ] No code-writing decision comes from `codeRoleForRequest`.
- [ ] No read-only role can appear as `assigneeAgentId` for implementation work.
- [ ] No role-choice card is emitted anywhere in chat.
- [ ] `pnpm --filter @fhara/api run typecheck` passes.
- [ ] Focused API chat/assignee/offers tests pass; new cases fail before the fix.

## STOP conditions

- A non-negotiable rule in `AGENTS.md` must change.
- A check fails twice after a reasonable fix.
- The change needs work outside this repository.
