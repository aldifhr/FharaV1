# Plan 035: Global OpenCode runtime, per-agent Fhara LLM

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

- Priority: P2
- Size: M
- Risk: MEDIUM
- Dependencies: 014 (provider-native runtime), 032 (global LLM selection mode), 034 (OpenCode model catalog)
- Planned at: commit `4be16d4`, 2026-11-10

## Why this is needed

The LLM model flow reads as two unrelated pickers. The agent form carries a
"Runtime" block (`executionRuntime` + `opencodeModel`) and an "LLM" block
(provider / model / fallback). Nothing says which LLM a model refers to, and
the OpenCode runtime is per agent although it is a machine-level choice: the
CLI, its credentials and its model list belong to the worker, not to a role.

The target: one OpenCode switch for the whole app (Settings → LLM & Models),
and the per-agent picker stays where it belongs - the Fhara LLM this agent
uses.

## Target behaviour

- Settings → LLM & Models has an "OpenCode" section: the runtime (Built-in /
  OpenCode CLI) and the OpenCode model (the catalog dropdown from plan 034).
  It applies to every agent.
- The agent form has no runtime block. Its LLM block (Provider / Model /
  Fallback) stays and says it is the Fhara model for that agent.
- The team page and the agent detail panel show the app-wide runtime, not a
  per-agent one.
- A template no longer carries a runtime/model into a new agent.

## Current state

- `apps/web/components/sidebar/AgentForms.tsx:531-546` - the agent form's
  Runtime block (execution runtime select + OpenCode model field).
- `apps/api/convex/schema.ts:310-312` - `agents.executionRuntime` and
  `agents.opencodeModel` (per agent).
- `apps/api/convex/llmSelection.ts` - the pattern of an app-wide setting
  (one row, public get/set, read by the run context).
- `apps/api/convex/orchestration.ts:175-178` - `llmSelectionMode` in the run
  context.
- `packages/worker/src/services/runner/runNodes.ts:193-195` - the runtime and
  the native model are derived per agent.
- `packages/worker/src/orchestrator/policy.ts:324-327` - the env fallback
  (`ORCHESTRATOR_EXECUTION_RUNTIME`).
- `apps/web/components/LlmSettings.tsx:384-424` - the Selection mode section
  the OpenCode section joins.
- `apps/web/app/team/page.tsx:39-46`, `apps/web/components/AgentDetailPanel.tsx:212-220` -
  the per-agent runtime in the UI.

## Decisions that must not change during execution

- The OpenCode CLI still runs with its own credentials and the worker still
  gates every change; nothing here touches the approval gate or the sandbox.
- The per-agent columns stay in the schema and stay readable. They become
  legacy: the UI stops writing them, and they are read only when no app-wide
  setting exists (a deployment that never opened the setting keeps its
  current behaviour).
- The app-wide setting wins over the legacy per-agent value, so there is one
  place that decides.
- `provider/model` validation is the same rule the agent field uses.
- The worker keeps reading the env as the last fallback
  (`ORCHESTRATOR_EXECUTION_RUNTIME`).

## Steps

### Step 1: backend setting + run context

`opencodeSettings` table (one row: runtime, model, updatedAt),
`apps/api/convex/opencodeSettings.ts` (public `get`, public `set`,
`loadOpencodeSettings`), and `getRunContext` gains `opencodeRuntime` and
`opencodeModel` (both present only when a row exists).

**Check**: `npm run --workspace=@fhara/api typecheck`.

### Step 2: the worker honours the global

`RunnerDeps` carries the two values from the run context; `runNodes` picks
the global runtime first, then the legacy agent value, then the env default;
the native model follows the same order.

**Check**: `npm run --workspace=@fhara/worker typecheck` and the new worker
test file.

### Step 3: the UI

Settings → LLM & Models: the OpenCode section. Agent form: the Runtime block
is removed, the LLM block is relabelled. Team page and detail panel: the
app-wide runtime. Templates: no runtime/model on a new agent.

**Check**: `npm run --workspace=@fhara/web typecheck` and the browser.

## Test plan

- The setting is stored, read back, and an invalid model id is refused
  (backend `convex-test`).
- The run context carries the setting only when a row exists.
- The worker precedence: the global wins, the legacy agent value is the
  fallback, the env is the last fallback (worker unit test).

## Completion criteria

- [x] One place decides the OpenCode runtime: Settings.
- [x] The agent form still picks the Fhara model per agent.
- [x] The team page and the detail panel show the app-wide runtime.
- [x] A deployment without the setting keeps its current behaviour.
- [x] `npm run typecheck` passes, the new test files pass, `npm run knip`
      reports nothing new.

## Verification log

- `npm run typecheck` (web + api + worker): clean.
- `npm run --workspace=@fhara/api test`: 73 files / 756 tests pass, including
  `convex/opencodeSettings.test.ts` (4). `convex/agentTemplates.test.ts` now
  asserts the new contract (a template keeps its runtime/model as legacy
  data; a new agent does not inherit them).
- Worker: `tests/opencodeRuntime.test.ts` gained 3 cases for the precedence
  (the global wins; the legacy per-agent value applies only without a
  setting; the env default is last). The 3 failures in that file and the 16
  in the MCP suites are pre-existing on this machine (they need a reachable
  provider / a spawnable MCP server).
- `npm run knip`: no new unused file or export.
- Live: Settings → LLM & Models shows the "OpenCode runtime" section (runtime
  select + the catalog dropdown from plan 034); the agent form's Advanced
  block is now "Fhara model" only; the team cards show the app-wide runtime.
- A running worker has to be restarted to pick up the run-context wiring
  (`scripts/supervise.mjs` only restarts on exit).

## STOP conditions

- A non-negotiable rule in `AGENTS.md` must change.
- A schema change needs a destructive operation.
- A check fails twice after a reasonable fix.
- The change needs work outside this repository.
