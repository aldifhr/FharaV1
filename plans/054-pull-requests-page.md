# Plan 054: Pull Requests page in the sidebar

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

- Priority: P2
- Size: M
- Risk: LOW
- Dependencies: none (reads `taskPushes`, plan 019/043)
- Planned at: commit `a91d768`, `2026-11-13`

## Why this is needed

Fhara opens GitHub PRs from the push flow and stores PR facts on
`taskPushes` rows (`repoFullName`, `prNumber`, `prUrl`, `prState`, `ciState`,
`reviewState`, `mergeable`, `autoMerge`; `apps/api/convex/schema.ts:1400`).
Today the user can only see a PR as it belongs to one task (Changes pane,
`api.changes.forTask`) or as a line in the Inbox (`inbox.ts` notifications).
There is no place that lists every PR across projects.

## Target behaviour

| Before | After |
| --- | --- |
| No `/pull-requests` route | `/pull-requests` lists every PR Fhara opened across the visible projects, newest fact first |
| Sidebar Development group holds only Runs | Development group holds **Pull requests** and Runs; the rail and the command menu get it too (both read `navLinks.ts`) |
| PR facts readable only per task | New public query `pullRequests.list` groups `taskPushes` rows by `repoFullName#prNumber` |

## Current state

- `apps/api/convex/schema.ts:1372` — `taskPushes` carries the PR fields; PR
  facts are copied onto every row of the same PR (`githubPush.ts:748`,
  `prFeedback.ts:85`).
- `apps/api/convex/changes.ts:59` — `prFacts(row)` shows how a row projects
  to PR facts; `newestPush` shows the newest-row-wins rule.
- `apps/api/convex/inbox.ts:69` — pattern for reading across visible
  projects (`visibleProjects(ctx)` from `lib/authz.ts`) and for bounding
  reads with `.take(...)`.
- `apps/web/components/sidebar/navLinks.ts:25` — the Development group
  (`GitBranch`, Runs). The rail (`Sidebar.tsx:220`) and the command menu
  read the same array.
- `apps/web/app/inbox/page.tsx` — page shell pattern: `<Sidebar />` +
  `<main>`, `useQuery` undefined → skeleton, empty state, rows link with
  `projectHref` + `requestThread(projectId, taskId)`.

## Decisions that must not change during execution

- No schema change. PR facts are read from `taskPushes` as they are.
- Read path only: no mutations, no merges from this page. The merge gate
  (approval model, plan 043 O2) is untouched.
- Rows group by `repoFullName + prNumber`; the row with the newest
  `prFactsAt ?? updatedAt` wins. Fix-task rows carry `ownerTaskId`; the
  internal "view task" link uses `ownerTaskId ?? taskId`.
- Visibility = `visibleProjects(ctx)`, same rule as the Inbox.
- No GitHub API calls: the page renders what the webhook/cron facts
  already stored. `prState` unset renders as "open".
- Global list, not per project (user decision, 2026-11-13): the sidebar
  links to plain `/pull-requests` and the query takes no `projectId`.
- Copy in English. Nav row and page reuse `navLinks.ts` / existing page
  shell; no new UI primitive.

## Steps

### Step 1: backend query `pullRequests.list`

New module `apps/api/convex/pullRequests.ts`. Args `{}`. For
each visible project read `taskPushes` via `by_project` (`.take(200)`), keep
rows with `prNumber` and `repoFullName`, group by `repoFullName#prNumber`
keeping the newest `prFactsAt ?? updatedAt`; sort desc; cap at 100. Per entry return:
`_id`, `repoFullName`, `prNumber`, `prUrl`, `prTitle`, `prState`
(default `open`), `branchName`, `baseBranch`, `ciState`, `reviewState`,
`mergeable`, `autoMerge` (`state`, `reason`), `projectId`, `projectName`,
`taskId` (= `ownerTaskId ?? taskId`), `taskTitle`, `updatedAt`. Resolve
`taskTitle` with one `db.get` per distinct task id.

**Check**: `npm run --workspace=@fhara/api typecheck` → clean (after
`npm run --workspace=@fhara/api codegen`).

### Step 2: convex-test

`apps/api/convex/pullRequests.test.ts`: two projects, one PR seen from two
tasks (older/newer facts) → one entry, newest facts win; fix-task row with
`ownerTaskId` links to the owner task; rows without `prNumber` are
excluded; projects the viewer cannot see do not leak.

**Check**: `npx --workspace=@fhara/api vitest run convex/pullRequests.test.ts` → pass.

### Step 3: page `/pull-requests`

`apps/web/app/pull-requests/page.tsx`, modeled on the Inbox page: sidebar,
header (`Pull Requests`, open count), loading skeleton, empty state, one
`<ul>` sorted as returned. Each row: state chip (draft/open/merged/closed),
title (`prTitle ?? "PR #<n>"`), sub-line `projectName · repoFullName#n ·
branch → baseBranch`, CI/review/mergeable/auto-merge hints when present,
external GitHub link (`prUrl`) and an internal link to the owning task
(`projectHref` + `requestThread`). `useQuery(api.pullRequests.list, {})`.

**Check**: `npm run --workspace=@fhara/web typecheck` → clean.

### Step 4: sidebar entry

`navLinks.ts`: add `GitPullRequest` to the Development group before Runs —
`href: "/pull-requests"` (global, no `?project=`), `active: pathname.startsWith("/pull-requests")`.
Rail and command menu pick it up automatically.

**Check**: `npm run --workspace=@fhara/web typecheck` → clean;
`npm run check:guards` → ok.

## Test plan

- `pullRequests.test.ts` (Step 2).
- Manual: open `/pull-requests`; with PRs present the rows show the newest
  facts; empty state copy when none.

## Completion criteria

- [x] `npm run --workspace=@fhara/api typecheck` clean; `pullRequests.test.ts` green (3 tests). Update 2026-11-13: the `?project=` scoping was removed (user decision: global list); the page no longer reads search params and renders without the Suspense wrapper.
- [x] `npm run --workspace=@fhara/web typecheck` clean; `npm run check:guards` ok
- [x] `npm run knip` reports no new findings (existing failures are the pre-existing set; nothing mentions pullRequests)
- [x] `/pull-requests` renders (headless browser: h1, empty state, sidebar Development group shows "Pull requests" before Runs). The hydration warning in the console also appears on /runs and /audit — pre-existing, not introduced here. Rows with real PR data were not exercised in the browser (no PR rows locally); the query behaviour is covered by the unit tests.

## STOP conditions

- A check fails twice after a reasonable fix.
- The change needs a schema migration, a merge/approval-path change, or a
  new non-negotiable rule.
