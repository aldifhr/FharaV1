# Plan 034: OpenCode model catalog in the agent editor

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

- Priority: P2
- Size: M
- Risk: LOW
- Dependencies: plan 014 (provider-native runtime)
- Planned at: commit `22b7f5f`, 2026-11-10

## Why this is needed

The agent editor stores an OpenCode model as free text
(`apps/web/components/sidebar/AgentForms.tsx:541`). The user has to know the
exact `provider/model` id that the local OpenCode CLI accepts, and a typo is
only discovered when a subtask runs and OpenCode exits with an unknown-model
error. The list of usable models already exists on the worker machine
(`opencode models`), but the app never reads it.

## Target behaviour

In the agent editor (Team → agent → Advanced → Runtime) the OpenCode model
becomes a dropdown:

- the models the worker's OpenCode CLI can actually run, grouped by provider;
- "Fhara LLM (default)" = no explicit model (the worker points OpenCode at
  Fhara's own LLM);
- "Custom…" keeps the free-text field for a model the CLI does not list;
- a status line: who reported the list, when, and why the CLI is unavailable;
- a "Refresh" button that asks the worker to re-read the list.

## Current state

- `apps/web/components/sidebar/AgentForms.tsx:534-543` — runtime select +
  free-text OpenCode model input.
- `apps/api/convex/agents.ts:404` — `normalizeOpencodeModel` accepts
  `provider/model`; `apps/api/convex/schema.ts:310` — `executionRuntime` and
  `opencodeModel` on the agent row.
- `packages/worker/src/execution/nativeProvider.ts:176` — `buildOpencodeConfig`
  pins `-m <model>` when the agent has one; the CLI's own credentials are used.
- `packages/worker/src/execution/nativeProvider.ts:466` — `runNativeProvider`
  spawns the CLI through `defaultSpawn` with a scrubbed env
  (`buildChildEnv`), `cwd` = the task worktree.
- `packages/worker/src/index.ts:140` — the heartbeat; the worker talks to the
  backend only through `WorkerApi` (`packages/worker/src/workerApi.ts`).
- `apps/api/convex/worker.ts:81` — the token-gated action pattern
  (`workerToken` → `assertServiceToken` → `internal.*`).

## Decisions that must not change during execution

- The UI never spawns the CLI and never reads the OpenCode config: the worker
  reports the list through the token-gated backend path, the UI only reads a
  Convex query.
- The worker-facing surface stays token-gated (`assertServiceToken`), and the
  reported payload carries no credential material.
- `opencodeModel` semantics do not change: empty = Fhara's LLM, set =
  `provider/model` passed to the CLI as `-m` with OpenCode's own credentials.
- The approval gate, the sandbox and the terminal-task guard are untouched.
- The change is additive: a new table plus new functions; no field is dropped.

## Steps

### Step 1: schema + backend module

Add the `opencodeModelCatalog` table (`apps/api/convex/schema.ts`) and
`apps/api/convex/opencodeModels.ts`:

- `report` (internal mutation): the worker publishes its model list; upserts
  by `workerId`, clears a pending refresh request.
- `state` (internal query): the worker asks whether a refresh was requested
  and when it last reported.
- `list` (public query): the freshest catalog across workers, for the UI.
- `requestRefresh` (public mutation): the UI asks every worker to re-read.

**Check**: `npm run --workspace=@fhara/api codegen` (or
`npm run codegen:offline`) → the new table is in `_generated/dataModel.d.ts`.

### Step 2: token-gated worker actions

`apps/api/convex/worker.ts`: `reportOpencodeModels` (action) and
`getOpencodeModelState` (action), both `workerToken`-gated like the rest.

**Check**: `npm run --workspace=@fhara/api typecheck`.

### Step 3: worker reads the CLI

`packages/worker/src/execution/nativeProvider.ts`: `parseOpencodeModelList`
(pure) + `listOpencodeModels` (spawns `opencode models` with the scrubbed env,
a timeout, and no credential in argv). `packages/worker/src/workerApi.ts`:
the two new calls. `packages/worker/src/services/opencodeCatalog.ts`: the
poll loop (report on start, then when a refresh was requested or the list is
older than 10 min). `packages/worker/src/index.ts`: start the loop.

**Check**: `npm run --workspace=@fhara/worker typecheck` and
`npx --workspace=@fhara/worker vitest run tests/opencodeCatalog.test.ts`.

### Step 4: the dropdown

`apps/web/components/sidebar/AgentForms.tsx`: the free-text input becomes a
select (Fhara LLM default / catalog models grouped by provider / Custom…),
with the status line and the Refresh button.

**Check**: `npm run --workspace=@fhara/web typecheck`.

## Test plan

- The parser keeps only `provider/model` lines, de-duplicates them and caps
  the count (worker unit test).
- A failing spawn reports `available: false` with the error, never a crash
  (worker unit test).
- The refresh decision: a requested refresh, a missing catalog and a stale
  catalog each trigger a refresh; a fresh one does not (worker unit test).
- The backend: a report upserts per worker and clears the refresh request; a
  refresh request is visible to the worker state query; the public list
  returns the freshest catalog (backend `convex-test`).

## Completion criteria

- [x] The agent editor offers the models the CLI can run, without typing ids.
- [x] "Fhara LLM (default)" still maps to an empty `opencodeModel`.
- [x] A custom value that is not in the catalog is preserved and shown as
      "Custom…".
- [x] A missing CLI is reported in the UI instead of failing silently.
- [x] `npm run typecheck` passes and the worker + backend test files pass.
- [x] `npm run knip` reports no new unused file or export.

## Verification log

- `npm run typecheck` (web + api + worker): clean.
- `npm run --workspace=@fhara/api test`: 72 files / 752 tests pass, including
  `convex/opencodeModels.test.ts` (5).
- `npx --workspace=@fhara/worker vitest run tests/opencodeCatalog.test.ts`: 10
  pass. The rest of the worker suite has pre-existing environment failures on
  this machine (`mcpClientAndRegistry`, `mcpIntegrations` — they spawn MCP
  servers; `opencodeRuntime` — it needs a reachable provider).
- Live: `opencode models` on this machine returns 20 models; the worker →
  `worker.reportOpencodeModels` → `opencodeModels.list` path was exercised
  against the local Convex deployment, and the agent editor showed
  "20 models from smoke-check · updated just now" with the groups `9router`
  (5), `jerouter` (3), `opencode` (12).
- A running worker has to be restarted to pick up the new code: the dev
  supervisor (`scripts/supervise.mjs`) only restarts on exit.
- A refresh request that lands in the same millisecond as the last report is
  still served (`refreshRequestedAt >= updatedAt` in
  `services/opencodeCatalog.ts`).

## STOP conditions

- A non-negotiable rule in `AGENTS.md` must change.
- A schema change needs a destructive operation.
- A check fails twice after a reasonable fix.
- The change needs work outside this repository.
