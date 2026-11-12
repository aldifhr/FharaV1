# Plan 048: Add as Thread — seed a direct thread from selected chat messages

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

- Priority: P2
- Size: M
- Risk: LOW
- Dependencies: plan 047 (thread deep links) — shallow; `threadHref` already
  carries the id.
- Planned at: commit `0368fa6`, `2026-11-12`

## Why this is needed

A user can start a direct thread from a single message in the main project chat
("New direct thread" + a first message). There is no way to build a thread out
of an existing exchange: previous messages can only become a task via
"Create task" (which returns a draft, not a direct thread). "Add as Thread"
lets the user pick one or more messages in the main project chat and start a
new direct thread from them, without moving the originals.

## Target behaviour

| Before | After |
| --- | --- |
| No way to start a direct thread from more than one message. | Select one or more user/agent messages in the main chat, then "Add as Thread" from the action bar. A new direct thread (`mode: "direct"`) starts with those messages as `user.message` events, ordered chronologically; the originals stay in the chat. |

- Selection works on the main project chat; task-linked messages and
  empty/system lines never select. Personal chat is out of scope: its rows
  carry no `projectId`, so the backend would refuse them.
- "Add as Thread" creates exactly one thread per `(project, clientId)` —
  retrying a create with the same clientId returns the existing thread without
  appending the events twice.
- The thread opens at `/project/:projectId/:threadId` (deep link) and stays in
  the sidebar per plan 047.
- Backend: new public mutation `api.directThreads.createFromMessages`
  (`apps/api/convex/directThreads.ts`).
- Web: checkboxes in `MessageList`, selection state in `ChatPanel`, action bar
  above `ChatComposer`, new `AddAsThreadModal`, and the fixed
  `NewDirectThread` navigation.

## Current state

- Backend: `apps/api/convex/directThreads.ts:143` — `create` is the model:
  `assertProjectAccess`, role inference via `apps/api/convex/lib/roles.ts:435`
  (`inferRoleForText`), `agentForRole` with CTO fallback at `:74`, task insert
  with `status: "queued"`, `mode: "direct"`, `direct: { role, agentId, engine:
  "opencode-acp", status: "idle", lastSeq: 0, deliveredSeq: 0 }`, `syncTaskThread({ seen: true
  })`, `thread.created` event, then `writeUserMessage` per message at `:100`.
  `cleanText` :124 and `cleanClientId` :131 exist for every message text.
- Web: `apps/web/components/chat/MessageList.tsx:239` — `renderItem` is the row
  renderer; `renderUserBody` :343, `renderMessageBody` :376; the message row
  wrapper is the `motion.div` at :318-328. `apps/web/components/ChatPanel.tsx:365`
  — `createTaskFromMessage` is the existing pattern for a server action driven
  from a list of messages. Chat panel action bar fragment: :752; `ChatComposer`
  :763.
- Navigation: `apps/web/lib/threadTree.ts:221` — `threadHref({ projectId,
  taskId })` → `/project/:projectId/:threadId`. `NewDirectThread.tsx:37-38`
  currently ignores the created task id (plan 047 leftover) and pushes the
  project URL.
- Modal primitive: `apps/web/components/Modal.tsx:9` (`title`, `onClose`,
  `maxWidth` default `max-w-md`). UI input class: `INSPECTOR_INPUT`
  (`apps/web/components/ui/inspector.tsx:300`).
- Backend tests: `apps/api/convex/directThreads.test.ts:11` (`setup`),
  `:41` (`eventsOf`), existing `describe("directThreads.create / send")` :50.
- Uncommitted working tree (182 modified, 11 untracked): untouched — this work
  only edits the files above.

## Decisions that must not change

- "Add as Thread" always creates a **direct** thread (`mode: "direct"`); it is
  not a task and never goes through the planner.
- Selected messages become `user.message` events with a deterministic
  per-message clientId `add-as-thread:<projectId>:<messageId>`; originals stay
  untouched. The first selected message's text is `command` and also seeds the
  thread title (the modal pre-fills it).
- Role is inferred from the first message's text only (`inferRoleForText`);
  agent = `agentForRole` (team first, CTO fallback, else any enabled agent).
- Validation: all message ids from one project, `authorType` user/agent,
  no `taskId`, no system lines, non-empty content, ≤ 50 messages, deduplicated
  ids.
- Chronological order by `_creationTime`, ties by `_id`.
- No new Convex tables, no schema change, no worker change.
- `requestThread` stays (CommandMenu/inbox still use it); `NewDirectThread`
  pushes the deep link.

## Steps

### Step 1: Backend mutation `createFromMessages`

In `apps/api/convex/directThreads.ts`:
- Add `const MAX_ADD_AS_THREAD_MESSAGES = 50;` next to the other module
  constants.
- Add `createFromMessages` (object-form mutation, `.args`/`.handler`) right
  after `create` (after the closing `});` at `directThreads.ts:204`):
  1. `assertProjectAccess` → `project`;
  2. `messageIds` non-empty, ≤ 50;
  3. idempotency: `idempotencyKey = direct:<projectId>:<clientId>` (caller
     `clientId` required, defaulted `add-as-thread:<ms>`; dup → `{ taskId }`);
  4. load each message (`ctx.db.get`): reject missing, wrong-project (the row
     needs `projectId`, personal rows carry none), `taskId` present,
     `voice === "system"`, `authorType` not user/agent, empty content. Dedupe
     ids.
  5. sort chronologically by `_creationTime`, tie-break `_id`;
  6. `firstText = cleanText(rows[0].content)`; `wantedRole =
     inferRoleForText(firstText)`; `agent = agentForRole(ctx, project,
     wantedRole, true)`; `role = normalizeRoleKey(agent.role)`;
  7. `title = args.title?.trim() || (firstText > 80 chars ? slice(0,80)+'...' :
     firstText)`; `command = firstText`;
  8. insert `tasks` (`projectId`, `title`, `command`, `status: "queued"`,
     `mode: "direct"`, `direct` as in `create`, `assignedAgentIds: [agent._id]`,
     `permissionMode: projectDefaultPermissionMode(project)`, `idempotencyKey`,
     `updatedAt`);
  9. `syncTaskThread(ctx, taskId, { seen: true })`; then a `thread.created`
     `taskEvents` row (`{ mode: "direct", role, agentId: agent._id }`);
  10. one `writeUserMessage(ctx, task, text, `add-as-thread:<projectId>:<messageId>`)
     per message — no event for `thread.created`.

**Check**: `npm run --workspace=@fhara/api typecheck` → clean; then `npx
--workspace=@fhara/api vitest run convex/directThreads.test.ts` → pass (once
Step 2's tests are added).

### Step 2: Backend tests

Append a new `describe("directThreads.createFromMessages", () => { ... })` to
`apps/api/convex/directThreads.test.ts` using the existing `setup` (:11) and
`eventsOf` (:41):
- valid create from an out-of-order selection (order after the event sequence);
  title/command from the first message; `thread.created` + one `user.message`
  per message with the deterministic clientId;
- project mismatch refused;
- task-linked message refused;
- duplicate ids write once;
- same `clientId` twice returns the same task, no duplicate events;
- empty selection refused;
- system line refused.

**Check**: same test command as Step 1; full `npm run --workspace=@fhara/api
test` at the end.

### Step 3: Web — selection state + action bar in `ChatPanel`

`apps/web/components/ChatPanel.tsx`:
- add `selectedIds: Set<string>` state (init `new Set()`), `addAsThreadOpen`,
  `clearSelection`;
- reset on project change: `useEffect(() => setSelectedIds(() => new
  Set()), [projectId])`;
- pass `selectedIds` + `onSelectMessage` to `MessageList` (:693) and wire the
  `onSelectMessage` callback;
- after a successful create, `setSelectedIds(() => new Set())`;
- render the bar (inside the `:752` chat fragment, directly above
  `ChatComposer` :763) only while `selectedIds.size > 0`, with the count,
  "Clear" (outline), and "Add as Thread" (primary).

### Step 4: Web — checkbox in `MessageList`

`apps/web/components/chat/MessageList.tsx`:
- extend `Props` (:60) with optional `selectedIds: ReadonlySet<string>` and
  `onSelectMessage?: (messageId: string) => void`;
- in `renderItem` (:239): selectable rows = `!m.optimistic && !systemText &&
  !m.taskId && Boolean(m.content?.trim())`; draw a native checkbox (class
  `h-4 w-4 shrink-0 rounded border-line-strong accent-ink`, checked via
  `selectedIds?.has(String(m._id))`, `onChange → onSelectMessage(String(m._id))`)
  at the start of the row wrapper (:318-328), in both the animated and the
  plain branches.

### Step 5: Web — `AddAsThreadModal`

New `apps/web/components/direct/AddAsThreadModal.tsx`: Modal (`max-w-md`) titled
"Add as thread"; a title field pre-filled from the first selected message
(text, trimmed, 80 chars); a notice that N messages seed the new thread and the
originals stay; "Cancel" (outline) closes; "Create thread" (primary, busy state)
calls `api.directThreads.createFromMessages({ projectId, messageIds,
title?, clientId: add-as-thread-<random> })` and, on success, calls
`onClose` + `router.push(threadHref({ projectId, taskId }))` (do not reuse
`projectHref` here — the URL must carry the thread id).
`errorText` follows the existing pattern (e.g. `apps/web/components/direct/NewDirectThread.tsx:14`).

### Step 6: Web — deep-link navigation in `NewDirectThread`

`apps/web/components/direct/NewDirectThread.tsx:37-38`: after creating the
task, `requestThread(projectId, String(taskId))` stays (it is still used by
`CommandMenu`/`inbox`), and the navigation becomes
`router.push(threadHref({ projectId, taskId }))`. Do not change
`lib/pendingThread.ts` or any other consumer.

## Test plan

Backend (`npm run --workspace=@fhara/api test`):
- the invariants are the checklist in Step 2; negative cases (wrong project,
  task-linked, system, empty, too many, duplicate/retry) are required.
Web:
- `npm run --workspace=@fhara/web typecheck` → clean;
- `npm run --workspace=@fhara/web test` (unit, lib/ guards) → pass;
- `npm run check:guards` → green; `npm run knip` → no new findings;
- `npm run --workspace=@fhara/web build` → green (routing/bundling affected).

## Completion criteria

- [x] `npm run --workspace=@fhara/api codegen` run, then api typecheck + the new
  `directThreads.test.ts` file green;
- [x] web typecheck clean, `check:guards` green, knip unchanged (pre-existing
  findings only), `next build` green (with `NEXT_PUBLIC_CONVEX_URL`);
- [ ] the API viewer confirms: select 3 messages (user + agent, out of order),
  "Add as Thread" → deep link → direct thread opens with all 3 messages as
  `user.message`, originals untouched.

## STOP conditions

- A non-negotiable rule in root `AGENTS.md` would have to change.
- A schema change or a destructive migration.
- A check fails twice after a reasonable fix.
