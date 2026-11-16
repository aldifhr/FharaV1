# Plan 059: CTO-first work chat, constrained handoff, stack-neutral chat replies

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

DONE (unit/convex tests + typecheck green; prompt-level live check passed with
`opencode/hy4-flash-free`. Full-app live chat could not be checked: the only
HTTP provider on this dev deployment (`9router` / `nous`) returned 503/404, and
chat skips OpenCode entries by design — `lib/chat/llm.ts:orderedChatPairs`.)

## Why

Two user-visible problems with project chat (`create new file hello.html`):

1. A work request with no @mention was routed by System straight to Frontend
   (`lib/chat/owner.ts:59` → `codeRoleForRequest`, `lib/chat/intent.ts:544`).
   The user wants the CTO to answer first and name the roles that are needed.
2. The Frontend reply was framed entirely around this repo's Vite/React stack:
   task-time seed persona "React/Next.js … TypeScript strict" is injected into
   every chat reply (`lib/prompts/chat.ts:118`, seed at `lib/prompts/agents.ts:44`),
   `buildRequestSubjectGuard` says "build on its stack" unconditionally
   (`lib/prompts/chat.ts:91`), the offer brief pushes stack inference
   (`lib/chat/offerBrief.ts:116`), and `inferStack(repoSnapshot)` turns a plain
   `hello.html` into "using this React/Vite project's setup"
   (`offerBrief.ts:82`). A read was forced because "file" matches
   `mentionsCode` (`dispatch.ts:176`, `chat.ts:1289`), producing the two repo
   tool calls.

## Decisions

- **ASK stays direct.** Status, greeting and domain-owned questions keep the
  deterministic System route; no CTO wrap-up (keeps the O3 latency/wrap-up fix
  in `chatHandoffTools.test.ts:277`).
- **WORK goes CTO-first.** A work-shaped message with no explicit @mention
  (task intent, write request, or run command) is routed to the CTO; System
  posts "Sent to CTO". A team without an enabled CTO keeps the old route.
- **Handoff is constrained.** An `@Name` in the CTO reply pulls that teammate
  into the same turn (max 3, `lib/chat/team.ts:63`). A verification handoff is
  dropped when repo tools are off. A list of the whole team is not a handoff.
- **Chat still does not execute.** The Create task button / explicit command is
  the only way in; the worker planner still owns Plan v1 and the approval gate.
- **The user's artifact wins over the repo's stack.** Stack/token/component
  guidance applies only when the request is about existing project code. A
  named standalone `.html` file stays plain HTML.

## Steps

1. `lib/prompts/chat.ts`: stack-neutral chat scope; condition
   `buildRequestSubjectGuard`; re-add `buildHandoffNotice`; change
   `buildHandoffGuidance` so @mention = real handoff, role name without @ = just
   naming. Check: prompt unit tests.
2. `lib/chat/offerBrief.ts`: `offerPlanLine` keeps `.html` plain unless the
   request itself names a framework; add a chat-guidance line that a standalone
   file is not a request to adopt the project's stack. Check: offer unit tests.
3. `chat.ts`: hoist the work-shaped test; CTO-first route with a System line;
   no forced repo read for a write request; CTO handoff queue, notice and
   collaboration-graph `markChatHandoff`. Check: narrow typecheck.
4. Update `chatHandoffTools.test.ts` and `owner.test.ts` for the new route and
   re-enabled handoff; keep the ASK-only and no-CTO fallback cases.
5. Run `npm run --workspace=@fhara/api typecheck` and the touched
   `convex/*.test.ts` files; then say what was not checked.

## Out of scope

No web UI change, no schema change, no change to the planner/task contract,
no change to approval or credential rules.
