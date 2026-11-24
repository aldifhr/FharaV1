# Plan 080 — use the workspace's Git origin as the push target

- Date: 2026-11-23
- State: DONE (2026-11-23)

## Context

Plan 079 removed GitHub OAuth: the token is now imported once from the local
Git credential helper. The push card still blocked approval with "Choose a
repository in project settings first" because `githubPush` required a
per-project `integrations` row with `githubOwner` / `githubRepo`.

The project no longer needs a GitHub-specific settings step. The workspace is
already a Git checkout with an `origin` remote, so that remote is the natural
push target. A project-level repo binding remains supported as an explicit
override, but it is optional.

## Decisions

1. The credential check stays: a local Git credential must have been imported
   through `integrations.importLocalGithub`. Without it the push card stays
   blocked.
2. `githubPush.requestPush` no longer checks for a repo binding.
3. `githubPush.claimPushRequest` resolves the token as before. It includes
   `owner` / `repo` / `baseBranch` from the project binding **only when one
   exists**; otherwise it omits them. `closesIssueFor` is only called when a
   repo is known at claim time.
4. The worker resolves the missing target from the workspace checkout with
   `git -C <workspacePath> remote get-url origin`, using the same hardened git
   runner as the push. Supported URL forms: HTTPS (with or without
   credentials), `git@github.com:owner/repo.git`, and
   `ssh://git@github.com/owner/repo.git`. A non-GitHub or unparseable origin
   fails the push with a plain message.
5. `baseBranch` defaults to the project's `mainBranch`, then `main`.
6. Project repo settings are reworded as an optional pin; the card no longer
   requires them.

## Files

- `apps/api/functions/githubPush.ts`
- `packages/worker/src/tools/gitPush.ts`
- `packages/worker/src/services/pushRequests.ts`
- `apps/web/components/chat/cards/PushCard.tsx`
- `apps/web/components/GithubRepoSettings.tsx`
- Affected backend/worker tests and generated runtime bundle.

## STOP conditions

- Do not read or write an OAuth client, callback, or state.
- Do not send the token through argv, a remote URL, `.git/config`, or logs.
- Keep the approval gate and the worker lease/no-replay ledger intact.
- Do not claim the worker can push to a workspace without a GitHub `origin`.

## Verification log

- Added `unbindRepo` so an existing pin can be removed and the origin fallback
  used. The repo settings label is now an optional override with a "Use origin"
  action; the push card no longer blocks on a repo binding.
- `codegen:offline` regenerated the runtime bundle after the backend changes.
- Focused GitHub backend tests: 27/28 pass; the only failure is the known
  pre-existing `enforces project access when the project has an owner` test.
- Worker tests: `gitPushHardening` 12/12, `pushRequests` 12/12. Full worker
  suite has 43 pre-existing failures in unrelated suites (MCP, checkpoints,
  role prompts, etc.); no push-related test fails.
- API and web typechecks pass. Worker typecheck still has the known pre-existing
  missing `lead` policy error.
### Follow-up: PR creation 422 and stale route warning

- The first live push landed but PR creation returned `422 Validation Failed`.
  Two causes were addressed: an unpinned claim guessed `base: "main"` even
  when the repository's default branch differed, and the error parser dropped
  GitHub's `errors[].field` / `code` detail.
- `githubPush.claimPushRequest` now omits `baseBranch` for unpinned targets.
  The worker calls `GET /repos/{owner}/{repo}` and uses `default_branch` for
  the push guard, PR base, dependency check and completion report.
- PR failure messages now include field/code/resource details and a short raw
  body fallback.
- The local runtime route loader had a hardcoded deleted OAuth callback route;
  removed it and made loading skip missing route files.
- Verification: worker `pushRequests` + `gitPushHardening` 26/26; backend
  GitHub suites 27/28 (known pre-existing project-owner authz failure);
  runtime/API/web typechecks pass. Worker typecheck has only the known missing
  `lead` policy error. A live probe now finds `integrations:unbindRepo` on the
  running backend, so the backend is current; the worker still needs a restart.

### Follow-up: base == head on a live repository

- The detailed 422 was `No commits between <task branch> and <task branch>`.
  `git ls-remote --symref origin HEAD` on the live `D:\CODE\demo-app`
  repository showed GitHub's HEAD pointing at that task branch: the repository
  default branch *was* the task branch, so using it as the PR base was invalid.
- The worker now detects `default_branch === task branch` and falls back to a
  real local trunk (`master`, then `main`) verified with `git show-ref`. If
  neither exists, it fails with a clear instruction to set a base branch in
  project settings.
- First fallback attempt used `git show-ref --verify --quiet`, whose success
  output is empty, so the SHA check never matched. Switched to
  `git rev-parse --verify --quiet refs/heads/<name>`; verified against the live
  workspace that `refs/heads/master` resolves to `394e4d69...`.
- Added a regression test for this case. Worker push tests now 27/27.

### Follow-up: live repo has no base branch, and PR-only retry

- Checked `https://github.com/aldifhr/DemoApp` directly: `default_branch` is
  the current task branch; the API lists only two branches, both task
  branches. There is no `master` or `main` on GitHub, even though the local
  checkout has `master`. A PR cannot be opened until a real base branch
  exists on the remote.
- Studied `D:\CODE\t3code` (`GitManager.resolvePrBase`): it resolves the PR
  base from branch config/upstream first and only then from the provider
  default. This confirms that trusting GitHub's `default_branch` alone is
  insufficient. Fhara now verifies the chosen base with
  `GET /repos/{owner}/{repo}/branches/{branch}` and fails with an explicit
  message when it does not exist.
- A commit that is already pushed but whose PR failed used to be reported as
  `failed`, so retrying pushed the same SHA again. The worker now keeps that
  row as `pushed` with the PR error attached, and the claim carries
  `alreadyPushed` so a retry skips `git push` and opens only the PR.
- Worker push tests 29/29; backend GitHub tests 27/28 (known pre-existing
  authz failure); API/web/runtime typechecks pass; worker typecheck has only
  the known missing `lead` policy error.
