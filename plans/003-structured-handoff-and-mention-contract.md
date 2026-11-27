# Plan 003: Structured handoff and mention contract

## Status

- Priority: P1
- Size: L
- Risk: MEDIUM
- Dependencies: 001
- Planned at: commit `caf816104b`, 2026-11-27

## Why this is needed

The seeded CTO and Lead personas still tell the model to write direct inline
`@Role` instructions, while the chat system prompt forbids `@mentions` in the
message and requires a structured `handoff` array. A model that follows its
persona produces no handoff entry, so the teammate is never paged. The test
suite that used to pin handoff delivery is also stale: 17 of 19 tests in
`chatHandoffTools.test.ts` fail on the current `HEAD` (verified by stashing the
audit edits and rerunning), so the refactor is not actually protected.

## Target behaviour

- CTO/Lead output uses `{ message, handoff[] }` only; no `@Role` in `message`.
- An unmatched handoff role is shown to the user instead of disappearing.
- Handoff delivery is covered by a green runtime test suite.

## Current state

- `apps/api/functions/lib/prompts/roles/CTO.md:31` and `LEAD.md:26-32` instruct inline `@Frontend, …` and list six roles (no `@CTO`).
- `apps/api/functions/lib/prompts/chat.ts:529,558` forbids `@Name`/`@Role` in the message; `:537` supplies the enum.
- Generated copies: `apps/api/functions/lib/prompts/rolePrompts.data.ts:5-6`; prior seeds need updating so unedited live agents follow the new template.
- `apps/api/functions/chat.ts:1475-1507` — structured conversion, now surfaces `unmatchedHandoffRoles` after this audit.
- `apps/api/functions/lib/chat/handoff.ts:57-59` — helper is now wired; pinned by `handoff.test.ts:48`.
- `apps/api/functions/chatHandoffTools.test.ts:27-52` — mock still derives handoffs from `@role` in prose; 17 failures at `HEAD`.
- `apps/api/functions/lib/chat/roleMentions.ts` and its test were deleted in this audit (no production caller, regex-based duplicate).

## Decisions that must not change during execution

- Handoff roles come only from the validated `RoleKey` enum; free-text parsing is not reintroduced.
- One mention per reply and no synthetic mentions stay in force.
- Prompt wording stays in `lib/prompts/`; generated data and prior seeds are regenerated, not hand-edited.

## Steps

### Step 1: Align the persona prompts with the structured contract

Remove the inline-`@Role` instruction from `CTO.md` and `LEAD.md`; state that
teammates are requested through the structured handoff and that the message
stays plain prose. List all seven live roles.

**Check**: prompt-contract tests updated and passing.

### Step 2: Regenerate prompt data and prior seeds

Run the role-prompt builder and add the previous seeds so already-seeded agents
follow the new template without a manual reset.

**Check**: `pnpm run prompts:roles` and the runtime function bundle build; no
stale inline-`@Role` instruction remains in generated data.

### Step 3: Repair the handoff runtime tests

Update `chatHandoffTools.test.ts` so its LLM mock emits the structured JSON
contract instead of parsing prose. Fix the production cause for any failure
that is a real defect, not a stale assertion. Never weaken an assertion to get
green.

**Check**: `pnpm --filter @fhara/api exec vitest run functions/chatHandoffTools.test.ts` → 19/19.

## Test plan

- A CTO reply with one handoff queues exactly that teammate once.
- An unmatched handoff produces a visible system line and no phantom agent.
- An options-block reply produces no handoff.
- Tools-off handoff still reaches the teammate.

## Completion criteria

- [ ] No persona prompt tells CTO/Lead to write `@Role` in the message.
- [ ] Generated prompts and prior seeds regenerated.
- [ ] `chatHandoffTools.test.ts` green from a clean `HEAD`.
- [ ] API typecheck passes.

## STOP conditions

- A non-negotiable rule in `AGENTS.md` must change.
- A check fails twice after a reasonable fix.
- The change needs work outside this repository.
