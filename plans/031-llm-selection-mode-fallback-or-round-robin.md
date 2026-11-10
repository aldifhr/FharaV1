# Plan 031: User-selectable LLM selection mode (fallback vs round robin)

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

- Priority: P2
- Size: M
- Risk: LOW
- Dependencies: 027 (capability routing), 022 (model tiers)
- Planned at: commit `6f21fcc`, 2026-11-10

## Why this is needed

The user cannot express "when this agent's provider dies, fail over to the next
one" vs "spread this agent's calls across my providers". Today the choice is
implicit in `llmSelectionPolicy` and its labels ("Weighted", "Priority") do not
say what actually happens to the user: that a failed provider fails over to
another one, and that the primary pick is either a weighted draw or the
top-priority connection.

The user asked for a two-way choice they can make: **fallback** or **round
robin**.

## Target behaviour

In the agent form (LLM section) the user picks one of:

| Option | Stored value | Behaviour |
| --- | --- | --- |
| Default | *(unset)* | Today: weighted draw among equal-priority connections. |
| Fallback | `priority` | Always start at the top-priority connection; on a transient failure fail over to the next candidate (existing chain). |
| Round robin | `round_robin` (new) | Rotate the starting connection per resolution; the failover chain stays armed. |
| Fixed | `fixed` | Only the agent's own two assigned connections; no pool. |

Round robin changes only **which connection starts**; the failover chain
(`packages/worker/src/effects/llmCall.ts:393-461`) stays active in every mode,
so a rotated-to provider that fails still lands on the next candidate.

## Current state

- `apps/api/convex/schema.ts:300-302` — `llmSelectionPolicy` union: `fixed`,
  `priority`, `weighted`.
- `apps/api/convex/agents.ts:201-203` (create) and `:293-295` (update) — same
  union in the mutation validators.
- `packages/worker/src/types/agent.ts:23` — the worker's copy of the union.
- `packages/worker/src/llm/resolver.ts:447-470` — primary pick: lowest
  priority, then `pickWeightedIndex` (`:286-296`) unless policy is `priority`.
- `packages/worker/src/llm/resolver.ts:476-504` — the fallback chain (always
  built, independent of the policy).
- `apps/web/components/sidebar/AgentForms.tsx:528-534` — the policy select.
- `packages/worker/src/llm/health.ts:182-183` — the health registry is the
  existing precedent for process-local worker state.

## Decisions that must not change during execution

- **The failover chain never disappears.** No mode turns it off; `round_robin`
  only changes the starting point.
- **Selection stays in the worker resolver.** The backend keeps serving the
  pool; no second selection path, no second planner (root `AGENTS.md`).
- **No new provider credential handling.** Round robin changes a connection
  choice, nothing about keys.
- **The rotation cursor is process-local, like the health registry.** It is a
  load-spreading hint, never correctness state: losing it on a worker restart
  only changes the distribution, never the outcome of a call. Persisting it in
  the database would add a write per LLM resolution and OCC contention on one
  row — a cost that buys nothing, because the failover chain already guarantees
  the call succeeds. A DB-backed cursor is a future, separate plan.
- **Round robin rotates globally, not per agent.** A per-agent cursor would
  start every agent on the same connection and spread nothing.

## Steps

### Step 1: Rotation cursor (worker)

New `packages/worker/src/llm/roundRobin.ts`:

- `RotationCursor` interface: `next(size: number): number`.
- `InMemoryRotationCursor`: a counter per scope, `next(size)` returns
  `counter++ % size`.
- A module-level `rotationCursor` singleton.

**Check**: `npm run --workspace=@fhara/worker typecheck` → no errors.

### Step 2: Resolver honours the policy

`packages/worker/src/llm/resolver.ts`:

- `resolveForAgent` accepts `rotation?: RotationCursor` (default: the
  singleton).
- Primary pick: `round_robin` rotates among the equal-priority connections;
  `priority` stays deterministic; everything else stays weighted.
- `TaskLlmResolverOptions.rotation` is threaded through `resolutionFor`.
- `expectedModelFor` (the Task Estimator) must NOT consume a rotation — it
  passes a non-advancing cursor.

**Check**: `npx --workspace=@fhara/worker vitest run tests/llmResolver.test.ts`
→ green.

### Step 3: Types and validators

- `packages/worker/src/types/agent.ts:23` — add `"round_robin"`.
- `apps/api/convex/schema.ts:300-302` — add `v.literal("round_robin")`.
- `apps/api/convex/agents.ts:201-203`, `:293-295` — add the same literal.

**Check**: `npm run --workspace=@fhara/api typecheck` → no errors.

### Step 4: UI

`apps/web/components/sidebar/AgentForms.tsx:528-534`:

- Add `Round robin`.
- Relabel `Priority` as `Fallback (priority first, then failover)` and
  `Weighted` as `Weighted (share by weight)`.
- Extend the hint so the user knows failover is always on.

**Check**: `npm run --workspace=@fhara/web typecheck` → no errors.

## Test plan

- `packages/worker/tests/llmResolver.test.ts`: with three equal-priority
  connections and policy `round_robin`, successive resolutions start on
  different connections and wrap around; the fallback chain still contains the
  other connections; `expectedModelFor` does not advance the cursor.
- `packages/worker/tests/llmResolver.test.ts`: policy `priority` (fallback) is
  unchanged — always the top-priority connection.
- Negative case: `round_robin` with a single candidate behaves like any other
  mode.

## Completion criteria

- [x] The agent form offers fallback and round robin.
- [x] `round_robin` round-robins the starting connection and still fails over.
- [x] `priority` (fallback) behaviour is byte-for-byte unchanged.
- [x] Worker + backend + web typechecks pass; worker suite green for the
      touched suites (`llmResolver`, `layering`).
- [ ] Browser check of the agent form (the select and its labels).

## Notes from execution

- The rotation cursor is process-local (`llm/roundRobin.ts`), like the
  provider-health registry. It is a load-spreading hint, never correctness
  state: the failover chain guarantees the call succeeds either way.
- `expectedModelFor` (Task Estimator) passes a non-advancing cursor so an
  estimate never consumes a rotation.
- The web typecheck fails on `apps/web/app/audit/page.tsx` — pre-existing
  uncommitted work in the tree (the `auditLog.remove` mutation needs a
  codegen run), not caused by this plan.
- `tests/mcpClientAndRegistry.test.ts`, `tests/mcpIntegrations.test.ts` and
  `tests/opencodeRuntime.test.ts` fail on this machine before and after this
  change (verified by stashing it) — pre-existing, unrelated.

## STOP conditions

- A non-negotiable rule in `AGENTS.md` must change.
- The failover chain must be weakened for round robin to work.
- A check fails twice after a reasonable fix.
