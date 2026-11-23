# Plan 068: Local-first SQLite backend with a Fhara runtime-compatible runtime (desktop-ready)

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

- Priority: P1
- Size: L (multi-session; steps are independently shippable)
- Risk: HIGH
- Dependencies: none; supersedes the earlier "Fhara runtime self-hosted local" answer
- Planned at: commit `c1d0fc37af`, 2026-11-22

## Why this is needed

The user wants Fhara to run fully locally, with no Fhara runtime cloud, and to be packaged
as a standalone desktop app later. Fhara runtime self-hosted/local still requires a
separately managed backend process (CLI binary under `~/.runtime`, or Docker),
which cannot be cleanly embedded in an Electron installer. An embedded SQLite
file is the only backend shape that is genuinely offline and bundleable. The
current configuration already points at a Fhara runtime `local:` deployment
(`.env:2-4`, `apps/api/.env.local:1-3`), but that is not embeddable.

## Target behaviour

| After this plan | Today |
| --- | --- |
| `FHARA_DB_PATH=… pnpm dev:local` starts web + worker + an embedded local backend; no Fhara runtime URL, no Fhara runtime CLI, no network to Fhara runtime | `pnpm dev` requires `npx runtime dev` and a reachable deployment (`scripts/env.mjs:62-77`) |
| All 694 existing backend function modules run unchanged against SQLite | They only run against Fhara runtime |
| UI uses the same `useQuery`/`useMutation`/`useAction` calls (`apps/web/lib/runtime.tsx:1-13`) | Same, but bound to `Fhara runtimeReactClient` |
| Worker uses the same `WorkerApi` (93 actions, `packages/worker/src/workerApi.ts:47-71`) | Same, but bound to `Fhara runtimeHttpClient` (`packages/worker/src/runtimeClient.ts:4-9`) |
| Data lives in one SQLite file under `~/.fhara/` (or `FHARA_DB_PATH`) | Data lives in a Fhara runtime deployment directory (`~/.runtime/anonymous-runtime-backend-state`) |
| Electron can start the backend as an in-process module and point the UI at it | `electron/main.cjs:99-124` only loads an external dev server URL |

## Current state

- Backend: 67 tables in `apps/api/functions/schema.ts:266`; 694 functions across
  95 top-level modules — 150 `query`, 150 `mutation`, 127 `action`,
  166 `internalMutation`, 75 `internalQuery`, 23 `internalAction`,
  3 `httpAction` (`apps/api/functions/worker.ts:37`, `apps/api/functions/integrations.ts:168,524`).
- Query surface a runtime must emulate: 495 `.withIndex`, 577 `.eq`,
  191 `.collect`, 327 `.take`, 171 `.order`, 450 `ctx.db.get`,
  293 `ctx.db.patch`, 153 `ctx.db.insert`, 61 `ctx.db.delete`,
  4 `.paginate`, 4 `withSearchIndex` (`apps/api/functions/pastWork.ts:46-54`,
  `apps/api/functions/memories.ts:111`), ~5 Fhara runtime `q.filter` builder uses.
- Cross-function calls: 198 `ctx.runMutation`, 90 `ctx.runQuery`,
  13 `ctx.runAction`, 37 `ctx.scheduler.runAfter/runAt`.
- Generated `api = anyApi` (`apps/api/functions/_generated/api.js:15`), so a
  function reference already has a readable string path — no generated-file
  rewrite is needed.
- Web: 97 files import `runtime/react`; 168 `useQuery`, 143 `useMutation`,
  17 `useAction`, 4 `useFhara runtime` (5 direct `.query()` calls), 1 `useQueries`,
  3 `.withOptimisticUpdate` sites. All references are static `api.module.fn`.
  5 server routes use `Fhara runtimeHttpClient` with `FHARA_SERVICE_TOKEN`.
- Worker: 94 `WorkerApi` methods + 15 direct paths = 109 distinct function
  paths; only `action/query/mutation/onUpdate/close` are used on the client.
- Available runtime: Node 24.22.2 (`.nvmrc:1`). Data layer is now **Drizzle ORM
  over SQLite** (user decision 2026-11-22), replacing the earlier raw
  `node:sqlite` store.

## Decisions that must not change during execution

1. **Keep the function modules.** No porting 694 handlers by hand. Compatibility
   lives in the runtime, not in the features.
2. **Remove the `runtime` npm package entirely** (user decision 2026-11-22).
   The `runtime/*` imports across backend, web and worker are redirected by an
   automated import rewrite to locally owned modules (`values`, `server`,
   `react`, `browser`, `api`, `dataModel`). No Fhara runtime dependency, deployment or
   cloud call remains anywhere in the repo.
3. **Replace the generated `api`/`dataModel` with local equivalents.** Function
   references become plain `{ module, export }` strings; call sites keep the
   same `api.module.fn` shape via a generated local module.
4. **Keep every non-negotiable rule in `AGENTS.md`**: service-token gate
   (`assertServiceToken`, now over a local token), terminal task immutability,
   human approval gate, pre-call budget gate, sandbox/argv allowlist, additive
   schema discipline, AES-GCM credential encryption. A change to any of these
   is a STOP.
5. **No Fhara runtime cloud call anywhere at runtime.** Install may still fetch the
   npm package; no `runtime dev`, `runtime deploy`, `FHARA_BACKEND_URL` or
   deployment token is used by the local stack.
6. **Reactivity is polling with a version counter first** (interval ~1 s, plus
   an immediate re-fetch after any local mutation). SSE/WebSocket is a later
   optimisation, not a blocker.
7. **SQLite schema is generated from `schema.ts`**, additive and idempotent;
   the DB file starts empty. Importing an existing Fhara runtime deployment is out of
   scope for this plan.

## Steps

### Step 1: Scaffold `@fhara/runtime` and the SQLite store

Create a workspace package (`packages/runtime`) with:
- `db.ts`: Drizzle ORM over `better-sqlite3`; `FHARA_DB_PATH` default
  `path.join(homedir(), ".fhara", "fhara.db")`; WAL mode; `BEGIN IMMEDIATE`
  transactions with a bounded busy retry.
- `schema.ts`: translate the `defineSchema` table declarations into `CREATE TABLE
  IF NOT EXISTS` statements. Each row gets `id TEXT PRIMARY KEY`,
  `_creationTime INTEGER NOT NULL`, and one JSON/text column per declared field;
  compound indexes from `.index(...)`. System fields are generated on insert;
  `Id<"table">` is an opaque string prefixed with the table name.
- A generator that emits the table/index metadata once (committed file) so the
  runtime does not need to import Fhara runtime's schema builder at runtime.

**Check**: `pnpm --filter @fhara/runtime test` → store tests pass: insert
generates `_id`/`_creationTime`, compound index lookup returns correct order,
WAL file created at `FHARA_DB_PATH`, second start reuses the same data.

### Step 2: Implement the Fhara runtime-compatible query builder and `ctx`

- `queryBuilder.ts`: `withIndex(name, cb)`, `eq/lt/lte/gt/gte`, `order`,
  `first/take/collect/unique/paginate`, `withSearchIndex` via FTS5 virtual
  tables with filter-field AND, and the Fhara runtime implicit `_creationTime`
  tie-breaker for index ordering. Support dynamic table names
  (`apps/api/functions/projects.ts:353`, `apps/api/functions/threads.ts:123`).
- `ctx.ts`: `db` reader/writer, `runQuery/runMutation/runAction`,
  `scheduler.runAfter/runAt` persisted as rows in a local `jobs` table,
  `storage.*` writing blobs under `~/.fhara/storage`, and
  `auth.getUserIdentity()` returning null (single-user local, matching
  `apps/api/functions/lib/authz.ts:17`).
- `validators.ts`: walk the `runtime/values` validator objects to validate args
  before dispatch, including rejecting unknown fields.

**Check**: targeted vitest over 6 representative read paths (index range,
desc order, `.first`, `.paginate`, FTS search, dynamic table) and 3 write paths
(patch, replace, delete) → all match the recorded Fhara runtime results in
`apps/api/functions/*.test.ts`.

### Step 3: Function registry and transport

- `registry.ts`: replace `_generated/server` constructors in the local build so
  importing each top-level module registers `{path, kind, handler}`; loader sets
  the current module name before `await import()`.
- `server.ts`: `node:http` server with `POST /local/{query|mutation|action}`
  taking `{ path, args, workerToken? }`, `GET /local/version`, and
  `POST /local/storage`. Calls `assertServiceToken` for worker paths — the same
  gate as `apps/api/functions/worker.ts:31-35`.
- TypeScript path aliases in `apps/web/tsconfig.json` and
  `packages/worker/tsconfig.json` map `runtime/react` → the local React shim and
  `runtime/browser` → the local HTTP client. Keep `_generated/api` imports as-is.

**Check**: `npm run --workspace=@fhara/web typecheck` and
`npm run --workspace=@fhara/worker typecheck` → 0 errors with aliases active;
a curl POST to `/local/query` with path `projects:list` returns JSON.

### Step 4: Client shims (no UI/worker rewrites)

- React shim exports `Fhara runtimeProvider`, `Fhara runtimeReactClient`,
  `useQuery(ref, args|"skip")`, `useMutation(ref)` returning a callable with
  `.withOptimisticUpdate` (store: `getQuery/setQuery/getAllQueries`),
  `useAction`, `useFhara runtime()` (`.query()` only), `useQueries(record)`.
  Cache key = `(path, stable-stringified args)`; keep previous value during
  refetch; `undefined` while loading; poll `/local/version` and re-fetch changed
  keys; invalidate immediately after a local mutation.
- HTTP client shim exports `Fhara runtimeHttpClient` with `query/mutation/action`,
  reading `ref._functionName` and injecting `workerToken` from `WorkerApi.args()`.
  Preserve `onUpdate/close` as a no-op when `WORKER_SUBSCRIBE=0`, otherwise
  poll `worker.pendingWork`.

**Check**: 3 web unit tests for hook loading/skip/optimistic behaviour; worker
`WorkerApi.claimTask` integration test against the local server returns the same
shape as the Fhara runtime action.

### Step 5: Vertical slice through the real app

Wire `pnpm dev:local` (concurrently: local backend + web + supervised worker)
and set `FHARA_BACKEND_URL` to the local server URL for the web build only.
Drive: create project → seed agents → send a chat message → worker claims task
→ approve a file change.

**Check**: smoke script proves all five steps with no Fhara runtime process running;
`pnpm --filter @fhara/api test` still passes against the real Fhara runtime test
runtime (the backend modules are unchanged).

### Step 6: Cover the remaining runtime services

- `httpAction` routes and `http.ts` router → local HTTP routes (OAuth callback,
  GitHub webhook, scheduled hooks).
- `crons.ts` 8 registrations → persisted jobs.
- 7 `"use node"` modules with `fs`/`execFileSync`/`fetch` → regular Node imports
  in the local process; keep the node/non-node boundary (actions only).
- Storage upload/download used by `optionReviews.ts:246,307` and `projects.ts:376`.
- WebCrypto helpers (`lib/llmCrypto.ts`, `lib/githubWebhook.ts`,
  `lib/oauthState.ts`, `lib/auditHash.ts`) must produce byte-identical results.

**Check**: every `apps/api/functions/*.test.ts` file passes under the local runtime
(or records a documented, justified skip); `securityInvariants.test.ts` green.

### Step 7: Desktop packaging

- Electron main starts the local backend in-process with `FHARA_DB_PATH` under
  `app.getPath("userData")`, plus the worker; drop `DEV_SERVER_URL` dependency.
- Verify Electron's bundled Node supports `node:sqlite`; if not, add
  `better-sqlite3` + `electron-rebuild` as an explicit follow-up decision.
- Build script produces a single app with no external services.

**Check**: packaged app boots offline, creates the DB under userData, and the UI
loads without any Fhara runtime URL configured.

### Step 8: Retire Fhara runtime from the local run path

Remove `runtime dev` from `pnpm dev`/`pnpm runtime`, update `.env.example`, README,
`scripts/env.mjs`, and `scripts/doctor.mjs` so no Fhara runtime deployment is required.
Keep the `runtime` npm package for validators/types.

**Check**: `pnpm doctor` clean with no `FHARA_DEPLOYMENT`; grep shows no runtime
Fhara runtime deployment call in the local stack.

## Test plan

- Invariant: SQLite preserves Fhara runtime document and index semantics — golden tests
  compared against the existing `local-test` expectations.
- Invariant: security gates survive the transport change — service token
  refused when `FHARA_SERVICE_TOKEN` is unset, terminal task completion still
  returns `{ applied: false, reason: "task_already_terminal" }`, approval rows
  still required for `apply_changes`/`git_push`/`run_command`/`merge_pr`, budget
  gate still pre-call.
- Negative cases: unknown function path refused; malformed args refused by
  validators; cross-user owner check still conditional (`lib/authz.ts`); DB
  path outside the configured root refused.
- No live-provider or Playwright test is added to the default suite.

## Completion criteria

- [ ] `pnpm --filter @fhara/runtime test` green.
- [ ] All workspace typechecks green with the compatibility aliases active.
- [ ] `pnpm dev:local` runs web + worker + local backend with no Fhara runtime process.
- [ ] Vertical slice smoke passes end to end.
- [ ] `pnpm --filter @fhara/api test` and `pnpm test` green.
- [ ] Electron packaged app boots offline with the DB under userData.
- [ ] README / `.env.example` / doctor no longer require a Fhara runtime deployment.
- [ ] `plans/README.md` state set to DONE with evidence.

## STOP conditions

- Any non-negotiable rule in `AGENTS.md` would have to change.
- A schema migration needs a destructive operation.
- Existing backend modules must be edited to work around the runtime (signals
  the compatibility approach is wrong — reassess before continuing).
- A check fails twice after a reasonable fix.
- The change needs work outside this repository (e.g. an Electron native-module
  release that cannot be built here).
