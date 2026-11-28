# Plan 006: Runtime-aware capability discovery and Blocked outcome

## Status

- Priority: P1
- Size: L
- Risk: MEDIUM
- Dependencies: 001, 002, 004
- Planned at: commit `caf816104b`, 2026-11-27

## Why this is needed

Agents already execute through real runtime paths: `code_change` stages file
diffs through the approval pipeline, `shell` runs the exact-argv allowlist,
QA drives Chromium, and the acceptance/coverage stages gate `done`. What is
missing is a truthful answer to "can this agent do this job right now?".
Capabilities are declared strings resolved from a role row
(`utils/agentCapabilities.ts`), not from the runtime that will execute the
work. The UI shows declared tools, and `taskStatus` has no `blocked` value, so
a blocked run is reported as `failed` with a free-text reason or as a budget
halt (plan 004).

## Target behaviour

| Question | Current | Target |
| --- | --- | --- |
| Is a tool available? | declared `supportedTools` | available / unavailable / unknown, from the runtime probe |
| Can an agent write? | role permission | permission + workspace mounted |
| Can an agent run tests? | `shell` permission | permission + allowlisted binary present |
| Can QA drive a browser? | discover at QA time | probe Chromium once, report the state |
| Is the task blocked? | `failed` + reason | terminal `blocked` with a typed reason |
| Where is the reason? | task event / free text | task field + UI card |

## Current state

- `apps/api/functions/schema.ts:40-57` — `taskStatus` has no `blocked`;
  `schema.ts:82-91` — `subtaskStatus` does.
- `packages/worker/src/orchestrator/capabilities.ts:47-122` — routing filters
  writers and shell roles by enforced permissions (plan 040 + 2026-11-27),
  but has no runtime probe.
- `packages/worker/src/utils/agentCapabilities.ts` — declared capabilities,
  else the shared role registry (plan 002).
- `packages/worker/src/services/runner/acceptance.ts:120-131` — rejected
  subtasks become acceptance `blocked`, not a task status.
- `packages/worker/src/orchestrator/decision.ts:508-515` — every `BLOCKED`
  maps to `expectedOutcome:"policy:budget"` (plan 004 owns the split).
- `apps/api/functions/schema.ts:648-665` — workers already heartbeat a
  `capabilities` string list; `apps/web/components/settings/tabs.tsx:538`
  prints it.
- `apps/web/components/AgentDetailPanel.tsx:97-116` — capabilities/tools are
  the declared ones; no runtime state.
- `apps/web/components/runs/Contracts.tsx:37-46,113-118` — acceptance
  `blocked` and reason already render on `/runs`.

## Decisions that must not change during execution

- `done` stays reserved for verified work: acceptance + requirement coverage
  still gate it (`services/runner/terminal.ts`, `coverage.ts`).
- Terminal-status immutability (`orchestration.completeTask`) extends to any
  new `blocked` value; a late worker completion is still refused.
- Capability discovery never grants a permission: it only reports what the
  existing sandbox/argv/role checks already enforce.
- No new tracing sink; capability reports go to `taskEvents` /
  `lifecycleHistory`, the worker heartbeat, or an additive optional column.
- A discovery probe must be bounded (one cached probe per worker start or per
  task) and must never block the LLM pre-call budget gate.

## Steps

### Step 1: Pure discovery module — DONE 2026-11-27

Add `packages/worker/src/utils/capabilityDiscovery.ts` (pure): given an agent
and a probe `{ workspaceMounted, nativeRuntime, browser, knownTools }`,
return per-capability `available | unavailable | unknown` with a reason.
Map only capabilities the runtime actually binds (write, shell, browser,
web, read). Everything else is `unknown`.

**Check**: new `tests/capabilityDiscovery.test.ts` proves the three states and
that an unbound capability is never reported `available`. — 7 tests pass.

### Step 2: Wire the probe — REMAINING

Probe once per worker process: workspace path exists, browser executable
(`qa.ts`/`QA_CHROMIUM_PATH`), native CLI (`opencodeDetect.ts`). Cache the
result and pass it to discovery.

A per-task `agent.capability_report` event was tried and reverted: it breaks
the decision-engine golden event sequences and a timing-sensitive
`execPipeline` cancel test. A routing-time workspace filter was also tried and
reverted: a worktree that does not exist yet at `createRunContext` time is
reported unmounted, so writers were refused before the worktree was created.
Wire it on the worker heartbeat (cache per process) instead, or behind an
explicit policy flag with the goldens updated deliberately.

**Check**: `setup`/`planning` tests pass; no new per-call probe in the LLM
path; worker suite does not regress.

### Step 3: Typed Blocked outcome — DONE 2026-11-27

Added terminal `blocked` to `taskStatus` and optional `tasks.blockedReason`
(`schema.ts`), the backend terminal set (`orchestration.ts`), the worker
terminal check (`services/runner/terminal.ts`) and the chat-terminal list
(`lib/chat/startTask.ts`). `completeTask` stores the reason and emits
`task.blocked` at `warn`; incidents stay on `failed` only.

The runner ends `blocked` only when a subtask is blocked with the capability
routing reason (`No agent available for capability …`) and no subtask truly
failed (`services/runner/finalize.ts`); any execution/gate failure stays
`failed`. `securityInvariants.test.ts` pins the new terminal value.

**Check**: passed — the blocked task keeps its reason and refuses a late
`done`; budget exhaustion still uses `policy:budget`.

### Step 4: UI — PARTIAL (blocked badge DONE 2026-11-27)

Task thread shows a "Task blocked" banner with `blockedReason`; the task
status list, label, tone and retry affordance include `blocked`
(`apps/web/lib/taskStatus.ts`, `taskStatusTone.ts`, `TaskThreadPanel.tsx`).
The per-agent live capability state is still the declared one
(`AgentDetailPanel.tsx`), because step 2 has no probe to feed it.

**Check**: web typecheck and component render; the live agent state waits on
step 2.

## Test plan

1. Writer with write + allowlist shell → write/shell `available`.
2. Read-only role → write `unavailable`, shell `unavailable`.
3. No workspace → every filesystem capability `unavailable`.
4. No Chromium → `browser-testing` `unavailable`, never a fake pass.
5. Routing skips an unavailable agent and picks an available alternative.
6. No available agent → task `blocked` with the missing capability.
7. Evidence: blocked reason and capability report are stored on the task.
8. `done` still requires acceptance and requirement coverage.

## Completion criteria

- [ ] Capability report is derived from the runtime and matches what the
      executor allows.
- [ ] Terminal `blocked` exists with a typed reason and is immutable.
- [ ] UI shows the live state, not declared strings.
- [ ] Worker/API/web typechecks and focused suites pass.

## STOP conditions

- A non-negotiable rule in `AGENTS.md` must change beyond extending the
  terminal-status list.
- A check fails twice after a reasonable fix.
- A migration cannot be made additive and reversible.

## Live smoke (2026-11-27)

- A real DemoApp run classified "Tambahkan file docs/CAPABILITY_SMOKE.md.
  Jangan ubah file lain." as code_change, routed it, staged the file, and the
  approval gate applied it.
- The same prompt was first misclassified as research because
  `NO_CODE_NEGATION` matched the scoped clause "jangan ubah file lain"; fixed
  in `orchestrator/classifier.ts` (a scoped negation no longer cancels a change
  request).
- Blocking a real capability still fails live: with Frontend/Backend/DevOps
  disabled, the unroutable node is recorded blocked, then the replan turns it
  into a read-only "unblock-implementation" node, acceptance passes, and the
  task ends **Done** instead of Blocked. Root cause: requirements coverage
  maps the original requirement to the report node; no gate requires the
  promised file change. Owned by plan 004 / step 3 follow-up, not fixed yet.
