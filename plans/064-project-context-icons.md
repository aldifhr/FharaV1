# 064 — Per-task and per-project context totals with header/dock icons

## Goal

Every task shows how much context it consumed and the project shows the
aggregate: an icon button in the project chat header with the total prompt
tokens, and a small per-task badge on task rows (dock + board). The number is
the sum of `promptTokens` over `contextSnapshots` — the context size actually
sent to the LLM — which the worker already records for every task LLM call
(`CONTEXT_SNAPSHOTS=0` disables; chat rows carry the project, task rows carry
the task).

## Changes

1. Backend (`apps/api/convex/contextSnapshots.ts`): one new query
   `contextTotals({ projectId })` → `{ calls, promptTokens, lastCallAt,
   tasks: [{ taskId, calls, promptTokens, lastCallAt }],
   chat: { calls, promptTokens } }`, summed over the most recent
   `PROJECT_TOTALS_CAP` (2000) rows on `by_project_created` descending.
   Access via the existing `assertProjectAccess`; chat bucket = rows with no
   `taskId`.
2. Web header (`apps/web/components/chat/ChatHeader.tsx`): a lucide `Layers`
   icon button cloned from the pinned-messages button (`iconButtonClass`,
   `usePopover`, `popoverClass` from `apps/web/components/shell/usePopover.ts`)
   with a `formatTokens` total; the popover lists per-task breakdown
   (taskRef · ~tokens · calls) plus the chat bucket; a row opens its task.
3. Web dock (`apps/web/components/chat/TaskDock.tsx`): `projectId` prop
   (passed from `ChatPanel.tsx:783`); each row renders a muted
   `Layers ~{formatTokens}` badge looked up from the same query — no per-task
   subscriptions.
4. Web board (`apps/web/components/TaskBoard.tsx` → `board/BoardTaskCard.tsx`):
   one query at board level; the card meta row shows the same badge.

## Definition of done

- `apps/api` typecheck + `contextSnapshots.test.ts` cases pass (sums, cap,
  access control, chat bucket).
- `apps/web` typecheck; header popover and both badges render on the dev
  server for the live project; zero per-row queries (one query per surface).
- No schema change (read-only feature); no generated blocks touched.
