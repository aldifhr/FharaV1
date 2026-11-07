# Plan 002: In-app notifications

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When done,
> set this plan's state in `plans/README.md`.

## Status

- Priority: P2
- Size: S
- Risk: LOW
- Dependencies: none
- Planned at: `main`, 2026-11-07

## Why this is needed

The user learns that a task failed or waited for approval only by opening the
Inbox. There is no unread state and no per-event record, so the Inbox badge is a
live count of problems, not a notification the user can acknowledge.

## Target behaviour

| Action | Result |
| --- | --- |
| A task fails, completes, or needs approval | One `notifications` row per event, per project |
| Open the Inbox | Rows render newest first with an unread marker |
| Mark one read / mark all read | Unread count drops; the badge follows |
| Click a notification | Navigates to the task or project it names |

## Current state

- `apps/api/convex/inbox.ts` has one query, `list` (line 4). It derives pending
  approvals, `needs_approval` tasks, failed tasks, and agent states on every call.
  There is no stored event and no read state.
- `apps/web/components/IconRail.tsx` computes `inboxCount` from `api.inbox.list`
  (line ~33) and renders the Inbox badge.
- `apps/web/app/inbox/page.tsx` renders that list.
- `apps/api/convex/taskEvents.ts` already records lifecycle events. Notifications
  should be derived from the same transitions, not a second event system.

## Decisions that must not change during execution

- Notifications are **derived and stored**: create a row when the transition
  happens (inside the existing mutation), not by polling in the browser.
- One row per (project, kind, subject). Do not create a notification on every
  heartbeat.
- Read state is per row (`readAt`), never a single global "last seen".
- A notification carries ids and a short message, never a file body, a prompt, or
  a credential.
- Retention: cap the stored rows per project (default 200). A cron may prune, but
  pruning must never remove an unread row younger than 7 days.

## Steps

### Step 1: Add the table

`schema.ts`:

```
notifications: defineTable({
  projectId: v.id("projects"),
  kind: v.union(
    v.literal("task_failed"),
    v.literal("task_completed"),
    v.literal("approval_requested"),
    v.literal("agent_needs_you"),
  ),
  subjectId: v.string(),        // taskId, approvalId, or agentId as a string
  message: v.string(),
  readAt: v.optional(v.number()),
  createdAt: v.number(),
})
  .index("by_project", ["projectId"])
  .index("by_project_and_created", ["projectId", "createdAt"])
  .index("by_unread", ["readAt"]),
```

**Check**: codegen succeeds; the three indexes exist.

### Step 2: Emit on transition

Add an internal helper `pushNotification(ctx, input)` in a new
`apps/api/convex/notifications.ts`. Call it from the existing transitions in
`orchestration.ts`:

- `completeTask` → `task_failed` for `failed`, `task_completed` for `done`.
- `requestApproval` → `approval_requested`.
- `appendAgentMessage` / the agent-state transition → `agent_needs_you`.

Do not create a row when the same (kind, subjectId) already has an unread row —
update its `message` and `createdAt` instead, so a retry does not spam the list.

**Check**: `npm run --workspace=@moagent/api test` → terminal-guard tests still
pass, plus a new assertion that `completeTask` on a terminal task creates no row.

### Step 3: Add the queries and mutations

- `notifications.list` (query, `{ projectId, limit? }`) — newest first.
- `notifications.unreadCount` (query, `{ projectId? }`) — for the badge. When no
  project is given, count across all projects using `by_unread`.
- `notifications.markRead` (mutation, `{ notificationId }`).
- `notifications.markAllRead` (mutation, `{ projectId? }`).

**Check**: typecheck exits 0.

### Step 4: Badge and page

- `IconRail.tsx`: replace the derived `inboxCount` with
  `api.notifications.unreadCount`. Keep `api.inbox.list` for the actionable
  approvals list.
- `app/inbox/page.tsx`: render notifications above the existing approvals/tasks
  blocks, with "Mark all read" and per-row read state.
- All copy in English.

**Check**: `npm run --workspace=@moagent/web typecheck` → exit 0.

### Step 5: Retention

Add a cron in `apps/api/convex/convex.config.ts` (or the existing cron file) that
prunes read notifications older than 30 days and keeps the per-project cap. Do not
prune unread rows younger than 7 days.

**Check**: a convex-test case inserts 201 read rows and asserts at most 200 remain.

## Test plan

- Duplicate suppression: two completions of the same task produce one unread row.
- Terminal guard interaction: a refused late completion produces no notification.
- `markAllRead` scopes to the project when given.
- Unread count matches the number of rows with `readAt === undefined`.

## Completion criteria

- [ ] Rows are created inside the transitions, not by polling.
- [ ] Badge reads stored unread count.
- [ ] Mark one / mark all work and persist across reload.
- [ ] Retention test passes.
- [ ] `npm run --workspace=@moagent/api test` and `npm test` pass.

## STOP conditions

- The change needs push notifications or email (out of scope).
- A transition cannot create the row without a second backend round-trip from the
  worker (then revisit the design before coding).
- Retention requires deleting unread user data.
