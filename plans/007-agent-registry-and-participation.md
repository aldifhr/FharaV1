# Plan 007: Project agent registry and conversation participation

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

- Priority: P1
- Size: M
- Risk: LOW
- Dependencies: — (addendum §3 "Dynamic Conversation Participants" is a
  follow-up; this plan implements addendum §1–2 only)
- Planned at: commit `HEAD`, 2026-11-07

## Why this is needed

The architecture addendum (§1–2) requires a reliable Project Agent Registry as
the authoritative source of agent identity and availability, with project
membership, conversation participation, and task assignment as three
independent concepts. Today the `agents` table holds identity but there is no
registry read model, and conversation participation does not exist as a
persisted concept: the chat UI keeps the participant selection in React state
(`apps/web/components/ChatPanel.tsx:196`), passes it per request
(`apps/api/convex/messages.ts:35`), and `chatContext.getContext` recomputes a
selection on every reply (`apps/api/convex/chatContext.ts:61-82`). Participation
is therefore lost on reload, invisible to every other surface, and
undiscoverable — an agent that is not in the current chat has no participation
state anywhere.

## Target behaviour

| Capability | Today | After |
| --- | --- | --- |
| Registry fields per project member (id, name, role, description, capabilities, membership, enabled, availability, current assignment, participation) | spread over `agents` + JS filtering in consumers | `agents.listByProject` + `agents.getRegistryView` |
| Conversation participation | ephemeral per-request arg | persisted `conversationParticipants` rows, queryable |
| Membership | `projects.agentIds` | unchanged |
| Assignment | `tasks.assignedAgentIds`, `subtasks.assignedAgentId` | unchanged |
| Chat default routing (no explicit selection) | lead role, else first enabled member | identical (seeded into the conversation on first use) |

## Current state

- `apps/api/convex/schema.ts:77-107` — `agents` table: identity, `isEnabled`,
  `status`, LLM assignment. Global; no per-project registry view exists.
- `apps/api/convex/schema.ts:69` — `projects.agentIds` = membership; written by
  `projects.updateTeam` (`apps/api/convex/projects.ts:54-68`), enforced on task
  assignment (`apps/api/convex/tasks.ts:64-77`).
- `apps/api/convex/schema.ts:130,167-168` — assignment:
  `tasks.assignedAgentIds`, `subtasks.assignedAgentId/assignedAgentName`.
- `apps/api/convex/chatContext.ts:52-113` — `getContext` recomputes agent
  selection per reply; history = last 12 non-task project messages
  (`chatContext.ts:84-93`).
- `apps/api/convex/chat.ts:164-291` — `replyToChat` sequential multi-agent
  reply loop; empty team → "No enabled agents are assigned…" notice
  (`chat.ts:195-202`).
- `apps/api/convex/messages.ts:31-49` — `send` action: insert user message,
  schedule `replyToChat` with `preferredAgentIds`.
- `apps/api/convex/orchestration.ts:1147-1168` — `refreshAgentStatus` derives
  `agents.status` from live executions (runtime availability, tasks only).
- `apps/api/convex/orchestration.ts:89-94` — run-context agent resolution
  (assignment side; unchanged by this plan).
- `apps/web/components/ChatPanel.tsx:196,822-853` — `chatAgentIds` React state
  and the per-agent toggle chips; passed on every send
  (`ChatPanel.tsx:280,322`).
- `packages/worker/tests/chatAndTasks.test.ts:4-29` — the selection semantics
  this plan must preserve (preferred → lead → first enabled; empty team never
  falls back to global agents).

## Decisions that must not change during execution

- No duplicate registry. `agents` stays the identity source; this plan adds
  read models only.
- Participation ⊆ membership ∩ enabled. A participant must be on
  `projects.agentIds` and not disabled; an empty team yields no participants
  (preserves `chatAndTasks.test.ts:99-112`).
- Default selection semantics (preferred → lead → first enabled) are preserved
  as (a) the seeding behavior for a fresh conversation and (b) the fallback
  when `replyToChat` is called without a `conversationId`.
- Additive schema only: two new tables + `messages.conversationId` as
  `v.optional`. No field is dropped or renamed.
- Public queries never return `llmApiKey` / `llmApiKeyEnv`; they return the
  same projection as `agents.list` (`llmApiKeyConfigured` boolean).
- Chat history stays project-scoped: messages written before this change have
  no `conversationId`, so conversation-scoped history is explicitly out of
  scope (addendum §3 follow-up).
- No worker changes: the worker already maintains `agents.status` and
  assignment lives on tasks/subtasks.
- Leaving a conversation is a soft delete (`leftAt`); participant history is
  kept, queries filter `leftAt === undefined`.

## Steps

### Step 1: Schema — conversations, participants, message link

`apps/api/convex/schema.ts`: add `conversations` (projectId, optional taskId,
optional title, `status: "active" | "closed"`, createdAt, updatedAt,
lastMessageAt; indexes `by_project`, `by_project_and_status`,
`by_task`) and `conversationParticipants` (conversationId, projectId, agentId,
joinedAt, optional leftAt; indexes `by_conversation`, `by_agent`,
`by_project`). Add `conversationId: v.optional(v.id("conversations"))` to
`messages`.

**Check**: `npm run --workspace=@moagent/api codegen` succeeds, then
`npm run --workspace=@moagent/api typecheck` passes.

### Step 2: `conversations.ts` — participation model

New module with: `selectDefaultChatAgents` (moved verbatim from
`chatContext.getContext`), participant validation (member + enabled),
`syncParticipants` (add/rejoin/leave, idempotent), internal
`ensureForChat` (resolve-or-create the active conversation for a project, sync
`preferredAgentIds`, seed the default selection when empty), and public
`getActive`, `listByProject`, `getParticipants`, `setParticipants`,
`addParticipant`, `removeParticipant`, `closeConversation`. Explicit
add/remove throw on non-member/disabled/missing; the sync path skips invalid
ids silently (stale chip selection, matching today's reply-time filtering).

**Check**: `npm run --workspace=@moagent/api typecheck` passes.

### Step 3: Wire the chat engine to persisted participants

`chatContext.ts`: `getContext` takes optional `conversationId`; when present,
participants come from `conversationParticipants` (active rows, still member +
enabled), else the old selection runs as fallback. `insertUserMessage` /
`insertAgentMessage` accept optional `conversationId`. `chat.ts`:
`replyToChat` accepts and forwards `conversationId`; empty-participant notice
copy updated to cover both cases. `messages.ts`: `send` calls
`ensureForChat` first, stamps the user message, and schedules `replyToChat`
with the resolved `conversationId`.

**Check**: `npm run --workspace=@moagent/api typecheck` passes.

### Step 4: Registry read models

`agents.ts`: export `projectAgentDoc` projection (used by `list` too), add
`listByProject` (point-reads `projects.agentIds`) and `getRegistryView`
(per member: projection + `availability` = `agents.status` + open executions
count via `by_agent` + non-terminal assigned subtasks/tasks via `by_project` +
active conversation participations via `by_agent`).

**Check**: `npm run --workspace=@moagent/api typecheck` passes.

### Step 5: ChatPanel shows persisted participants

`ChatPanel.tsx`: query `api.conversations.getActive`; initialize
`chatAgentIds` from its participants so the selection survives reload and the
"Auto-assign" hint reflects reality. No other UI change.

**Check**: `npm run --workspace=@moagent/web typecheck` passes.

### Step 6: Tests

New `apps/api/convex/conversations.test.ts` (convex-test, in memory).

**Check**: `npx --workspace=@moagent/api vitest run convex/conversations.test.ts`
passes; `npm test` (worker suite) still passes — no worker file changes, but
the selection semantics it asserts must not regress.

## Test plan

- `ensureForChat` creates the active conversation and seeds the lead; a second
  call is idempotent (no duplicate participant rows).
- `preferredAgentIds` sync: selecting `[fe]` leaves the lead (`leftAt` set) and
  keeps `fe`; re-selecting the lead rejoins the existing row (no duplicate).
- `addParticipant` refuses an agent outside the team and a disabled agent;
  `removeParticipant` sets `leftAt` and the agent disappears from `getContext`.
- Empty team: `ensureForChat` seeds nobody; `getContext` returns no agents
  (gate preserved).
- `ensureForChat` with a `conversationId` from another project throws.
- `getContext` with `conversationId` returns the persisted participants; the
  no-`conversationId` fallback still implements preferred → lead → first.
- `getRegistryView` / `listByProject` never leak `llmApiKey`, and the view
  carries availability, open assignments, and active participations.
- Cross-check: an execution/task/subtask assignment shows up in the registry
  view's assignment fields.

## Completion criteria

- [ ] `npm run --workspace=@moagent/api codegen` clean.
- [ ] `npm run --workspace=@moagent/api typecheck` passes.
- [ ] `npx --workspace=@moagent/api vitest run convex/conversations.test.ts` passes.
- [ ] `npm test` (worker) passes.
- [ ] `npm run --workspace=@moagent/web typecheck` passes.
- [ ] `npm run knip` reports no new issues.
- [ ] This plan's row in `plans/README.md` set to DONE.

## STOP conditions

- A non-negotiable rule in `AGENTS.md` must change.
- A schema change needs a destructive operation.
- A check fails twice after a reasonable fix.
- The change needs work outside this repository.
