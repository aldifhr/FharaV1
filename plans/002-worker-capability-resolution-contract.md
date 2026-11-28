# Plan 002: Worker capability resolution contract

## Status

- Priority: P2
- Size: M
- Risk: MEDIUM
- Dependencies: 001
- Planned at: commit `caf816104b`, 2026-11-27

## Why this is needed

The worker still guesses capabilities from free-text role names with a regex
table while the backend has one live registry. The two disagree for legacy and
titled roles, so the same stored agent can be treated as a writer by chat and
as a non-writer by the executor, or routed to the wrong capability set.

## Target behaviour

- One resolver maps a stored role (key, title, retired alias) to a live
  `RoleKey`; both surfaces call it.
- Capabilities for a fixed role come only from `ROLES[key].registryCapabilities`.
- Non-role heuristics (security, github, shell) stay worker-only and explicit.
- No regex remains in the role/capability resolution path.

## Current state

- `packages/worker/src/utils/agentCapabilities.ts:14-67` — 12 `RegExp` role patterns; plan 086 fixed `support` → backend at `:48-50` but the table still duplicates the registry.
- `apps/api/functions/lib/roles.ts:301-305,374-390,422-426` — `rolePermissionsFor` uses `normalizeRoleKey` + `LEGACY_ROLE_SUCCESSORS`; `resolveRoleKey` uses titles and `ROLE_ALIASES`. Spaced aliases (`"Dev Ops"`, `"Team Lead"`) resolve in one and not the other.
- `packages/worker/src/utils/rolePolicy.ts:24-26` — uses `resolveRoleKey`, so it disagrees with `rolePermissionsFor`.
- `packages/worker/src/orchestrator/plannerAgent.ts:12,50-63` — a local CTO check and a hint resolver separate from the shared one; the null-role guard was fixed in this audit.
- `apps/web/lib/agentRoles.ts:28-30` — third copy of role-key matching.
- `packages/worker/src/utils/rolePolicy.ts:10-11` — stale "nine roles" comment corrected in this audit.

## Decisions that must not change during execution

- `lib/roles.ts` is the single source for role keys, capabilities and permissions.
- Custom roles keep tool-derived permissions (`rolePolicy.ts:26`).
- The worker must not call backend internals over HTTP; import the pure registry as today.

## Steps

### Step 1: Make one resolver cover titles, aliases and spaced names

Change `rolePermissionsFor`, `roleChatSummary` and `roleKeyForMention` to try
the raw lowercase and the normalized form through `resolveRoleKey`, then add
parity tests for `"Dev Ops"`, `"Team Lead"`, `"Backend Developer"`, `"UI/UX"`
and `"support"`.

**Check**: `roles.test.ts` passes with new cases; API typecheck passes.

### Step 2: Replace `ROLE_CAPABILITIES` with registry lookups

Resolve the role with the shared resolver, then read
`ROLES[key].registryCapabilities`. Keep only the worker-only non-role patterns
as an explicit fallback list.

**Check**: `packages/worker/tests/capabilities.test.ts` passes; no `RegExp`
remains in `utils/agentCapabilities.ts`.

### Step 3: Use the same resolver in the planner and the web

Replace the local `isCtoRole` and hint-role matching in `plannerAgent.ts` with
the shared resolver; make `apps/web/lib/agentRoles.ts` delegate to the shared
one. Keep the existing fallback chain order.

**Check**: worker `architectureGate.test.ts`, `planningHint.test.ts` and web
typecheck pass.

## Test plan

- Same stored role string resolves identically in backend, worker and web.
- Legacy `support` gets backend capabilities, never CTO capabilities.
- An unknown custom role never matches another unknown role by `null === null`.
- A retired alias keeps its documented successor.

## Completion criteria

- [x] One role resolver is used by all three surfaces.
- [x] No regex in `agentCapabilities.ts` or the planner role path.
- [x] API/worker/web typechecks and focused suites pass.

## Outcome (2026-11-27)

- `rolePermissionsFor`, `roleChatSummary`, `roleKeyForMention` now delegate to
  `resolveRoleKey` (`apps/api/functions/lib/roles.ts`), so "Dev Ops", "Team
  Lead" and titles resolve identically in chat and the executor.
- `utils/agentCapabilities.ts` has no `RegExp`: fixed roles read
  `ROLES[key].registryCapabilities`; only non-role agents keep explicit
  worker-only token heuristics (security, github, shell).
- `packages/worker/tests/agentCapabilities.test.ts` pins key/title/spaced
  parity and whole-token heuristics; `rolePermissions.test.ts`,
  `capabilities.test.ts` and `roles.test.ts` still pass.
- `routeCapability` now also refuses a capability whose enforced permissions
  do not allow it: `shell-execution` needs an `allowlist` shell role,
  `test-run`/`build-verify` accept `verify`, so a read-only agent cannot own
  terminal work just by declaring it.
- Chat auto-task owner selection checks the handoff role: write work requires
  a code-writing role, a run request a shell-capable one (`chat.ts`).

## STOP conditions

- A non-negotiable rule in `AGENTS.md` must change.
- A check fails twice after a reasonable fix.
- A schema change is required.
