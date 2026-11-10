# Plan 032: Global LLM selection mode (fallback vs round robin)

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

- Priority: P2
- Size: M
- Risk: LOW
- Dependencies: 031 (per-agent selection policy), 027 (capability routing)
- Planned at: commit `2670c03`, 2026-11-10

## Why this is needed

Plan 031 made the selection policy per agent. The user asked for one global
choice instead: "fallback or round robin", picked once for the whole app. A
per-agent dropdown spread one decision across every agent row and hid the
default behind "Pool default".

## Target behaviour

In **Settings → LLM & Models** there is one control, **Selection mode**:

| Option | Meaning |
| --- | --- |
| Fallback | Use one provider at a time (the pool's own order: priority, then weight among equals). A transient failure fails over to the next candidate. |
| Round robin | The starting provider rotates per resolution; the failover chain stays armed. |

The per-agent "Selection policy" dropdown is gone from the agent form. An
agent row that still carries an explicit `llmSelectionPolicy` keeps it (the
field is honoured, just not editable in the UI any more).

## Current state

- `apps/api/convex/schema.ts:300-307` — `agents.llmSelectionPolicy` union
  (`fixed` | `priority` | `weighted` | `round_robin`).
- `packages/worker/src/llm/resolver.ts:399` — `const policy = agent?.llmSelectionPolicy;`
- `packages/worker/src/llm/resolver.ts:464-474` — the pick: round robin /
  weighted / priority.
- `packages/worker/src/services/runner/setup.ts:52-68` — `buildTaskLlmResolver`.
- `packages/worker/src/services/taskRunner.ts:104`, `services/runner/resume.ts:131`
  — the resolver is built from the run context.
- `apps/api/convex/orchestration.ts:173-175, 231-252` — `getRunContext`
  returns the pool + capability overrides to the worker.
- `apps/web/components/LlmSettings.tsx:85-98` — the Settings LLM section.
- `apps/web/components/sidebar/AgentForms.tsx:528-535` — the per-agent
  dropdown (to be removed).

## Decisions that must not change during execution

- **The failover chain never disappears.** Round robin only changes the
  starting connection.
- **No new credential path.** The setting carries no key material; it crosses
  to the worker inside `getRunContext`, which `securityInvariants.test.ts`
  already guards.
- **The per-agent field stays honoured.** Removing it from the UI is not a
  schema removal: an agent that already has a policy keeps behaving as
  configured.
- **The default is "fallback".** That is the behaviour the app has always had
  (one provider at a time by the pool's order, failover chain armed), so the
  global default changes nothing for existing users. Only "round_robin"
  changes the pick.
- **Scope: the worker resolver path** (agents, planner, decision advisor). The
  backend's own chat/reviewer/improve calls resolve a single config without a
  failover chain; they keep their current behaviour and are out of scope.

## Steps

### Step 1: Shared mode contract

`apps/api/convex/lib/llmSelection.ts` (pure, no Convex import, so the worker
can use it): the mode union, the default, and `policyForMode`.

The Convex validator goes to `apps/api/convex/lib/contractValidators.ts`.

**Check**: `npm run --workspace=@fhara/api typecheck`.

### Step 2: Storage + backend API

- `apps/api/convex/schema.ts` — the `llmSelectionSettings` table (one row).
- `apps/api/convex/llmSelection.ts` — public `get` query, public `set`
  mutation, `loadSelectionMode(ctx)` helper.
- `apps/api/convex/orchestration.ts` — `getRunContext` returns
  `llmSelectionMode`.

**Check**: `npx --workspace=@fhara/api vitest run convex/llmSelection.test.ts`.

### Step 3: Worker honours the global mode

- `packages/worker/src/llm/resolver.ts` — `resolveForAgent` takes
  `globalMode`; the policy is the agent's own value, else
  `policyForMode(globalMode)`.
- `packages/worker/src/services/runner/setup.ts`,
  `services/taskRunner.ts`, `services/runner/resume.ts` — thread the mode
  from the run context.

**Check**: `npx --workspace=@fhara/worker vitest run tests/llmResolver.test.ts`.

### Step 4: UI

- `apps/web/components/LlmSettings.tsx` — the global picker.
- `apps/web/components/sidebar/AgentForms.tsx` — remove the per-agent
  dropdown.

**Check**: `npm run --workspace=@fhara/web typecheck` and `npm run
--workspace=@fhara/web build`.

## Test plan

- Backend: the mode defaults to "fallback"; `set` round robin is readable;
  `getRunContext` carries the mode.
- Worker: with no agent policy, the global "fallback" mode keeps the pool's
  own pick (weight among equals) and the failover chain; the global
  "round_robin" mode rotates; an agent with an explicit policy still wins over
  the global mode.
- Negative: an agent policy of "fixed" keeps its old meaning (no pool).

## Completion criteria

- [ ] One global picker in Settings → LLM & Models.
- [ ] The per-agent dropdown is gone.
- [ ] Both modes reach the worker and change the pick.
- [ ] Worker + backend + web typechecks pass; worker and backend suites green.

## STOP conditions

- A non-negotiable rule in `AGENTS.md` must change.
- The failover chain must be weakened.
- The run context would have to carry credential material.
- A check fails twice after a reasonable fix.
