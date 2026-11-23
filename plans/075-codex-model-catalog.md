# Plan 075: List Codex account models in LLM & Models

## Status

- State: DONE (2026-11-23)
- Priority: P2
- Size: M
- Risk: MEDIUM
- Dependencies: 057, 066
- Planned at: 2026-11-23

## Why this is needed

The Codex native CLI connection in `apps/web/components/LlmSettings.tsx` currently
offers only static suggestions from `apps/web/lib/cliProviders.ts`. Those may
not match the models available to the user's signed-in Codex account.

## Target behaviour

LLM & Models shows model ids returned by the signed-in Codex CLI, supports a
manual refresh, and retains preset suggestions if the worker has not reported a
usable catalog. Credentials stay on the worker machine.

## Current state

- `apps/web/lib/cliProviders.ts:20` defines static Codex and Claude suggestions.
- `apps/web/components/LlmSettings.tsx:349` reads the OpenCode catalog; Codex
  currently falls back to static suggestions near line 669.
- `packages/worker/src/services/opencodeCatalog.ts:109` polls a CLI catalog and
  reports it to the backend; `packages/worker/src/index.ts:407` schedules it.
- `apps/api/functions/schema.ts:2164` stores the OpenCode catalog separately.
- `apps/api/functions/worker.ts:163` exposes token-gated catalog reporting.

## Decisions that must not change during execution

- Read Codex's local `model/list` app-server endpoint; do not query an HTTP
  `/models` endpoint or send Codex credentials to the backend.
- Keep the Codex catalog separate from OpenCode's catalog.
- Preserve free-typed model ids and existing approval/security gates.

## Steps

### Step 1: Read and publish the local Codex catalog

Use app-server JSON-RPC `model/list`, persist only model ids and refresh state,
and expose a token-gated worker bridge plus a public settings query/mutation.

**Check**: focused backend test verifies report, list, and refresh behavior.

### Step 2: Surface the catalog in LLM & Models

Use the reported catalog for Codex suggestions and provide a refresh action;
retain presets while no usable catalog is available.

**Check**: web typecheck and focused model-list tests.

### Step 3: Verify

Add worker tests for parsing and catalog refresh/poll behavior.

**Check**: worker typecheck and focused catalog tests.

## Test plan

- Drop malformed/hidden entries and de-duplicate ids.
- A refresh request is served on the worker's next poll.
- Reported ids contain no credential fields or app-server metadata.
- When the worker has not reported, presets remain available.

## Completion criteria

- [x] Codex models are read through the local signed-in CLI session.
- [x] Worker reporting is token-gated and stores model ids only.
- [x] LLM & Models uses the live list and allows refresh.
- [x] Focused backend, worker, and web checks pass.

## STOP conditions

- Listing requires transmitting the Codex credential outside the worker.
- A destructive schema migration is required.
