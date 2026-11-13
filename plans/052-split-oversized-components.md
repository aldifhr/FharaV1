# Plan 052: Split the oversized chat/settings components

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

- Priority: P3
- Size: L
- Risk: MEDIUM (chat is the main surface; a bad split regresses streaming)
- Dependencies: 050 (overlay primitive) for the settings/modals step, optional
- Planned at: `improve` web-UI audit, 2026-11-13

## Why this is needed

Six components carry most of the UI's logic in one file each (measured line
counts):

| File | Lines | `any` | `useQuery` |
| --- | --- | --- | --- |
| `components/settings/tabs.tsx` | 1201 | — | 7 |
| `components/LlmSettings.tsx` | 935 | — | 8 |
| `components/integrations/IntegrationsPanel.tsx` | 744 | — | — |
| `components/ChatPanel.tsx` | 736 | 67 | 16 |
| `components/chat/ChatComposer.tsx` | 711 | — | — |
| `components/TaskThreadPanel.tsx` | 696 | 53 | 7 |

Every one of them re-renders as a unit. `ChatPanel` holds 16 `useQuery`
subscriptions (`:58-91`, `:447`, `:457`) plus the message list, composer, task
panel and approval tray; a scroll-position state change re-runs all of it. That
is a render cost, not a correctness bug, but it is why the chat feels heavy on
long threads and why a single `any` there is expensive to find.

Code splitting is separate: there is exactly one `next/dynamic`
(`components/chat/cards/DiffCard.tsx:3`). Nothing else is deferred, so every
page that mounts the shell pays for the chat bundle, the settings bundle and the
diff viewer.

Correction to the audit that produced this plan: `recharts` was listed as bundle
weight, but nothing imported it — it was a dead dependency and is now removed
from `apps/web/package.json` (see the audit report). The real weight is
`react-diff-viewer-continued`, `streamdown` (+ mermaid/math/code plugins) and
`framer-motion`, all of which are imported statically.

## Target behaviour

- No behavioural change. Same DOM, same classes, same copy.
- Each split file stays under ~400 lines; `npm run check:guards` module budget
  is the enforcement (check its current limit before starting).
- Panes that are conditionally visible (diff viewer, settings tabs, task panel)
  load on demand.

## Steps

### Step 1: ChatPanel — extract panes, keep one owner of state

Split by render region, not by hook:

- `components/chat/ChatMessagePane.tsx` — the message list + composer region;
- `components/chat/ChatTaskPane.tsx` — the selected-task panel and its queries;
- `components/chat/ChatApprovalTray.tsx` — approvals/decisions (`:84-85`);
- keep `ChatPanel.tsx` as the layout + the state that genuinely crosses panes.

Move the queries that only one pane reads into that pane (`api.fileChanges.listByProject`,
`api.workspace.listSubtasksByProject`, `api.executionView.activeByAgent` are
candidates). Convex dedupes identical subscriptions, so moving a query does not
add a request.

**Check**: `npm run --workspace=@fhara/web typecheck`; open a project chat and
send a message in `npm run dev`; streaming still renders token by token.

### Step 2: TaskThreadPanel — same treatment

Extract the thread header, the run feed and the reply composer. Do not touch
`useMessageHistory`; it is already the right shape.

**Check**: typecheck + a task thread in the browser (open a running task, watch
the live tail).

### Step 3: Settings — split by tab

`settings/tabs.tsx` (1201) becomes one file per tab under
`components/settings/tabs/`. `LlmSettings.tsx` (935) splits into the provider
list, the model list and the selection-mode control; the model list is the piece
that grows.

**Check**: typecheck; open Settings and click every tab.

### Step 4: Defer the heavy imports

- `DiffCard` already defers the diff viewer; confirm the fallback has a
  fixed-height skeleton so the sheet does not jump.
- `next/dynamic` (with `ssr: false` where it reads the DOM) for:
  the diff viewer on the task/run panes, the Integrations panel body, the
  settings tab bodies, and any streamdown plugin set that only the chat reply
  path needs.

**Check**: `npm run build` — compare the route table's First Load JS for `/`,
`/project/[projectId]` and `/runs/[taskId]` before and after; record both
numbers in `plans/README.md`.

## Test plan

- No new unit test: the split is mechanical. The proof is (a) typecheck,
  (b) `next build` route sizes, (c) a browser pass over chat → task → approve →
  run page.
- If a pane gains its own hook file, add a `node:test` for the pure helper only.

## Completion criteria

- [ ] No file in the six listed above is over ~400 lines.
- [ ] `check:guards` (module budget + cycles) green.
- [ ] First Load JS for `/` and `/project/[projectId]` recorded before/after.
- [ ] Browser pass: send a chat message, open a task thread, open Settings tabs.

## STOP conditions

- A split needs a new shared state container (context/store) to work — that is a
  design change, stop and report.
- The module budget in `check:guards` is hit by an unavoidable file and the fix
  is to raise the limit — stop; raising it hides the problem.
- Streaming regresses and the cause is not obvious in two attempts.
