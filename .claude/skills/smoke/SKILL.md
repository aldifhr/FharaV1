---
name: smoke
description: Start the Fhara stack and prove a change works in the real app. Use when asked to smoke test, QA, verify, or check a change or PR in the running UI, the worker, or the backend. Covers the web app, the worker, and Convex.
---

# Smoke

Start only the stack the change needs, drive the real app, and report what
passed, what failed, and what you did not check. A smoke test does not replace
tests or typecheck; it proves the user-visible path.

## Before you start

- Read the root `AGENTS.md` and the `AGENTS.md` of every surface in the diff.
- Get the change set: `git diff --name-only $(git merge-base origin/main HEAD)`
  plus `git status --short`. On `main` with no upstream, use the working tree.
- Check that the environment exists: root `.env` needs `NEXT_PUBLIC_CONVEX_URL`,
  `CONVEX_SERVICE_TOKEN`, and `PROVIDER_ENCRYPTION_KEY`. Never print their values.
  Never edit `.env` to make a smoke test pass.
- Do not touch an existing dev stack you did not start.

## Step 1 — Write the plan

Before starting anything, write a table with one row per user action:

| # | Feature | Surface | Action | Expected result |
| --- | --- | --- | --- | --- |
| 1 | Short name | web / worker / backend | Steps | Visible result |

Include the reverse action for each state change (approve/reject, cancel/resume,
connect/disconnect), and a reload when the change touches persisted state.
A refactor, a test-only change, or a docs change has no user-visible behaviour:
say so and stop.

## Step 2 — Choose the smallest stack

| Plan needs | Command |
| --- | --- |
| Web UI only | `npm run dev` (http://localhost:3000) |
| Worker + backend | `npm run convex` (Convex dev + worker in one terminal) |
| A full task run | `npm run convex` **and** `npm run dev` |
| Desktop shell | `npm run electron:dev` |

- Start long-running commands in the background and wait for the port or the
  Convex "Convex functions ready" line, not for a fixed number of seconds.
- Convex codegen is required first on a fresh clone:
  `npm run --workspace=@fhara/api codegen`.
- A full task run spends real provider quota. Keep the prompt short and use a
  cheap model. Say in the report that you spent quota.

## Step 3 — Drive the app

- Use the browser tools against `http://localhost:3000`. Wait for an element or a
  state, never for elapsed time.
- For a backend-only change, drive the function directly instead of the UI:
  `npx convex run <module>:<fn> '<json>'` against the dev deployment, or a
  `convex-test` case when the function is internal.
- For a worker change, watch the worker log and the task's event trail
  (`taskEvents`, `lifecycleHistory`) rather than guessing from the UI.
- Do not add `data-testid`. Select by role and accessible name. An element with
  no accessible name is a finding.

## Step 4 — Clean up

- Stop only the processes you started. Kill by PID. Never `pkill -f node`,
  `pkill -f next`, or `pkill -f tsx`.
- Leave a stack that was already running before you started.
- Do not delete the Convex local database or `workspaces/`.

## Step 5 — Report

| # | Feature | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Short name | pass / fail / not checked | Log line, event row, or screenshot path |

Then list:

- the stack and flags you used, and the surfaces you checked;
- each failure with steps to reproduce, expected, actual;
- each item you did not check and why (paid provider, desktop shell, mobile).

Do not fix a failure unless asked. Do not commit screenshots.
