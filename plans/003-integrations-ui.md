# Plan 003: Integrations UI on the existing backend

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When done,
> set this plan's state in `plans/README.md`.

## Status

- Priority: P2
- Size: M
- Risk: MEDIUM (touches stored OAuth tokens)
- Dependencies: none
- Planned at: `main`, 2026-11-07

## Why this is needed

The GitHub integration backend exists but has no UI, so no user can connect an
account. `ROADMAP.MD` line 61 still says integrations are "not available in the
backend yet" — that is stale and should be corrected.

## Target behaviour

| Action | Result |
| --- | --- |
| Open workspace settings → Integrations | Existing integrations for the project, with status |
| Connect GitHub | OAuth flow starts, returns, and the row appears as `active` |
| Pick a repository | `githubOwner` / `githubRepo` saved |
| Refresh | Re-fetches the GitHub user and updates `lastSyncAt` |
| Disconnect | Row becomes `disconnected`, tokens are cleared |

## Current state

`apps/api/convex/integrations.ts`:

- `getOAuthUrl` (14), `handleOAuthCallback` (35, `httpAction`),
  `handleWebhook` (198, `httpAction`).
- `upsertGithubIntegration` (144) is already an `internalMutation` — good.
- `listByProject` (232) masks the token (`hasAccessToken`); `get` (260) returns a
  masked suffix.
- `remove` (279), `refresh` (298), `updateConfig` (346) are **public mutations
  with no token gate and no ownership check**. Anyone who can reach the
  deployment can disconnect or reconfigure a project's integration.
- `getMcpConfig` (371) was converted to `internalQuery` on 2026-11-07 because it
  returns the plaintext token; it has no callers today.

`apps/web` has **no** `api.integrations` reference. There is no settings section
for integrations. `apps/web/components/Settings.tsx` is the settings modal
(143 lines).

## Decisions that must not change during execution

- A GitHub access token never reaches the browser. Not in a query result, not in
  a mutation argument, not in a page prop.
- Integration writes go through a server-side Next route (same pattern as
  `apps/web/app/api/llm-providers/route.ts`) that holds
  `CONVEX_SERVICE_TOKEN`. Do not call admin mutations from a client component.
- Disconnect is a soft delete (`status: "disconnected"`, tokens cleared) to keep
  the audit trail. Do not hard-delete the row.
- The OAuth `state` must be verified on callback. Do not trust a `state` the
  client can set freely.
- One GitHub connection per project in this iteration. Multiple accounts is a
  different feature.

## Steps

### Step 0: Harden the write path

In `integrations.ts`, convert `remove`, `refresh`, and `updateConfig` to
`internalMutation`, and add `worker.ts` actions that wrap them with
`assertServiceToken` (use the existing `withoutToken` pattern). The Next route
calls those actions with the service token.

**Check**: `grep -n "export const \(remove\|refresh\|updateConfig\)" apps/api/convex/integrations.ts`
→ all three are `internalMutation`. Typecheck exits 0.

### Step 1: Route

New `apps/web/app/api/integrations/route.ts`:

- `POST { action: "remove" | "refresh" | "update-config", ... }`
- Holds `CONVEX_SERVICE_TOKEN` server-side, forwards to the Convex actions.
- Validates the body shape; returns `{ ok: true }` or an error code.
- Never echoes the token.

**Check**: `npm run --workspace=@moagent/web build` → exit 0.

### Step 2: OAuth return page

The callback URL (`GITHUB_OAUTH_CALLBACK_URL`, default
`http://localhost:3000/api/integrations/github/callback`) must land on a page
that closes the popup and refreshes the list. Add
`apps/web/app/integrations/github/callback/page.tsx`. If the backend already
handles the callback as an `httpAction`, this page only reports the result.

**Check**: opening the URL with a fake code returns a readable error, not a stack
trace.

### Step 3: Settings section

Extend `apps/web/components/Settings.tsx` with an "Integrations" section:

- List rows: name, status badge, `lastSyncAt`, `hasAccessToken`.
- Connect button → `api.integrations.getOAuthUrl`.
- Repository picker → the route from Step 1.
- Refresh / Disconnect → the route from Step 1.
- Empty state with a real explanation.
- All copy in English.

**Check**: typecheck and build exit 0.

### Step 4: Status surfacing

If `status === "error"`, show `errorMessage` and a retry action. Do not swallow
it.

### Step 5: Correct the backlog

Update `ROADMAP.MD` line 61: the backend exists; the item is now the UI.

## Test plan

- `integrations.test.ts` (convex-test): `listByProject` never returns
  `accessToken`; `get` never returns the full token; `remove` clears both tokens
  and sets `disconnected`; a public caller cannot invoke the internal mutations
  (a direct `t.mutation(api.integrations.remove, …)` must no longer typecheck —
  assert through the action path with a bad token and expect a refusal).
- Route test is manual: a bad body is rejected before reaching Convex.

## Completion criteria

- [ ] No public Convex function returns a GitHub token.
- [ ] All integration writes require the service token.
- [ ] A user can connect, configure, refresh, and disconnect from Settings.
- [ ] `npm run --workspace=@moagent/api test` passes.
- [ ] `ROADMAP.MD` is corrected.

## STOP conditions

- GitHub OAuth app credentials are not configured in the deployment.
- The callback needs a public HTTPS origin that does not exist yet.
- The work would require storing a token in the browser to function.
