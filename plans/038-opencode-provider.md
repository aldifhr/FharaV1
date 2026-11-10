# Plan 038: OpenCode as a provider, with detection

## Status

- Priority: P2
- Size: M
- Risk: MEDIUM
- Dependencies: 034 (OpenCode model catalog), 035 (global OpenCode runtime), 037 (one model order)
- Planned at: commit `c44c079`, 2026-11-10

## Why this is needed

"Opencode juga dijadikan Provider dan mendeteksi apakah ada Opencode". The
OpenCode runtime lived in its own Settings section (plan 035), separate
from the model order, and nothing said whether the CLI was installed. A
sandbox run also executed OpenCode in the user's real repo (no worktree
isolation).

## Target behaviour

1. **Detection** (worker, `execution/opencodeDetect.ts`): at startup and when
   the catalog report is older than 5 min (`CATALOG_STALE_MS`), or on "Check
   again": the configured command (`ORCHESTRATOR_NATIVE_PROVIDER_COMMAND`,
   default `opencode`) is found on PATH (PATHEXT on Windows, so
   `opencode.cmd`; `where` as last resort), then `opencode --version` with a
   5 s timeout. Reported with the catalog (`opencodeModelCatalog.installed /
   version / path`, `error`, `updatedAt`).
2. **OpenCode row in Providers**: a special `llmProviders` row
   (`provider: "opencode"`, no URL, no key; `opencodeProvider.setEnabled`,
   token-gated through `/api/llm-providers` op `setOpencodeEnabled`). Shows
   Detected v<x> at <path> / Not installed + `npm i -g opencode-ai` (README;
   the 1.x CLI this integration targets) / Worker offline; Enabled; Test
   (`opencodeModels.requestTest` → the worker runs a one-word `opencode run`
   in a temp dir → `worker.reportOpencodeTest`); Check again
   (`opencodeModels.requestRefresh`). The plan 035 section is removed.
3. **OpenCode models in the one list** (`llmModels`, `provider/model` ids
   validated): for subtasks, the first entry of the agent's chain decides
   the runtime (`TaskLlmResolver.executionRouteFor`): OpenCode → native with
   that model, API → API with the HTTP rest as failover. Unavailable
   OpenCode entries are skipped (event `opencode.skipped`). Chat and every
   backend call never see the row (`loadProviderPool` leaves it out unless
   `includeOpencode`, which only the run context sets; `orderedChatPairs`
   filters too). Per-agent overrides work: an agent assigned to OpenCode runs
   its subtasks natively and chats on the global API order.
4. **Isolation guard** (`opencodeGateFor`): OpenCode (list entries and the
   legacy switch) is refused without `ORCHESTRATOR_WORKTREE_ISOLATION`,
   unless `ORCHESTRATOR_OPENCODE_ALLOW_UNISOLATED=1`. The subtask falls to
   the next entry / the built-in runtime and the event log says why.

## Backward compatibility

- No OpenCode row: `opencodeSettings` (plan 035) and the env default keep
  deciding, now behind the isolation guard.
- First enable: a plan 035 "OpenCode CLI + model" setting becomes the first
  list entry. An "OpenCode CLI + Fhara LLM (empty model)" setting is not
  carried over (a list entry needs a model id).
- Row exists: the run context sends `opencodeRuntime: "api"` (neutral
  baseline, so legacy per-agent / env values cannot take over again);
  `opencodeSettings.get` returns `viaModelList: true` for the team page and
  agent panel.

## Schema (additive)

`opencodeModelCatalog`: `installed`, `version`, `path`, `testRequestedAt`,
`testModel`, `testResult` (all optional). No migration.

## Env

- `ORCHESTRATOR_OPENCODE_ALLOW_UNISOLATED` (new, default off).
- `WORKER_OPENCODE_CATALOG_POLL_MS` default 30 s → 15 s (Test latency).

## Not covered

- A native OpenCode run that fails does not fail over to the next entry
  (it may already have staged changes); only availability skips.
- The Settings UI cannot see the worker's isolation setting; it says so in
  a hint, and the event log names the skip.

## Verification log

- web / api / worker typecheck clean.
- `convex/opencodeProvider.test.ts` (10), the whole api suite 80 files / 835.
- `tests/opencodeProvider.test.ts` (31, incl. 2 live against the sandbox CLI
  1.19.5: detection + `opencode/minimax-m3.1-flash-free` probe ok, ~4.3 s);
  the whole worker suite passes.
- `apps/web` unit tests 35 pass.
- Browser check of Settings: pending.
