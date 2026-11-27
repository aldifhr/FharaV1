# Plan 084: Role mention and ownership semantics

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

- Priority: P2
- Size: M
- Risk: MEDIUM
- Dependencies: 040, 076, 078
- Planned at: commit `d6cf0a6c83`, 2026-11-27

## Why this is needed

Three reported defects share one seam: deterministic role mentions in chat are
turned into task owners and response owners, but the rules disagree. A user who
types `@CTO` sees the mention vanish with no explanation. A CTO/Lead reply that
names two roles loses one mention, while the planner rule says each mentioned
role gets a subtask. A research task can end up reported by the CTO even though
the roster comment says the CTO never owns work. Fixing any one of them by
changing only its local helper would move the mismatch to another surface.

## Target behaviour

- A `@CTO` that cannot create an owner gets an explicit, visible reason; it is
  never silently dropped from the routing hint and pool.
- Reply normalization either keeps every addressed role mention or the planner
  rule is rewritten to match the one-mention contract. The two must agree.
- Rewriting first-person future wording and task-status claims either applies
  only to handoff replies or is documented as a contract for all CTO/Lead replies.
- Research work has one agreed response owner; the capability/alias table and
  the comment that describes it agree.

## Current state

- `apps/api/functions/lib/chat/taskAssignees.ts:28` (now `isCtoRole`) and
  `:126,140`: a CTO-only mention is filtered out of `hintForCommand` and
  `resolveTaskAssignees` returns `[]`; no event or System line explains it.
- `apps/api/functions/lib/chat/roleMentions.ts:68-80`: `canonicalizeMentions`
  keeps the first role mention and drops the rest.
  `apps/api/functions/lib/prompts/rolePrompts.data.ts:6,9` explicitly requires
  one `@Role` per reply, so this is an intentional contract, not an accident.
- `apps/api/functions/lib/chat/roleMentions.ts:57-65,100`: `asInstruction` runs
  for replies with and without a handoff; it strips "I will" and task claims.
- `apps/api/functions/lib/roles.ts:73-74,82-84`: `researcher`, `research`,
  `orchestrator`, `planner` and `architect` map to `cto`; the CTO is the only
  fixed role with the `research` capability (`:139`).
- `packages/worker/src/orchestrator/responseOwner.ts:31-45`: a plan node's role
  comes from the capability owner, so a research node resolves to the CTO.
- `packages/worker/src/orchestrator/roles.ts:2-22` now lists seven roles after
  the follow-up fix; retired names survive only as aliases.

## Decisions that must not change during execution

- The CTO stays read-only and never becomes the sole implementer owner.
- The human approval gate, token gate and terminal-status guard are untouched.
- One `@Role` per agent reply stays the default until the product decision in
  Step 1 is made; do not silently start emitting several mentions.
- Reply rewriting must not invent task-creation claims in either direction.

## Steps

### Step 1: Decide and implement `@CTO` feedback

Pick one: (a) keep the current routing and add a System line / reply hint that
says the CTO plans and the work was routed to the resolved owner, or (b) allow
a CTO-only mention to produce a CTO planning subtask. Record the choice here
before editing. Add a failing-first backend test for the chosen behaviour.

**Check**: `npx --workspace=@fhara/api vitest run runtime/chat/taskAssignees.test.ts` → green; a `@CTO` command has an observable answer.

### Step 2: Reconcile multi-role mentions with the planner rule

Either keep one mention and change the planner prompt/rule so one agent reply
maps to one subtask, or keep "one subtask per mentioned role" and update
`canonicalizeMentions` plus the seven role prompts to allow several mentions.
Update the role-mention tests to pin the chosen contract.

**Check**: `npx --workspace=@fhara/api vitest run runtime/chat/roleMentions.test.ts` → green; prompt-contract tests still pass.

### Step 3: Scope (or document) `asInstruction`

If rewriting is intended only for handoff replies, gate it on a detected role
and keep non-handoff CTO/Lead text byte-for-byte. If it is intended for all
replies, state that in the role prompts and tests instead of treating it as a
bug.

**Check**: role-mention tests cover a non-handoff CTO reply and a handoff reply.

### Step 4: Name the research response owner

Decide whether a research-only task may report through the CTO (read-only
planning/reporting) or must go to another live owner. If the latter, change the
capability ownership or alias mapping in one place and let `responseOwner.ts`
consume it; do not add a special case in the response-owner scorer.

**Check**: `npx --workspace=@fhara/worker vitest run tests/responseOwner.test.ts` → green; a research-only plan has an asserted owner.

## Test plan

- `@CTO` only: routing result plus visible feedback.
- Two mentioned roles: the stored reply and the created subtasks agree.
- Non-handoff CTO/Lead reply: text is unchanged or the rewrite is asserted as
  the documented contract.
- Research-only plan: response owner is the agreed role.
- Negative: CTO never becomes the sole code_change owner; multi-mention text
  never turns an incidental "with Backend" into a handoff.

## Completion criteria

- [ ] Each of the four decisions above has a recorded choice in this file.
- [ ] Focused API and worker tests pass, with failing-first evidence.
- [ ] Role prompts, role registry comments and tests state the same contract.
- [ ] `npm run --workspace=@fhara/api typecheck` and
      `npm run --workspace=@fhara/worker typecheck` pass.

## STOP conditions

- A non-negotiable rule in `AGENTS.md` must change.
- A check fails twice after a reasonable fix.
- The chosen behaviour needs a schema change or work outside this repository.
