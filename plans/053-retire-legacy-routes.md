# Plan 053: Retire the legacy route layer

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

- Priority: P3
- Size: S
- Risk: LOW (old bookmarks only; every route redirects today)
- Dependencies: none
- Planned at: `improve` web-UI audit, 2026-11-13

## Why this is needed

Five routes exist only to redirect, and nothing in the app links to them:

| Route | File | Redirects to |
| --- | --- | --- |
| `/chats/[id]` | `app/chats/[id]/page.tsx` (24) | `/project/{id}` + `?task=`/`?tab=` |
| `/chats/personal` | `app/chats/personal/page.tsx` (5) | `/message` |
| `/personal-messages` | `app/personal-messages/page.tsx` (8) | `/messages` |
| `/workspace/[projectId]` | `app/workspace/[projectId]/page.tsx` (11) | `/project/{id}` |
| `/workspace/[projectId]/chat` | `app/workspace/[projectId]/chat/page.tsx` (12) | `/project/{id}` |

Evidence that they are unreachable from the UI: a repo-wide search for
`/workspace`, `/personal-messages` and `/chats/personal` in `app/`,
`components/` and `lib/` finds only the redirect targets themselves. The live
routes are `/messages`, `/message`, `/message/[agentId]` and
`/project/[projectId]`, and `/chats` (the "Pick a project" landing page), which
must stay.

Cost today is small but real: five extra route entries in every `next build`,
three different names for one concept (`/chats`, `/workspace`, `/project`), and
`knip` has to treat them as entry points (see `knip.json` `entry`).

## Decision required before starting

Deleting them breaks old bookmarks and any deep link someone saved. Pick one:

- **A. Delete** — cleanest, old links 404 (which now renders `app/not-found.tsx`).
- **B. Keep, consolidate** — keep only `/chats/[id]` and `/workspace/[projectId]`
  as redirects (the two a user could plausibly have saved from the first
  versions), delete the personal-chat pair.
- **C. `next.config` redirects** — replace the route files with a
  `redirects()` table, so the redirect survives without a page file.

Recommendation: **C** for `/chats/[id]` and `/workspace/[projectId]` (cheap, no
page files, still works), **A** for `/chats/personal` and `/personal-messages`
(they were UI-only names that never shipped in a release note).

Record the choice in this plan before step 1.

## Steps

### Step 1: Replace with config redirects or delete

- For each route kept: add `{ source, destination, permanent: false }` to
  `redirects()` in `apps/web/next.config.*`; preserve the query passthrough that
  `app/chats/[id]/page.tsx` implements today (`?task=`, `?tab=`) — a static
  redirect cannot copy arbitrary query params, so if that matters, keep the page
  file for `/chats/[id]` and delete only the others.
- For each route deleted: remove the directory. Nothing else imports it.

**Check**: `npm run --workspace=@fhara/web build` — the route list no longer
contains the deleted routes; `next build` prints the redirect warnings if any.

### Step 2: Update the references

- `knip.json` `entry` already globs `app/**/page.tsx`; no change needed, but run
  `npm run knip` to confirm nothing became unused.
- `apps/web/AGENTS.md` already lists the live route set and the boundary files;
  re-check it after the deletion.

**Check**: `npm run knip` — no new unused files.

### Step 3: Verify the surviving links

Open in the browser: `/`, `/chats`, `/messages`, `/message`,
`/message/<agentId>`, `/project/<id>`, `/project/<id>/<threadId>`,
`/runs/<taskId>`, `/team`, `/team/<agentId>`, `/library`, `/memory`, `/audit`,
`/inbox`, `/search`, `/improve`, `/integrations`, `/settings` (if it exists as a
route or a modal), and one deleted URL to confirm it 404s into the new page.

## Test plan

- No unit test. The proof is `next build`'s route table plus the browser list
  above.

## Completion criteria

- [ ] Every redirect-only route is deleted or in `next.config` `redirects()`.
- [ ] `next build` green; route table recorded in `plans/README.md`.
- [ ] Deleted URLs land on `app/not-found.tsx`, not the default 404.
- [ ] `npm run knip` clean of new findings.

## STOP conditions

- A redirect route turns out to be linked from outside the repo (docs, README,
  a plan) — update the doc in the same change or stop and ask.
- `redirects()` cannot preserve the `?task=`/`?tab=` passthrough and those links
  matter — keep that page file and delete only the rest.
