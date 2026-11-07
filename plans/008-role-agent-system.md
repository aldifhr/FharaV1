# Plan 008: Role & Agent System

> Instructions for the implementer: run each step, run the check, confirm the expected result. On a STOP condition, stop and report. Do not guess. When done, set this plan's state in `plans/README.md`.

## Status

- Priority: P1
- Size: M
- Risk: MEDIUM
- Dependencies: 005 (done), 006 (done), 007 (done)
- Planned at: 2026-11-08, worktree main

## Why this is needed

MOAgent currently treats `agents.role` as free text + `capabilities` as CSV. There is no structured Role Registry: CTO vs specialist, Developer/QA/Reviewer/Researcher/Writer, and tool permissions are inferred ad hoc. Selection is keyword-driven (`classifyCommand` regex + `routeCapability`), so agent proliferation and unnecessary LLM calls are not controlled by policy.

## Assessment of current architecture

**What exists:**
- `apps/api/convex/schema.ts:77 agents` (name/role/systemPrompt/capabilities/supportedTools/isEnabled) — de facto registry.
- `conversations.ts:30 selectDefaultChatAgents` + registry read models (`agents.listByProject`, `getRegistryView`) — participation is persisted, not rebuilt per request. Plans 006/007 done.
- `packages/worker/src/orchestrator/types.ts:1 CAPABILITY` (11 values), `capabilities.ts:46 capabilityForRole`, `:85 routeCapability`, `classifyCommand` regex.
- `orchestrator.ts:338 createAuthoritativePlan` — one planning authority. `decision.ts validateDecision/decide/applyDecision/evaluateObjective`.
- `governance/registry.ts tool_search/describe/call` + `supportedTools` scope. Shared global LLM via provider pool (no per-agent key mandatory).

**Gaps vs spec:**
- Role vocabulary is ad hoc (`frontend/backend/qa/cto/security/researcher/general`) — no `developer`, `reviewer`, `technical-writer`, `devops`, `database`, `ui-ux`, `product-analyst`.
- No centralized `RoleRegistry` (role → capabilities, toolPermissions, instructions) shared by UI + worker.
- `classifyCommand` is keyword-only: task objective/complexity/files/deps/expected deliverables do not feed selection beyond `suggestedCapabilities`.
- Tool defaults (table in spec §7) live only as prompt hints, not as registry defaults enforced by `tool_call`.
- CTO vs Architect duplicate: prompt says `(architect)`, role list says `cto`, capability is `architecture`. Legacy `architect` in regex is backward compat only.
- Structured `AgentResult` exists (`taskContext.ts:22` status/summary/findings/delegationRecommendation/meta) but not enforced as execution contract.

**Compatibility risks:**
- Renaming capability keys (`architecture` → something else) breaks persisted plans/agents rows. Keep `ARCHITECTURE: "architecture"` key; only expose new display names.
- Removing legacy `"architect"` role breaks DB rows with `role: "architect"` (e.g. Troy in test-app). Keep regex alias.

## Role hierarchy (target)

- **Leadership:** `cto` (mandatory, `ORCHESTRATOR_AUTHORITATIVE`, owns lifecycle, only actor who marks task done).
- **Core:** `developer` (code_change/shell), `qa` (browser-testing), `reviewer` (code-review), `researcher` (research), `technical-writer` (documentation — read-only, no logic).
- **Specialist (optional, on-demand):** `architect` (design, maps to `architecture` capability — **not** a second orchestrator), `devops`, `security` (`security-audit`), `database` (`backend-development` + schema), `ui-ux`, `product-analyst`.

No role is a permanent worker: roles are **config** (capabilities + systemPrompt + tool defaults) executed by `agentExecutor` when the Orchestrator routes to them.

## Agent Registry design

- Backend `agents` table = persisted registry (no new table; hard-coding a second registry would duplicate).
- Worker mirror: `packages/worker/src/orchestrator/roles.ts` — `ROLE_DEFINITIONS: Record<Role, {description, defaultCapabilities, defaultTools, systemPromptHint}>` + `roleForAgent(agent)`, `defaultToolsForRole(role)`, `canSelect(role, caps)`.
- UI `components/Sidebar.tsx AGENT_ROLES` derived conceptually from the same vocabulary (keeping existing backend values normalized lower-case).

## Capability-based selection

Extend `routePrimaryAgent` scoring (keep keyword path as signal, not sole mechanism):
`score = objectiveMatch + capsOverlap + complexity(→ qa/review) + filesHint + deps + deliverables(→ qa) + verification(→ qa/review) + tools + budgetHardCap`.
Selection still filtered by `capabilitiesOf(agent)` and `allowFallback:false`; disabled agents never selected.

## Role-specific execution contracts

- `AgentResult` is the structured contract: `status + summary + filesModified + toolsExecuted + evidence + findings + errors + remainingWork + recommendations`.
- New helper `packages/worker/src/execution/resultContract.ts` `toStructuredResult(agentResult, meta)` + `formatForPrompt` — orchestrator evaluation gates on `evaluateObjective` before `complete` (existing rule: agent cannot self-complete).

## Shared LLM

No change: provider pool (`llmProviders` + `llmModels`) resolves globally; sequential + parallel scheduling via `maxConcurrentLLMCalls`; budget gate pre-call.

## Tool permission mapping

`roles.ts TOOL_DEFAULTS`:
| Tool | Developer | QA | Reviewer | Researcher | Writer |
|---|---|---|---|---|---|
| read filesystem | Yes | Yes | Yes | Yes | Yes |
| write filesystem | Yes | Restricted | No | No | No (docs only) |
| run tests | Yes | Yes | No | No | No |
| shell | policy | policy | Restricted | Restricted | No |
| web research | Opt | Opt | Opt | Yes | Opt |
| github | policy | policy | RO | RO | — |

Enforced by `governance/tools.validateFilePath / validateCommand` + `registry.tool_call` supportedTools scope (final decision stays in Policy Engine).

## Steps

### Step 1: Roles module

Create `orchestrator/roles.ts`: `AgentRole` union, `ROLE_DEFINITIONS`, `TOOL_DEFAULTS`, `roleForAgent()`, `normalizeRole()`. No DB migration.

**Check**: `npm run --workspace=@moagent/worker typecheck` → no new errors. Worker tests for `roleForAgent/normalizeRole/defaultTools`.

### Step 2: Selection scoring

Extend `capabilities.ts routePrimaryAgent` (or wrapper in `roles.ts selectAgentsForTask`) with the 8-factor score. Keep `routeCapability` as primitive. Default `chatMaxAgents=1` unchanged.

**Check**: `tests/roles.test.ts` (17 tests mirroring spec table + edge cases).

### Step 3: UI + docs

- `Sidebar.tsx AGENT_ROLES` → `[cto, developer, qa, reviewer, researcher, technical-writer, architect, devops, security, database, ui-ux, product-analyst, frontend, backend, general]` (frontend/backend kept as aliases to developer families).
- `chat.ts` planning guidance: orchestrator never blindly activates all agents; simple tasks direct.
- `packages/worker/AGENTS.md` + `apps/api/convex/AGENTS.md` updated.

**Check**: `npm run --workspace=@moagent/web typecheck` → ChatPanel/Sidebar clean.

### Step 4: Structured result contract

Add `execution/resultContract.ts` + wire `agentExecutor.toAgentResult` to emit `filesModified/toolsExecuted/evidence/remainingWork`. Orchestrator keeps `evaluateObjective` gate (no agent self-complete). Tests for contract shape + negative cases (missing evidence → not satisfied).

**Check**: worker tests for `toStructuredResult`.

### Step 5: Factories

Add scripts to seed default agents: `apps/api/convex/agents.seed.ts` internal action? Optional — if existing DB lacks roles, provide `scripts/seed-default-roles.mjs` to create CTO+5 core when project is created empty. No DB migration.

**Check**: web build/typecheck.

## Test plan

Unit/integration, mocked executors (no live provider, no Playwright):

| # | Invariant | Test file |
|---|---|---|
| 1 | Orchestrator handles simple task with 1 node `direct` | `roles.test.ts` |
| 2 | Developer activates only when `code_change` suggested | `roles.test.ts` |
| 3 | QA activates when verification required / risk signal | `roles.test.ts` |
| 4 | Reviewer independent review (findings w/o exec) | `roles.test.ts` |
| 5 | Researcher research w/o write | `roles.test.ts` |
| 6 | Specialist activates only when capability required | `roles.test.ts` |
| 7 | Disabled agents cannot be selected | `roles.test.ts` |
| 8 | Capability matching (exact > substring > token, tie by priority/name) | existing `capabilities.test.ts` + `roles.test.ts` |
| 9 | Shared global LLM (one connection, many agents, no ciphertext in prompts) | existing `llmResolver.test.ts` J |
| 10 | Role permissions enforced (write denied, shell restricted) | `toolRegistry.test.ts` + `roles.test.ts` |
| 11 | Agents cannot bypass governance (audit + redaction) | `toolRegistry.test.ts` |
| 12 | Structured result shape | `validation-unit.test.ts` + contract test |
| 13 | Orchestrator reassigns after failure | `taskRunner.replan.test.ts` F (existing) |
| 14 | Sequential execution with one LLM slot | `phase4Runner.test.ts` (maxConcurrency=1) |
| 15 | Parallel respects dependencies/concurrency | `dagScheduler.test.ts` |
| 16 | Cancellation/timeout via `AbortController.signal` into LLM/QA/command | `phase4Hardening*.test.ts` |
| 17 | Task never marked done on agent response alone | `decision.test.ts evaluateObjective` |

Negative cases: unknown capability, file-write by Researcher → denied, shell agent self-delegate → refused, disabled agent → `null`.

## Completion criteria

- [ ] `npm test` worker green (no new typecheck vs 57 baseline)
- [ ] `npm run --workspace=@moagent/api test` green
- [ ] `npm run --workspace=@moagent/web typecheck` clean (excluding pre-existing concurrent mcp errors if untouched)
- [ ] `npm run knip` no new finding
- [ ] Roles test file passes 17 tests
- [ ] `AGENTS.md` surfaces updated

## STOP conditions

- A schema change requires destructive migration (field drop in same change as stop writing).
- Approval gate / sandbox / budget defaults must change.
- Adding a role requires a second Orchestrator/Planner.
- Existing Phase 3–6 tests regress for reasons other than a flaky new test.
