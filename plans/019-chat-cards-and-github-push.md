# Plan 019: Chat cards and the GitHub push / PR flow

## Status

- Priority: P1
- Size: L
- Risk: MEDIUM (credential handling, a new risky action path, schema)
- Dependencies: 018 (worktree isolation: the push needs a committed task branch)
- Planned at: branch `feat/cards-github`, 2026-11-09

## Why this is needed

Stage results (verification, QA, the committed branch) were only visible as
raw task events. Nothing could get a finished task branch to GitHub: the
OAuth integration stored a token but no flow used it, and the callback was
not routed.

## Target behaviour

- One card renderer (`apps/web/components/chat/cards/ChatCard.tsx`) for
  `messages.card`: `assignment` (task card), `changes` ("Changed N files"),
  `verification`, `qa` (live viewport checklist), `push`. Option, question
  and approval cards share the same shell (`cards/primitives.tsx`).
- The worker posts cards into the task's chat (`tasks.conversationId`) and
  task thread: changes after a code_change lands files, verification per
  run, QA running → final on one card key, push after the worktree commit.
- Push: the user's click on the push card records an **approved
  `git_push` approval row** (rule 5: the click is the explicit approval)
  and queues the push; the worker claims it with a lease, pushes
  `<sha>:refs/heads/<branch>` with the project token passed only through
  `GIT_CONFIG_*` env (never argv, `.git/config`, or logs), opens a draft
  PR, and reports back. A cron refreshes PR state in bounded batches.

## Non-negotiable rules touched

- Rule 1 (credentials): the GitHub token crosses to the worker only through
  the token-gated `worker.claimPushRequest`; public queries return no token
  (`githubPush.get` test asserts it). Errors are redacted (raw + base64).
- Rule 2 (worker gating): every new worker action takes `workerToken`;
  card/commit writes are lease-fenced through `workerId`.
- Rule 5 (approval gate): no push without an `approved` `git_push` row; the
  claim re-checks it and fails the request if it was revoked.
- Rule 7 (schema): additive only — `taskPushes` table, optional
  `tasks.conversationId`, `integrations.githubBaseBranch`, new card kind
  literal `changes`.

## Steps (done)

1. Backend: `githubPush.ts`, `cardTypes.ts`, `crons.ts`, `http.ts`;
   worker wrappers; integration repo picker + validation. Tests:
   `convex/githubPush.test.ts`.
2. Worker: `services/runner/cards.ts`, emission in runNodes / verifyLoop /
   qaLoop / taskRunner; `services/pushRequests.ts`, `tools/gitPush.ts`,
   `tools/githubPr.ts`; poll in `index.ts`. Tests:
   `tests/stageCards.test.ts`, `tests/pushRequests.test.ts`.
3. Web: card components, restyled TaskCard / OptionCards / ApprovalCard /
   DiffCard, review snippet in the task thread, QA status line, GitHub
   settings in the Manage project modal, OAuth callback forwarder.

## Open

- Live smoke with a real GitHub OAuth app (not run).
- QA screenshots are local files; the card supports thumbnail URLs but none
  are uploaded yet.
- The webhook route stays unrouted until it verifies signatures.
