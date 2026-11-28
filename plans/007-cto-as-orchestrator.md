# Plan 007: CTO as the single planning authority

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess.
> **Design phase only**: the developer confirmed the architecture change but
> explicitly required a conflict audit before any implementation. Do not edit
> source files until the conflict resolution decisions below are confirmed.

## Status

- Priority: P0 (developer decision, 2026-11-28)
- Size: L
- Risk: HIGH
- Dependencies: 001, 003, 006
- Planned at: commit `2fd2247176`, 2026-11-28
- State: IN PROGRESS — design and conflict audit only; no code changed

## Developer confirmation (recorded 2026-11-28)

The developer approved the direction **"CTO becomes the Orchestrator"** with
these exact boundaries:

| Component | Responsibility |
| --- | --- |
| CTO | Primary brain: intent, planning, role selection, delegation |
| Agent Registry | Source of truth for available agents and capabilities |
| Scheduler | Runs the plan: dependency, concurrency, technical execution |
| Validator | Validates permission, budget, approval, lifecycle |
| Agents | Perform the work |

Target flow:

1. User sends an instruction.
2. CTO understands intent.
3. CTO decides whether to answer itself or delegate.
4. CTO selects an agent from the registry.
5. The system validates the CTO decision.
6. Scheduler executes the plan.
7. CTO evaluates the result and responds to the user.

Three rules that must hold:

- CTO may decide strategy and agent, but may never bypass permission or budget guards.
- The registry may not silently replace a CTO decision; a refusal must record a reason.
- Scheduler stays execution infrastructure, never a second planning authority.

File revisions requested by the developer:

- `AGENTS.md`: single planning authority becomes the CTO.
- `CTO.md`: remove the ban on dispatch/scheduling **at the orchestration decision level**.
- Old Orchestrator: becomes execution infrastructure, not a second planner.
- All security and lifecycle mechanisms stay unchanged.

Guiding principle: **CTO decides WHAT and WHO. Execution infrastructure controls HOW and WHEN.**

## Why this is needed

Users address the CTO with work requests, but the CTO currently cannot decide
who answers or who executes: a classifier picks the chat responder and the
worker Orchestrator builds the `ExecutionPlan`. The CTO's handoffs are advisory
hints, so a correct CTO decision can be dropped (live case: `@Lead` emitted when
no Lead was on the team, answered by "No teammate for Lead"). The developer
wants Fhara to be genuinely LLM-driven — intent and role choice owned by the
CTO — while the system keeps deterministic control over safety and execution.

## Target behaviour

| Question | Current | Target |
| --- | --- | --- |
| Who decides the chat responder? | intent classifier + owner resolver (`chat.ts:1153`, `:1255`) | CTO decision, validated by registry |
| Who decides the task executor? | worker Orchestrator (`orchestrator.ts:62,294`) | CTO decision, validated by registry |
| Is a CTO handoff binding? | hint only (`chat.ts:1490,1542`) | binding after validation; refusal records a reason |
| Can the registry override the CTO? | silent fallback / unmatched note (`chat.ts:1511`) | only with a recorded reason in `taskEvents` |
| Who executes? | Orchestrator plans and drives | Scheduler executes; Orchestrator is infrastructure |
| Who validates? | guards distributed across worker | named logical Validator role over the same guards |
| Budget / approval / terminal / sandbox | enforced today | unchanged, and applied to CTO decision calls too |

## Current state (`path:line`)

### Rules and personas

- `AGENTS.md:196` — no hardcoded routing; `:209` — single planning authority
  is the Orchestrator; `:220` — dynamic agent registry; `:232` — execution
  identity; `:244` — observability in `taskEvents`/`lifecycleHistory`.
- `packages/worker/AGENTS.md:46-48` — `ORCHESTRATOR_AUTHORITATIVE` default on,
  `ExecutionPlan` is the plan that runs, no second planner/routing path;
  `:52,65` — decision engine is the only orchestrator path and single seam.
- `apps/api/functions/lib/prompts/roles/CTO.md:19` — "Do not dispatch agents,
  schedule work, or monitor execution"; `:31` — "You do not see the routing
  decision". Generated copies: `lib/prompts/rolePrompts.data.ts:5`,
  `lib/prompts/agents.ts:40-41` (regenerate with `pnpm run prompts:roles`).

### Planning / decision

- `packages/worker/src/orchestrator/orchestrator.ts:62` — `createOrchestratorPlan`;
  `:101` — `evaluateAfterExecution`; `:294` — `createAuthoritativePlan`.
- `packages/worker/src/orchestrator/planner.ts:162` — `createPlan` is called
  from `createAuthoritativePlan` (`orchestrator.ts:332`).
- `packages/worker/src/orchestrator/delegation.ts:67` — `routePrimaryAgent`
  selects the primary agent deterministically; `:122` — `evaluateDelegation`.
- `packages/worker/src/orchestrator/capabilities.ts:117` — `routeCapability`;
  `:148` — `unroutedReason`.
- `packages/worker/src/orchestrator/decisionEngine/index.ts:18-31,92` —
  `judgeObjective → decideNext → directNext` is the only next-step seam.
- `packages/worker/src/orchestrator/decisionEngine/replan.ts:83` — `decideReplan`;
  `retry.ts:113` — `decideRetry`; `fixOwner.ts:79` — `decideFixOwner`.
- `packages/worker/src/orchestrator/architecture.ts:180` — `architectureDecider`
  picks the CTO for architecture decisions (a separate decision path).
- `packages/worker/src/services/runner/planning.ts:332,341,408` — plan creation
  branches on `orchestratorAuthoritative`.
- `packages/worker/src/services/runner/decision.ts:190,282` — evaluation and
  `decideNext` call sites.
- `packages/worker/src/services/taskRunner.ts:586` — the one `decideReplan` call.
- `packages/worker/src/orchestrator/policy.ts:361` — `ORCHESTRATOR_AUTHORITATIVE`;
  `:77` — budget mode.

### Chat routing

- `apps/api/functions/chat.ts:214` — `resolveIntent`; `:1153` call site;
  `:1296` — `chatPreRouteAllowed` deterministically rewrites intent/subtype;
  `:1255` — `resolveChatOwner`; `:1472` — structured handoff parse; `:1490`
  — `handoffOwner` hint; `:1511` — unmatched roles produce a system line;
  `:1542` — hint passed as `preferredAgentIds`; `:1134,1540` — task dispatch.
- `apps/api/functions/lib/chat/owner.ts:38` — `resolveChatOwner`;
  `lib/chat/dispatch.ts:25-28` — pre-route gate;
  `lib/chat/handoff.ts:39-49,53,67` — handoff parse/target/unmatched roles.
- `apps/api/functions/lib/chat/startTask.ts:115,142` — `dispatchTaskFromChat`
  resolves assignees from `preferredAgentIds`.
- `apps/api/functions/lib/roles.ts` — shared registry; `roleRegistry.ts:142-146`
  dual-writes membership to `projects.agentIds`.

### Execution infrastructure and guards (must stay)

- `packages/worker/src/scheduler/dagScheduler.ts:1,260-272` — consumes
  `decideRetry` and runs ready nodes; `:183,205` — node admission/dedupe.
- `packages/worker/src/services/runner/applyStage.ts` — approval/broker stage;
  `permissionBroker.ts` — approval waits and re-checks.
- `packages/worker/src/effects/llmCall.ts` — worker-wide pre-call budget gate.
- `packages/worker/src/tools/sandbox.ts:19` — `resolveSandboxPath`;
  `utils/commandAllowlist.ts:7`, `tools/runCommand.ts:67` — exact argv.
- `apps/api/functions/orchestration.ts` — `completeTask` terminal-status guard.
- `packages/worker/src/utils/capabilityDiscovery.ts:61-88` — runtime capability
  probe (must become registry evidence for the CTO).

### Observability and UI

- `apps/api/functions/lib/prompts/decision.ts` — prompt text for decisions;
  `lib/prompts/llm.ts` (decision trace): `decisionTrace.ts:34-58`.
- `apps/api/functions/schema.ts` — `taskEvents` payload is `v.any()`; a CTO
  decision can be logged without a migration.
- `apps/web/components/runs/Decisions.tsx:9` — renders orchestrator decisions;
  `apps/web/components/settings/tabs.tsx:1052` — "orchestrator decisions" copy;
  `apps/web/components/chat/MessageList.tsx:664` — role regex includes
  `orchestrator|planner`.

### Tests pinning the old contract

- `packages/worker/tests/orchestrator.test.ts`,
  `tests/ctoAuthority.test.ts`, `tests/decisionEngine.golden.test.ts:753`,
  `tests/orchestratorLive.integration.test.ts:17`,
  `tests/config/defaultsParity.test.ts`, `tests/config/knobsParity.test.ts`.
- `apps/api/functions/securityInvariants.test.ts` — terminal guard, token gate,
  credential cleanliness.
- Chat suites (`chatHandoffTools`, `chatIntent`, `chatWriteOffer`, …) currently
  fail at baseline (~31 worker failures / 2548 passing on 2026-11-28); compare,
  do not weaken.

## Decisions that must not change during execution

- CTO decides WHAT and WHO; infrastructure controls HOW and WHEN.
- Permission, budget, approval, terminal-status, sandbox and argv guards are
  unchanged and now also apply to the CTO's own decision calls.
- Registry is the only source of roles/capabilities; an unavailable or
  undeclared role is refused with a recorded reason, never silently replaced.
- Scheduler performs no planning and is not a second decision authority.
- One CTO decision path: no second planner, no parallel routing path, no
  hardcoded role map (regex-free, literal resolution).
- Observability uses `taskEvents` / `lifecycleHistory` only.
- A user's explicit `@Role` / *To* picker is binding input to the CTO decision.
- Generated prompt files are regenerated, never hand-edited.

## Architectural conflict audit (to resolve before implementation)

| # | Conflict | Evidence | Required resolution |
| --- | --- | --- | --- |
| C1 | Authority rule still says Orchestrator; flag keeps a second path alive | `AGENTS.md:209`, `worker/AGENTS.md:46-48`, `policy.ts:361`, `planning.ts:341` | Flip the rule to CTO; decide whether `ORCHESTRATOR_AUTHORITATIVE` is removed or redefined as "CTO-decision enforcement". Update `tests/config/defaultsParity.test.ts`, `knobsParity.test.ts`, `legacyEnv.ts:165`. |
| C2 | Old Orchestrator generates plans and evaluates outcomes | `orchestrator.ts:62,101,294`; `planner.ts:162` called at `:332` | Split generator from executor: CTO owns plan generation; these functions translate/validate the CTO plan into `ExecutionPlan`. No second `createPlan` call. |
| C3 | Decision Engine is documented as "the only orchestrator path" | `worker/AGENTS.md:52,65`, `decisionEngine/index.ts:18-31` | Redefine as translation/validation of CTO decisions plus deterministic vetoes; keep single seam. Update golden tests (`decisionEngine.golden.test.ts:753`) by adding, not deleting, events. |
| C4 | Chat responder chosen by classifier, with a deterministic pre-route override | `chat.ts:214,1153,1255,1296`; `owner.ts:38`; `dispatch.ts:25-28` | CTO decision replaces owner choice; classifier may classify intent kind only. Decide whether `chatPreRouteAllowed` is removed or becomes a validator veto with a recorded reason. |
| C5 | CTO handoff is advisory and can be dropped | `chat.ts:1472-1520`, `handoff.ts:39-49,67`, `startTask.ts:115` | Make validated handoff binding for responder and task owner; registry refusal writes a reason event. Depends on plan 003 (still TODO). |
| C6 | CTO persona forbids dispatch/scheduling | `CTO.md:19,31`; generated `rolePrompts.data.ts:5`, `agents.ts:40-41` | Rewrite boundary to allow proposing dispatch/scheduling at decision level; regenerate prompts. Keep "never execute tools itself" boundary. |
| C7 | Registry can silently reroute on unavailable capability | `capabilities.ts:117,148`; `chat.ts:1511` system line only | Add `ctodecision.rejected` event with requested role, reason, registry status; never pick a fallback without that event. |
| C8 | "Validator" has no single module today | guards in `policy.ts:77`, `effects/llmCall.ts`, `applyStage.ts`, `permissionBroker.ts`, `sandbox.ts:19`, `commandAllowlist.ts:7`, `orchestration.ts` | Decide: logical role over existing guards (recommended) vs new module. A new module needs a layering test and risks a second gate sink. |
| C9 | Scheduler consumes engine decisions for retry | `dagScheduler.ts:1,260-272` | Confirm this is execution control, not planning; document that retry/block directives come from the CTO-derived seam and scheduler never plans. |
| C10 | Response owner / final reply is chosen outside the CTO | `settleCompleted.ts:46`, `finalize.ts`, `responseOwner.ts` | CTO evaluates and responds; must still respect terminal guard and not re-open finished tasks. |
| C11 | Architecture decision is a separate decider | `architecture.ts:180` | Fold into the CTO decision contract; no second LLM decider. |
| C12 | Delegation primary agent is deterministic | `delegation.ts:67,122` | Must consume the validated CTO selection; keep circular-delegation bound. |
| C13 | Capability discovery is not fed to the CTO | `capabilityDiscovery.ts:61-88` | Pass availability as registry evidence so the CTO does not choose an unusable agent; keep probe bounded. |
| C14 | Observability needs a new decision shape | `schema.ts` (`taskEvents` `v.any()`), `decisionTrace.ts:34-58`, `runs/Decisions.tsx:9` | Log CTO decision with requested role, chosen agent, reason, registry status; render in existing cards. No new sink, no migration. |
| C15 | UI copy still names the old authority | `settings/tabs.tsx:1052`, `MessageList.tsx:664`, `runs/Decisions.tsx:9` | Copy-only update; no routing change. |
| C16 | Plan 003 (structured handoff) is still TODO with failing tests | `plans/README.md:17` | Resolve 003 first or fold its handoff-parser work into 007 Step 2; C5 cannot land on a broken parser. |
| C17 | More CTO LLM calls could bypass the budget gate | `effects/llmCall.ts` pre-call gate, `policy.ts:77` | Route CTO decision calls through the same pre-call gate and shared AbortController. |
| C18 | Config parity tests pin the old knob | `tests/config/defaultsParity.test.ts`, `tests/config/knobsParity.test.ts`, `legacyEnv.ts:165` | Any knob rename/removal updates both parity suites and env docs in the same step. |

## Resolutions recorded 2026-11-28 (developer said "gas")

| # | Resolution | State |
| --- | --- | --- |
| C1 | Keep `ORCHESTRATOR_AUTHORITATIVE` as the CTO-decision *translation* gate; wording updated in `worker/AGENTS.md`, flag not removed (no config parity churn) | DONE (docs); code knob untouched |
| C2 | CTO decision overrides primary agent in `createAuthoritativePlan`; planner stays a subroutine, no second plan | DONE |
| C3 | Decision engine stays the single translation/validation seam; it does not plan | DONE (docs), golden events unchanged |
| C4 | With no explicit @mention, every project-chat turn now starts at the CTO; its validated handoff binds the next responder. The deterministic owner resolver remains only as the no-CTO fallback | DONE 2026-11-28 (live: "Team" message → CTO, decision trace visible) |
| C5 | Validated handoff binds the owner/handoff queue; refusals now record a reason in the chat | DONE |
| C6 | `CTO.md` rewritten; role prompts regenerated | DONE |
| C7 | Worker logs `cto.decision` with requested role, reason and refusal; chat logs accepted/refused/direct CTO decisions with a reason | DONE |
| C8 | Validator = logical role over the existing guards; no new module, no new sink | DECIDED |
| C9 | Scheduler unchanged: execution only, retry directives come from the decision seam | DECIDED |
| C10 | `settleCompleted.ts:46` already selects the CTO as response owner | DONE (existing) |
| C11 | `architecture.ts:180` already selects the CTO as architecture decider | DONE (existing) |
| C12 | CTO decision overrides `orchestratorPlan.primary` and `primaryCapability` | DONE |
| C13 | Declared capabilities are validated in `validateCtoDecision`; runtime probe not yet forwarded as evidence | PARTIAL |
| C14 | `cto.decision` logged; `runs/RawEvents.tsx` renders all events, no new sink | DONE |
| C15 | Settings and Decisions copy updated | DONE |
| C16 | Plan 003 still TODO; chat handoff work must wait or be folded in | PENDING |
| C17 | The CTO decision is parsed from the existing planner call — no extra LLM call, pre-call budget gate unchanged | DONE |
| C18 | Config parity suites untouched because the knob was redefined, not removed | DONE |

## Steps (blocked until the conflict resolutions above are confirmed)

### Step 1: CTO decision contract and parser

Define a pure decision object: answer-vs-delegate, requested responder role,
requested executor role, capability, short reason. Validate roles against the
registry; unknown roles are refused, never guessed.

**Check**: `pnpm --filter @fhara/worker run typecheck`; new pure parser tests pass.

### Step 2: Chat answering uses the decision

Replace classifier owner choice with the validated CTO decision; keep @mention
binding. Record requested role, chosen agent, validation status and reason.

**Check**: targeted chat tests pass; baseline failure count does not increase.

### Step 3: Task planning uses the decision

CTO plan becomes the single input to `createAuthoritativePlan`; old plan
generation becomes translation/validation. No second planner.

**Check**: `tests/orchestrator.test.ts`, `tests/decisionEngine.golden.test.ts`,
`tests/capabilities.test.ts` — no new failures; new decision event asserted.

### Step 4: Infrastructure split

Old Orchestrator = execution infrastructure; Scheduler = executor only;
Validator = logical role over unchanged guards. Remove/redefine the authority
knob and update both config parity suites.

**Check**: typecheck worker + API; knobs parity passes with updated fixtures.

### Step 5: Prompts, rules and UI copy

Rewrite `CTO.md`, regenerate role prompts, update `AGENTS.md:209` and
`worker/AGENTS.md:46-48`, update the three web copy sites.

**Check**: prompt source test passes (regenerated); file reads confirm wording.

### Step 6: Regression and cleanup

Add cases for unknown role, disabled agent, @mention wins, budget veto, approval
required, terminal immutability, cancellation, and registry refusal with reason.

**Check**: `pnpm --filter @fhara/worker run test` compared with baseline
31 failed / 2548 passed; `pnpm --filter @fhara/api run typecheck`;
`pnpm --filter @fhara/runtime run build:functions`.

## Test plan

- Positive: CTO chooses a registered role; that agent answers and executes;
  decision traceable in `taskEvents`.
- Negative: unknown role, disabled agent, agent without capability — refused,
  reason recorded, no silent fallback; budget/approval veto still wins.
- Boundary: two decisions in one turn, duplicate roles, late completion after
  terminal status, approval timeout, step-limit hit.
- Empty: no CTO in team, no enabled agents, empty registry, unparseable CTO
  output — deterministic fallback with recorded reason.

## Completion criteria

- [ ] Conflict table C1–C18 each has a recorded resolution.
- [ ] One CTO decision path, no second planner, no hardcoded role map.
- [ ] Registry refusals are always recorded with a reason.
- [ ] Guard behaviours unchanged and covered by tests.
- [ ] No new test failures against the 2026-11-28 baseline.
- [ ] Prompts regenerated; AGENTS files and UI copy updated.
- [ ] Bundle rebuilt and stack restarted before live verification.

## STOP conditions

- A conflict resolution changes a guard, a terminal-status rule, or adds a
  second planning authority.
- A schema change needs a destructive operation.
- A check fails twice after a reasonable fix.
- The change needs work outside this repository.
- Implementation starts before the conflict resolutions are confirmed.
