# Worktree isolation and parallel steps

`ORCHESTRATOR_WORKTREE_ISOLATION` (Settings → Worktrees, or `.env`) decides
whether a task runs in its own git worktree on its own branch, or directly in
the project folder.

| Value | Behaviour |
|---|---|
| `auto` (default) | Decided per task, see below. |
| `1` / `true` | Always isolated. A folder that is not a git repository, or has no commit, holds the task with "Initialize git". |
| `0` / `false` | Never isolated: the task edits the project folder, one step at a time. |

## What `auto` does

Before a task starts, the worker looks at the project folder and at the
Convex deployment it talks to:

| Situation | Isolation | Parallel steps |
|---|---|---|
| Git repository with at least one commit, clean checkout, local or self-hosted backend | on | `ORCHESTRATOR_PARALLEL_DEFAULT` (default 2) |
| Not a git repository, or no commits yet | off | 1 |
| Uncommitted changes (modified or untracked files) | off | 1 |
| Convex cloud deployment (`*.convex.cloud`) | off | 1 |
| Deployment URL missing or unreadable | off | 1 |

- **Uncommitted changes.** A worktree starts from the base branch, so it would
  not see work in progress. `auto` keeps such a task in the folder and posts
  one System line in the task thread: "Running steps one at a time: the folder
  has uncommitted changes." Commit or stash to get isolation and parallel steps
  on the next task.
- **Convex cloud.** The worktree is created by a Convex Node action, which on a
  cloud deployment cannot reach the worker's disk. `auto` stays sequential
  there; set `1` only when the backend runs where the worker's folders are.
- **Explicit limits win.** `ORCHESTRATOR_MAX_CONCURRENCY` and
  `ORCHESTRATOR_MAX_CONCURRENT_LLM_CALLS`, when set, are used as they are.
- **Resumed tasks** keep what their first run chose: a task with a worktree
  resumes isolated, one without stays in the folder.
- With isolation on, OpenCode entries can run (they never run in the real
  checkout unless `ORCHESTRATOR_OPENCODE_ALLOW_UNISOLATED=1`).

Each decision is logged as a `task.isolation` event with its reason
(`ready`, `not_git`, `no_commits`, `dirty`, `cloud_backend`, `unknown_backend`).

The worker-wide LLM gate is sized at start-up. Changing this setting from
`0` to `auto` or `1` at runtime applies to the next task, but the worker-wide
bound (`ORCHESTRATOR_MAX_CONCURRENT_LLM_CALLS`) widens only after a worker restart.
