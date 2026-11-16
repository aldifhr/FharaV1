# Plan 061: CTO auto-creates the task from a work-shaped chat message

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

- Priority: P1
- Size: M
- Risk: MEDIUM
- Dependencies: 059, 060
- Planned at: current working tree, 2026-11-16

## Why this is needed

In a project chat, a clear work request such as "create new file hello.html"
currently produces a chain of questions instead of work: the CTO asks the user
to reply `gas` or press **Create task** (`apps/api/convex/lib/prompts/chat.ts:385`),
then the specialist that inherits the conversation asks again with
"Chat can't change files. Want me to create a task for it?"
(`apps/api/convex/lib/chat/offerBrief.ts:112`, generated into
`apps/api/convex/lib/prompts/rolePrompts.data.ts:6`). Only after a second user
action does a task exist (`apps/api/convex/lib/chat/startTask.ts:1-6`). The user
wants the CTO to mention the owning teammate and create the task in one turn,
while keeping the human approval gate before any file is changed.

## Target behaviour

| Message in project chat | Today | After this plan |
| --- | --- | --- |
| "create new file hello.html" | CTO asks → user confirms → Frontend asks again → user confirms → task | CTO replies "Created a task and handed it to @Rey" and the task already exists |
| "janji besok aku bikin login" / greeting / research / status | chat only | chat only, unchanged |
| `apply_changes`, `git_push`, `run_command`, `merge_pr` | gated by approval | **unchanged** — still gated |
| Task created from chat | `status: "queued"` (`apps/api/convex/tasks.ts:280`) | unchanged; queued, NOT auto-approved beyond the task's permission mode |

## Current state

- Work-shape detection already exists in the action: `workShaped`, `writeRequest`,
  `runRequest` at `apps/api/convex/chat.ts:1213-1217`; `intent` is suggestion-only
  at `apps/api/convex/chat.ts:1177-1179`.
- Task creation from chat is reached only through explicit `/task`, `kerjakan …`,
  or a bare `gas` after an offer (`apps/api/convex/lib/chat/startTask.ts:1-6`);
  the CTO path calls `api.tasks.createFromCommand` at `apps/api/convex/chat.ts:547`.
- `createFromCommand` dedupes a live task with the same command
  (`apps/api/convex/chat.ts:544`), resolves the agent pool and `routingHint`
  (`apps/api/convex/tasks.ts:267-273`), and inserts `status: "queued"`
  (`apps/api/convex/tasks.ts:275-287`).
- The UI shows **Create task** from `messages.taskOffer` or the old wording rule
  (`apps/web/lib/taskOffer.ts:17-21`); used offers render "Task created" instead.
- Auto-approved rows (`decidedBy: "auto"`) exist only for the task's permission
  mode (`apps/api/convex/orchestration.ts:1483,1552,1570`) and never for push/PR.
- The Plan card is posted without `agentId`, which is why it renders as "Agent"
  (`apps/api/convex/planReview.ts:295-302`, `apps/api/convex/lib/roles.ts:409`).
- Existing tests pin the offer copy in
  `apps/api/convex/lib/chat/chatOffer.test.ts:60` and
  `apps/api/convex/lib/chat/writeOffer.test.ts:87`.

## Decisions that must not change during execution

1. The human approval gate (root `AGENTS.md` non-negotiable 5) stays. Auto-create
   only removes the chat-side confirmation; it does not approve, apply, push or
   merge anything. `decidedBy: "auto"` remains limited to the task's permission
   mode and never covers push/PR.
2. No second planner and no parallel routing path. The CTO remains the
   orchestrator; the worker planner still owns `ExecutionPlan`
   (root `AGENTS.md`, worker `AGENTS.md`).
3. Provider keys never leave the backend; no credential is added to the client.
4. Task/chat context isolation stays: the auto-created task carries the same
   `conversationId` + `routingHint` as a manually created one
   (`apps/api/convex/tasks.ts:283`, `apps/api/convex/lib/chat/startTask.ts:5-6`).
5. Only work-shaped messages auto-create. Greetings, questions, research and
   status stay chat-only. An @mention still takes precedence over auto-routing.
6. Idempotency: one task per user message. Reuse the existing live-command
   dedupe (`apps/api/convex/chat.ts:544`); a retry or a duplicated reply must not
   create a second task.
7. The project opt-out is an additive optional field (`v.optional(v.boolean())`);
   absent means auto-create ON. No destructive migration, no drop.

## Steps

### Step 1: Add the project opt-out field

Add `autoCreateChatTasks: v.optional(v.boolean())` to the projects table in
`apps/api/convex/schema.ts`; absent = enabled. No backfill, no index.

**Check**: `pnpm --filter @fhara/api run typecheck` → exit 0;
`pnpm --filter @fhara/api exec vitest run convex/securityInvariants.test.ts` → green.

### Step 2: Extract one pure auto-create decision helper

Create `apps/api/convex/lib/chat/autoTask.ts` exporting a pure function that
answers "should this message auto-create a task?" from the existing inputs only:
`workShaped`, `runRequest`, `optionPick`, `pasted`, `mentionedAgents.length`,
`autoCreateChatTasks !== false`. It must return `false` for every non-work shape
and for any @mention. No LLM call, no new env var.

**Check**: new `autoTask.test.ts` covers all positive and negative rows of the
target-behaviour table → green.

### Step 3: Create the task in `answerChat` before the reply is generated

In `apps/api/convex/chat.ts`, after the work-shape block at line 1217 and before
the responder is chosen at line 1293, call the existing task-creation path with
the latest user message when the Step 2 helper returns true. Reuse
`routingHint`/assignee resolution from `apps/api/convex/lib/chat/taskAssignees.ts`
and the dedupe at line 544. Set `conversationContext: false` (the task is built
from the user's own message, not an offer). Do not set any approval row here.

**Check**: `pnpm --filter @fhara/api run typecheck` → exit 0; the Step 4
convex-test below proves one task per message.

### Step 4: Change the CTO copy and stop emitting a fresh offer

Update `buildPlanningGuidance` in `apps/api/convex/lib/prompts/chat.ts` around
line 385: replace "reply gas or press Create task" with a past-tense line naming
the teammate ("I created a task and handed it to @Rey"). Do not attach
`taskOffer` to an auto-created reply so `offersCreateTask` returns false
(`apps/web/lib/taskOffer.ts:17-21`). Update the existing offer-copy assertions in
`chatOffer.test.ts:60` and `writeOffer.test.ts:87` to the new invariant: the
offer field is absent for auto-created replies, not deleted for the manual
`/task` path.

**Check**: targeted convex tests above → green.

### Step 5: Remove the duplicate question from the specialist prompts

In the "In Chat" section of `apps/api/convex/lib/prompts/roles/FRONTEND.md` (and
the other role files that carry the same line), replace the "Want me to create a
task for it?" instruction with: a routed specialist answers the question; it
never asks for task creation. Regenerate `rolePrompts.data.ts` with
`pnpm run prompts:roles` and update the seeded copy in
`apps/api/convex/lib/prompts/agents.ts:50` so old fixtures do not reintroduce it.

**Check**: `pnpm run prompts:roles` → generated file updated;
`pnpm --filter @fhara/api exec vitest run convex/personalTone.test.ts` → green
after updating the intentional snapshot.

### Step 6: Attribute the Plan card (small, related fix)

Set the Plan card's `agentId` to the orchestrator when it is in the task's
assigned pool (`apps/api/convex/planReview.ts:295-302`), so the UI shows CTO
instead of the generic "Agent" label. When the orchestrator is not in the pool,
keep the row as-is (no new UI label was added). Do not change the card kind or
its live-state rendering.

**Check**: a convex-test asserts the card row carries `agentId` when the CTO is
assigned.

### Step 7: Full verification

Run the checks in the order below and report every failure, including
pre-existing ones.

**Check**:
`pnpm --filter @fhara/api run typecheck`
`pnpm --filter @fhara/api run test`
`pnpm --filter @fhara/web run typecheck`
`npm run knip`
`pnpm run check:budget` (record pre-existing failures separately)

## Test plan

- Positive: "create new file hello.html" → exactly one `queued` task with the
  source `conversationId` and a routing hint naming the frontend capability;
  CTO reply text has no question; no `taskOffer` on that reply.
- Negative: greeting, "what is Convex?", research comparison, status question →
  zero tasks created.
- Negative: message with `@Rey` → no auto-create; existing @mention flow wins.
- Idempotency: repeat the same command / retry the reply → still one live task.
- Gate: in `supervised` mode, auto-created task still reaches
  `needs_approval` with a pending `apply_changes` row; no approval row is
  auto-granted by this plan.
- Copy: routed Frontend reply no longer contains "Want me to create a task".

## Completion criteria

- [x] Steps 1-7 done, each with its check recorded.
- [x] API typecheck + full API suite green: 157 files / 1523 tests.
- [x] Web typecheck green; knip reports no new unused module or dependency
      (all reported findings pre-date this plan).
- [x] Target behaviour verified: convex-test in `chatNightE2e.test.ts` covers the
      work-shaped task, chat-only negatives, @mention opt-out, idempotency with
      no approval row, and no `taskOffer` on the auto-created reply.
- [x] `plans/README.md` state for 061 set to `DONE`.

Pre-existing guard failures recorded, not introduced here: `check:budget` still
fails on the already-oversized `apps/api/convex/chat.ts` and `schema.ts`, which
this plan necessarily grew by a small amount. `check:cycles` is green for all
four packages. Live browser/provider smoke was not run: no working LLM provider
is configured in this environment.

## STOP conditions

- Any change to non-negotiable 5 (approval gate) or 7 (additive schema) is needed.
- A destructive migration, force-push, or change outside this repository is needed.
- A check fails twice after a reasonable fix.
- The auto-created task starts applying or pushing files without the existing
  approval row.
