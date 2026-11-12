# Plan 047: Thread deep links and per-project sidebar separation

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

- Priority: P2
- Size: S
- Risk: LOW
- Dependencies: —
- Planned at: commit `c88a851`, `2026-11-12`

## Why this is needed

Every thread in a project shares the `/project/:projectId` URL: the sidebar row
for a thread links there and hands the thread id to the workspace shell in app
state (`requestThread`, `lib/pendingThread.ts`). The link is not shareable and
a reload lands on the project with no thread open. The sidebar also mixes
three different things — the project's team chat (`kind: "conversation"`), the
project's task threads (`kind: "task"`) and direct threads
(`kind: "direct"`) — into one list per project with the same
`Thread: ` prefix.

## Target behaviour

| Before | After |
| --- | --- |
| Sidebar thread row href is `/project/:projectId`; the thread opens via an in-memory hand-off | Row href is `/project/:projectId/:threadId`; reload opens the same thread |
| The project chat (conversation) renders "Thread: Chat" mixed with task threads | Each project group shows three labelled subgroups: **Project chat**, **Tasks**, **Threads** (direct threads); only non-empty subgroups render |
| Direct threads are labelled `Thread: <title>` | Direct threads stay labelled `Thread: <title>` (unchanged); the team chat renders with no prefix |
| `/project/:projectId/:threadId` opens the thread in a right-hand panel over the same project chat, so both URLs look identical | The deep-linked thread replaces the project chat as the main view (desktop); the project chat stays reachable from the sidebar and `Back to chat`. Phones keep the chat with the thread as a full-screen sheet. |

## Current state

- `apps/web/lib/threadTree.ts:209` — `projectHref`; `threadHref` at line 219
  returns `/project/:projectId` for every row.
- `apps/web/lib/threadTree.ts:214` — comment claims threads are
  project-scoped and ride in app state, not the address.
- `apps/web/app/project/[projectId]/page.tsx:5` — project page comment: a
  thread opens in app state, not the address; every thread in a project
  shares this URL.
- `apps/web/app/WorkspaceClient.tsx:27` — `?task=` survives from older links;
  thread links hand the thread over in app state via `requestThread`.
- `apps/web/components/sidebar/ThreadList.tsx:90` — `openThread` hands a task
  id to the shell or calls `requestThread`; `ThreadRow` renders
  `href={threadHref(row)}`.
- `apps/web/app/page.tsx:170`, `apps/web/app/inbox/page.tsx`,
  `apps/web/components/CommandMenu.tsx` use `projectHref` / `threadHref` for
  project and thread links; the inbox/needs-you rows keep project links.
- `apps/web/tests/unit/threadTree.test.mjs:172` — `threadHref` asserted to
  return `/project/p1`.

## Decisions that must not change during execution

- `/project/:projectId` keeps rendering the project workspace with the
  project chat; no thread is auto-opened there.
- A `:threadId` that matches no task in the project's task list falls back to
  the project chat (conversations are not tasks); the route must not 500.
- The deep-linked thread replaces the project chat as the main view on desktop;
  closing it navigates back to `/project/:projectId`. The two URLs must not look
  identical.
- The `requestThread` one-shot hand-off stays for in-session selection from
  other pages.
- The sidebar stays grouped by project; per kind inside a project only.
- No schema change. No backend change. No new Convex functions.

## Steps

### Step 1: threadHref carries the id

`threadHref` takes `projectId`, `taskId`, `conversationId`; returns
`/project/:projectId/:threadId`, with the project hull when the row carries no
id. Update the unit test.

**Check**: `npx --workspace=@fhara/web vitest run tests/unit/threadTree.test.mjs`
→ pass. (The web package uses `node --test`; the file is `.test.mjs` — run it
with the web test command and confirm `threadHref` assertions pass.)

### Step 2: deep-link route

Add `apps/web/app/project/[projectId]/[threadId]/page.tsx` rendering
`WorkspaceShell` with the same children as the project page plus a
`threadId` prop. `WorkspaceShell` selects that task once the project's task
list has loaded; otherwise leaves the project chat open. It derives
`deepLinked` from the selected task id: while it holds, the thread renders in
the main area instead of the project chat, the docked panel is skipped, and
closing the thread navigates back to `/project/:projectId`. Phones keep the
full-screen sheet.

**Check**: `npm run --workspace=@fhara/web typecheck` → clean.

### Step 3: sidebar subgroups

In `ThreadList`, inside each project group render the labelled subgroups
(`Project chat`, `Tasks`, `Threads`) with the branch connector inside each
subgroup and `Thread: ` only on task/direct rows. Subgroups with no rows do
not render.

**Check**: `npm run --workspace=@fhara/web typecheck` → clean.

## Test plan

- `threadHref`: task row → `/project/p1/t9`; conversation row →
  `/project/p1/c2`; a row with no id → `/project/p1`.
- The route must not throw for an unknown `threadId` (falls back to the
  project chat).

## Completion criteria

- [x] `threadHref` unit test updated and green (`npm run --workspace=@fhara/web test` — 4 pre-existing environment failures, none related).
- [x] `npm run --workspace=@fhara/web typecheck` clean.
- [x] `npm run check:guards` green; `npm run knip` reports no new findings.
- [x] Browser check: `/project/:projectId/:threadId` (task `n57c6zbbkhc9q16ww5t3hcc61d8j3mqv`) renders the thread as the main view — `Back to chat` header, thread transcript, no docked panel (`backBtn: 1`). `/project/:projectId` renders the project chat (`backBtn: 0`, Chat/Tasks/Files tabs). Clicking `Back to chat` navigates back to `/project/:projectId`; the mobile sheet behaves the same.

## STOP conditions

- A check fails twice after a reasonable fix.
- The change needs a non-negotiable rule changed or a schema change.
