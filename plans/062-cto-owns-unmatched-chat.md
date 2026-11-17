# 062 — The CTO owns unmatched chat questions

## Decision (developer, 2026-11-17)

Unmentioned chat questions that no topic domain owns go to the **CTO**, not to
"anyone but the CTO". This replaces the recorded O3 rule ("no CTO default") for
the chat owner only — task/plan routing (O1) is untouched.

Motivation (live transcript 2026-11-16, project md77h3tb…): a general question
("sebutkan 3 file penting") routed to the previous responder, which was a QA
*deflection* ("saya bukan CTO"); the team looped Rey → Fox → Ultima and the CTO
never received the message.

## Changes

1. `apps/api/convex/lib/chat/dispatch.ts` — a CTO-deflection reply ("saya bukan
   CTO", "ditujukan kepada CTO", "lebih tepat dijawab oleh CTO", "for the CTO")
   is routing, not an answer: `previousResponder` skips it, so a refuser cannot
   keep the thread.
2. `apps/api/convex/lib/chat/owner.ts` — when `routeQuestion` matches nothing,
   `resolveChatOwner` routes to the CTO first (via `route`); the existing
   Support/General/fallback chain only applies on a team without a CTO.
3. Tests: `dispatch.test.ts` gains a deflection-skip case; `owner.test.ts`
   updates the "never the CTO" expectations to CTO-first.

## Definition of done

- New expectations pass (`pnpm --filter @fhara/api exec vitest run convex/lib/chat`).
- Backend typecheck clean; no worker change (task routing keeps O1).
- Live check: an unmatched question in the project chat reaches the CTO.
