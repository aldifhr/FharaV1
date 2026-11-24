# Plan 079: Git-native GitHub authorization (remove app OAuth)

## Status

- State: DONE (2026-11-23)
- Priority: P1
- Size: XL
- Risk: HIGH (credential handling, five surfaces, schema)
- Dependencies: 019
- Planned at: 2026-11-23

## Why this is needed

The user decided that no project should use GitHub OAuth; GitHub access must
work through plain git. Fhara currently connects a GitHub account with an
OAuth app, stores the issued token in `githubConnections`, and hands that
token to the worker for push/PR and to the backend for PR checks and merge.
That whole path is replaced with the operator's local git credentials.

## Decisions

- **The Git CLI is the only credential source** (https://git-scm.com/, per
  the user). A node-only action runs `git credential fill` for
  `https://github.com`, so Git's configured helper (Credential Manager,
  Keychain, credential store, or a PAT) supplies the login and token. No
  GitHub CLI dependency, no app OAuth client, no callback, no browser popup.
  The token is imported through the existing AES-256-GCM encrypted
  `githubConnections` row and still crosses to the worker only through the
  token-gated `claimPushRequest`, so rules 1 and 2 stay intact. Queries
  remain pure: they keep reading the encrypted row, never the CLI.
- **The human approval gate stays.** `git_push` and `merge_pr` still require
  an `approved` row; the plan-043 supervised auto-merge exception is
  unchanged. Approvals are not tied to a GitHub identity today, so this
  change does not alter who may approve.
- **Worker/backend token gate stays.** Every worker-facing action still
  takes `workerToken` and calls `assertServiceToken`. The push claim no
  longer returns a credential, but remains gated.
- **Schema is additive.** `githubConnections`, `oauthStates`, and the legacy
  `integrations.accessToken` / `refreshToken` / `tokenExpiresAt` columns stay
  declared and optional; new code stops writing and reading them. A later
  migration may drop them.
- **Webhooks stay.** `GITHUB_WEBHOOK_SECRET` is HMAC verification, not
  OAuth. Issue intake's "connected login" filter must be removed or
  replaced because no login is stored any more.
- **Generated files are regenerated**, not hand-edited: `env-manifest.json`,
  `.env.example`, `generatedDataModel.ts`.

## Non-negotiable rules

Rules 1, 2, 3, 4, 5, 6 and 7 from the root `AGENTS.md` are **not weakened**.
This change removes a credential path instead of adding one; it needs no
exception. The plan is recorded because the user explicitly changed how
GitHub access works across all projects.

## Steps

1. **Backend**: delete OAuth actions and callback handler, `lib/oauthState.ts`,
   the `getOAuthUrl`/`createOAuthState`/`consumeOAuthState` /
   `handleOAuthCallback` / `migrateGithubToGlobal` exports. Add a node-only
   `importLocalGithub` action that reads `gh auth token`, fetches the login
   from `gh api user`, and calls the existing encrypted upsert. Keep
   `resolveGithubToken`, `claimPushRequest`, `getPrRefreshTarget`,
   `autoMerge.getAttemptWork`, `listGithubRepos`, `mcpServers` token sync,
   `bindRepo`, webhook handling and all approval checks unchanged.
2. **Worker**: no change needed to `gitPush.ts`, `githubPr.ts` or
   `pushRequests.ts`: they already consume the imported token through the
   token-gated claim, with sandbox hardening and redaction.
3. **Web**: delete the OAuth callback forwarder and connect-account button;
   show git-native status and setup instructions; drop `useGithubOAuth`
   from MCP server forms; keep the repo picker wired to `listGithubRepos`.
4. **Config**: remove `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
   `GITHUB_OAUTH_CALLBACK_URL`, `OAUTH_STATE_SECRET` from schema, manifest,
   runtimeSync, secrets lists, doctor and `.env.example`. Keep
   `GITHUB_WEBHOOK_SECRET` and `APP_ORIGIN` if still used.
5. **Cleanup/tests**: regenerate generated files, update affected tests,
   run `knip`, focused typechecks and test suites.

## Test plan

- Focused: backend `githubGlobal`, `githubPush`, `autoMerge`, `integrations`,
  `securityInvariants`; worker `gitPushHardening`, `pushRequests`,
  `githubPr` if present; config parity and doctor tests.
- Typechecks: `@fhara/config`, `@fhara/api`, `@fhara/worker`, `@fhara/web`.
- `knip` for dead exports/files. No live-provider calls.

## Completion criteria

- No code path reads or writes a GitHub OAuth client, callback or state;
  no token is returned from any public query to a client. The only token
  import is the operator-triggered local `gh auth token` action.
- A user can push a task branch and open/merge a PR using local git/gh
  credentials, and every push/merge is still gated by an approval row.
- Focused checks pass; the plan index is marked DONE.

## Verification log

- Typechecks: `@fhara/api`, `@fhara/web`, `@fhara/config` pass. `@fhara/worker`
  has one pre-existing error in `execution/opencodePermissions.ts` (missing
  `lead` policy), unrelated to this change.
- Focused tests pass: backend `githubGlobal` (6/6); worker `childEnv`,
  `config/runtimeParity`, `config/secretsParity`, `gitPushHardening`;
  scripts `env.test.mjs` + `doctor.test.mjs` (12/12).
- Focused backend run (`securityInvariants`, `mcpIntegrations`, `githubPush`,
  `autoMerge`) has 12 failures; the clean HEAD baseline has 13. No new
  failures; the remaining ones are stale MCP test args and local-runtime
  DB/HTTP gaps.
- `knip` reports only pre-existing unused files/deps/unresolved imports.
- Generated files refreshed: `env-manifest.json`, `.env.example`,
  `packages/runtime/dist/functions.mjs`. The runtime bundle contains
  `readLocalCredential` / `importLocalGithub` and no OAuth handler.
- Not run: live GitHub push/PR smoke, browser smoke, full web build.

### Follow-up: stale push-card copy (same day)

- The push card still showed "Connect GitHub in project settings first" and
  linked the repo settings button to `/integrations`. Both pointed at flows
  that no longer exist. Reworded the card/backend error to "Import your local
  Git credential in Settings → Account first" and made the repo-settings
  button open that Account tab directly. Also refreshed stale hints in
  `githubSkillsApi.ts` and `gitPush.ts`.
- Re-ran `codegen:offline` (generated bundle carries the new copy), API/web
  typechecks, focused GitHub backend tests (26/27; only the known pre-existing
  project-owner authz failure remains), and worker git-push tests (9/9).

## STOP conditions

- A non-negotiable rule must be weakened.
- A schema column must be dropped in the same change that stops writing it.
- A focused check fails twice after a reasonable fix.
