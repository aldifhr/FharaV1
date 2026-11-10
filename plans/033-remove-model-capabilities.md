# Plan 033: Remove the model capability registry and capability routing

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

- Priority: P2
- Size: L
- Risk: MEDIUM
- Dependencies: 027 (the feature this removes), 031, 032
- Planned at: commit `2670c03`, 2026-11-10

## Why this is needed

The user asked to delete the "Model capabilities" section in Settings → LLM &
Models. That section is the whole plan 027 feature: the capability registry
(overrides + probes + built-in heuristics) and the router that picks the
first model satisfying a call site's needs. Leaving the backend of it behind
would keep a hidden feature nobody can configure.

## Target behaviour

- Settings → LLM & Models has no "Model capabilities" section.
- The resolver picks a model by the pool's own order (priority, then weight
  among equals, `modelPatterns`, circuit breaker) — no needs filtering.
- `subtask.routed` still records the chosen model, connection and reason.
- Performance routing keeps availability, score and budget fit; it loses the
  "model fit" criterion (it was computed from the capability registry).

## Current state

Backend:
- `apps/api/convex/modelCapabilities.ts` — list/probe/upsert/clear overrides.
- `apps/api/convex/lib/modelCapabilities.ts` — the pure resolution order
  (project override → override → probe → registry → built-in → unknown) and
  `CALL_SITE_NEEDS`.
- `apps/api/convex/lib/capabilityValidators.ts` — the schema validators.
- `apps/api/convex/schema.ts:1047` — the `modelCapabilityOverrides` table.
- `apps/api/convex/orchestration.ts:177,236,261` — the overrides cross to the
  worker in the run context.
- `apps/api/convex/projects.ts:242` — cascade delete on project removal.
- `apps/api/convex/lib/routing.ts:88-89,227-236,263-264` — the Routing
  Inspector's model view (`satisfied` / `fallback` are capability fields).

Web:
- `apps/web/components/ModelCapabilitiesSection.tsx` — the section.
- `apps/web/components/LlmSettings.tsx:9,775` — renders it.
- `apps/web/components/runs/RoutingInspector.tsx:45,63` — the "Model fit"
  column (performance routing's capability-derived factor).

Worker:
- `packages/worker/src/llm/resolver.ts` — `CapabilityLookup`,
  `capabilityLookupFrom`, `capabilityRoutingEnabled`, the needs filtering,
  `ModelRoutingInfo.needs/satisfied/fallback/missing/skipped`.
- `packages/worker/src/orchestrator/planner.ts:132`,
  `orchestrator/decisionLlm.ts:108`, `services/runner/runContext.ts:59-65` —
  `CALL_SITE_NEEDS` per call site.
- `packages/worker/src/services/runner/setup.ts:75-100` — the capability
  fallback logger.
- `packages/worker/src/services/taskRunner.ts:106`,
  `services/runner/resume.ts:133` — the overrides are passed in.
- `packages/worker/src/services/runner/runNodes.ts:504-553` — the routed
  payload with the capability fields.
- `packages/worker/src/orchestrator/performanceRouting.ts:40,59,93,133-138` —
  the model-fit criterion.
- `packages/worker/tests/modelCapabilities.test.ts` — the feature's suite.

## Decisions that must not change during execution

- **The model registry stays.** `llmModels` (prices, context window, the
  `supportsTools` / `supportsReasoning` flags) is used by the estimator and
  the registry form; only the capability *override* table goes.
- **The provider selection stays.** Priority → weight → `modelPatterns` →
  circuit breaker → failover chain (plans 031/032) is untouched.
- **No silent behaviour change in routing:** the executor's model is still
  resolved and recorded on `subtask.routed`, only the needs filter is gone.
- **Old rows stay.** The `modelCapabilityOverrides` table is dropped from the
  schema (it has no reader any more); the stored overrides are lost with it,
  which is the point of the removal.

## Steps

### Step 1: Web — remove the section

Delete `apps/web/components/ModelCapabilitiesSection.tsx`; drop the import
and the usage from `apps/web/components/LlmSettings.tsx`.

**Check**: `npm run --workspace=@fhara/web typecheck`.

### Step 2: Backend — remove the registry

Delete `modelCapabilities.ts`, `modelCapabilities.test.ts`,
`lib/modelCapabilities.ts`, `lib/capabilityValidators.ts`; drop the table
from `schema.ts`; drop the overrides from the run context and from the
project cascade.

**Check**: `npm run --workspace=@fhara/api typecheck` and
`npx --workspace=@fhara/api vitest run convex/securityInvariants.test.ts`.

### Step 3: Worker — remove the needs routing

- `llm/resolver.ts`: drop the capability lookup, the needs filter, the
  `MODEL_CAPABILITY_ROUTING` switch and the capability fields of
  `ModelRoutingInfo`.
- `orchestrator/planner.ts`, `orchestrator/decisionLlm.ts`,
  `services/runner/runContext.ts`: drop `CALL_SITE_NEEDS`.
- `services/runner/setup.ts`, `services/taskRunner.ts`,
  `services/runner/resume.ts`: drop the capability fallback logger.
- `services/runner/runNodes.ts`: the routed payload keeps model, connection
  and reason.
- `orchestrator/performanceRouting.ts` + its test: drop the model-fit
  criterion.

**Check**: `npm run --workspace=@fhara/worker typecheck` and
`npx --workspace=@fhara/worker vitest run tests/llmResolver.test.ts`.

### Step 4: Routing view + UI

- `apps/api/convex/lib/routing.ts`: the model view keeps model, connection
  and reason.
- `apps/web/components/runs/RoutingInspector.tsx`: drop the "Model fit"
  column.

**Check**: `npm run --workspace=@fhara/api test` and
`npm run --workspace=@fhara/web build`.

## Test plan

- Worker: the resolver still honours priority, weight, `modelPatterns`, the
  circuit breaker and the failover chain (existing `llmResolver` cases).
- Worker: performance routing still ranks by availability → score → budget
  fit (existing `performanceRouting` cases, minus the model-fit one).
- Backend: `getRunContext` no longer carries the overrides, and it still
  carries no credential material (`securityInvariants.test.ts`).
- Negative: nothing may reference the removed modules (knip).

## Completion criteria

- [x] No "Model capabilities" section in Settings.
- [x] No capability table, module or worker routing path left.
- [x] Worker, backend and web typechecks pass; worker + backend suites green.
- [x] `npm run knip` reports no new unused files or exports.
- [ ] Browser check of Settings → LLM & Models (the section is gone, the
      rest of the LLM tab still works).

## Notes from execution

- The `modelCapabilityOverrides` table was dropped from the schema, so the
  stored overrides are gone (nothing read them any more).
- Performance routing lost its "model fit" criterion (it was computed from
  the capability registry); availability → score → budget fit remain, and
  the Routing Inspector's factor table lost the "Model fit" column.
- The manual probe action and the `probeModel` op on `/api/llm-providers`
  are gone with the feature.

## STOP conditions

- A non-negotiable rule in `AGENTS.md` must change.
- The provider selection (plans 031/032) would change behaviour.
- A check fails twice after a reasonable fix.
