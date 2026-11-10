# Plan 039: Personal chat for every agent

## Status

- Priority: P2
- Size: L (six lane-sized phases)
- Risk: MEDIUM (additive schema widening; project chat must not regress)
- Dependencies: 007 (conversations + participants), the durable chat reply lifecycle (`chatReplies.ts`)
- Planned at: commit `fc449a2`, 2026-11-10 (audit: personal-chat audit of that commit)
- Status: IMPLEMENTED 2026-11-10 (PC1–PC6). Live browser checks still pending, listed in the README row.

## Why this is needed

Every agent should be reachable in a one-to-one chat that is not tied to a
project: a CTO or QA conversation with its own history, no repository and
no task machinery, that the user can later attach to a project they own.
Today a conversation and every chat message require a `projectId`.

## Target behaviour

1. **Personal conversation** per agent (`conversations.kind = "personal"`,
   `agentId`, optional `ownerId`). One active per agent (+ owner);
   get-or-create is idempotent. "New chat" closes it and opens a fresh one.
2. **Own history**: read by `messages.by_conversation`; the CTO's personal
   history never reaches QA's prompt.
3. **One responder**: the conversation's agent only. No CTO pre-route, no
   handoff, no @mention queue, no second opinion (D8).
4. **No project = no project tools**: no repo snapshot, no worker repo tool
   calls, no `getProjectPath`, no tasks (`/task`, go reply, lifecycle intents
   and the Create task offer are refused with one fixed sentence). Only
   `load_skill` and pinned shared + agent memory. No web research (D4).
5. **Attach project** (`conversations.attachProject`): once, to a project
   the caller can access whose team includes the agent (D2). Ids and
   messages are unchanged, nothing is re-run, an audit row is written. From
   then on the agent gets project memory, the repo snapshot and read-only
   repo tools, and explicit Create task (D5). No detach/switch in v1 (D3).
6. **D1 invariant**: a message in a personal conversation never carries
   `projectId`, even after attach (project timelines, pins, clearChat and
   the delete cascade never see it). Project scope comes from the
   conversation row.
7. **Project delete** detaches an attached personal chat instead of
   deleting it.

## Data model (additive)

- `conversations.projectId` optional; new `kind` (`personal|project|team`,
  absent = project), `agentId`, `ownerId`, `projectAttachedAt`; indexes
  `by_agent_kind_status`, `by_kind_and_last_message`.
- `messages.projectId` optional; indexes `by_conversation`,
  `by_conversation_and_client_id` (send dedupe without a project).
- `conversationParticipants.projectId`, `contextSummaries.projectId` optional.
- `contextSnapshots` unchanged: a chat call with no project records no
  snapshot (observability only).
- Migration: `npx convex run migrations:backfillConversationKinds` (stamps
  `kind: "project"` on legacy rows, batched, idempotent), then
  `npx convex run migrations:verifyConversationKinds` (all counts 0, `ok:
  true`). Legacy messages without a conversation are left as is (D10).
- Rollback: code rollback fails closed on personal rows. Narrowing the
  schema needs `migrations:deletePersonalConversations` first (never
  scheduled automatically).

## Must-fix guards (existing gaps)

- Every per-project conversation lookup filters out personal rows
  (`findActiveConversation`, `getActive`, `listByProject`, `clearChat`;
  `messages.send` refuses a personal conversation id).
- `tasks.createFromCommand` validates that `conversationId` belongs to the
  project.
- Project delete detaches personal chats.
- A missing project never grants fs/shell/repo tools and never falls back
  to the worker root; the project path `.` is refused.

## Phases

| Phase | Content |
|---|---|
| PC0+PC1 | This plan; schema + invariants + guards + migration |
| PC2 | Personal API: `getOrCreatePersonal`, `startNewPersonal`, `listPersonal`, `get`, `messages.listByConversation`, `messages.sendInConversation` |
| PC3 | Personal reply path in `chat.replyToChat` |
| PC4 | `attachProject` + attached context |
| PC5 | UI: `/chats/personal`, `/chats/personal/[agentId]`, `PersonalChatPanel` (reuses `MessageList` / `ChatComposer`), Attach dialog, IconRail + agent page links |
| PC6 | QA scenario tests + review greps |

## Decisions (defaults accepted 2026-11-10)

D1 no projectId on personal messages · D2 attach needs team membership ·
D3 no detach/switch · D4 no web research · D5 explicit Create task after
attach · D6 team chat without a project deferred · D7 "Remember" saves agent
memory · D8 second opinion off · D9 no feature flag · D10 legacy messages
untouched · D11 next free plan number.

## Tests

`apps/api/convex/personalChatSchema.test.ts`, `personalChat.test.ts`,
`personalReply.test.ts`, `personalAttach.test.ts`, `personalQa.test.ts` (PC6 lifecycle); web unit
`apps/web/tests/unit/personalChat.test.mjs`. QA scenario map in the
personal-chat audit §12.1; scenarios needing a live browser are listed in
the status line of the plan README.
