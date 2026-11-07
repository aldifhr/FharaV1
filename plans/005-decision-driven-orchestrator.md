# Plan 005: Decision-driven orchestrator

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When done,
> set this plan's state in `plans/README.md`.

## Status

- Priority: P1
- Size: L (worker + docs; no web changes, no schema change planned)
- Risk: HIGH (touches the orchestrator/planner contract, the execution loop,
  replanning, and completion)
- Dependencies: none. Phase 3+ assumes Phase 2 is merged and green.
- Planned at: `main` @ `fd0914e`, 2026-11-07

## Why this is needed

MOAgent today is *plan-first*: one execution plan is produced before any agent
runs, that plan always contains a review node for every code change and a QA
node whenever a QA agent exists, and the whole DAG is executed before anything
is judged. The "orchestrator" produces a second, advisory decision sequence
that is logged but never executed. There is no decision after a subtask beyond
a deterministic delegation gate, and a failed verification replans from
scratch, throwing away completed work.

The result is the opposite of the intended behaviour: simple tasks pay for
review and QA they do not need, agents cannot escalate work that only becomes
visible mid-execution, and completion is "all subtasks finished", not "the
objective was achieved".

This plan converts the existing pipeline into a central decision loop without
rebuilding it: the scheduler, persistence, cancellation, budget and approval
infrastructure stay; the plan becomes a *mutable execution graph* the
orchestrator grows and shrinks from observed evidence.

## Target behaviour

| Situation | Today | After |
| --- | --- | --- |
| "Change the login button colour to blue" | implement + review + QA DAG | one developer subtask, then completion evidence (file applied) |
| Auth feature across API + UI | frontend + backend + review + QA, fixed order | orchestrator chooses sequential/parallel, QA only because the diff is auth-sensitive |
| Developer discovers an API dependency | only if the agent emits `delegationRecommendation`; depth/count gates apply | proposal is a *decision*: evaluated for relevance, self-serve, capability, budget, cycle; then spawned |
| QA reports a reproducible bug | whole task replans and re-implements | targeted fix subtask for the implementer, QA re-run, bounded rounds |
| Reviewer requests changes | review loop (already bounded) | unchanged, plus orchestrator can reject an unjustified review demand |
| Verification fails after a partial run | replan deletes completed outputs and re-does them | replan preserves completed subtasks and reapplies only the delta |
| Budget exhausted | pre-call gate throws, task ends `budget.exhausted` | unchanged (policy stays authoritative) |
| LLM unavailable during a decision | no LLM in the decision path | deterministic decision runs; the LLM advisor is optional and fails closed to deterministic |
| Completion | "no failed check" | objective evidence: artifacts exist, changes applied, verification + required QA passed, no open critical issue |

Four strategies are supported by the orchestrator as *choices*, not workflows:

- **direct** — one subtask, no review/QA unless risk says otherwise.
- **sequential** — a DAG with dependency chains.
- **parallel** — a DAG with independent ready nodes (existing scheduler).
- **iterative** — dynamic fix/correction nodes appended from observed results.

`ExecutionPlan.strategy` keeps its persisted union `"direct" | "single" | "dag"`
(`packages/worker/src/orchestrator/types.ts:61`); `iterative` is expressed by
appending fix nodes to a `dag`, not by a fourth stored value. This keeps
existing plan payloads readable.

## Current execution flow

Traced from `processTask`:

1. `processTask` classifies the command (`taskRunner.ts:586`), builds one
   `BudgetTracker`, arms one `AbortController` *before* planning
   (`taskRunner.ts:690`), and seeds the shared context (`taskRunner.ts:664-678`).
2. `createAuthoritativePlan` runs `createOrchestratorPlan` (a deterministic
   routing pass) and then `createPlan` (the planner subroutine)
   (`orchestrator.ts:335-399`). The plan that executes is the planner's.
3. `createPlan` picks the planning agent with `pickOrchestrator`
   (`planner.ts:67`, `157-166`), calls the LLM, validates the JSON
   (`planner.ts:106-118`), then *forces* review/QA on the result
   (`planner.ts:120` → `199-246`) and rejects the whole plan if any capability
   is unroutable (`planner.ts:121-123`, `256-263`). On any planner error it
   degrades to `heuristicPlan` (`planner.ts:127-150`), which hardcodes the same
   shape (`planner.ts:390-431`).
4. `executePlan` runs implementation nodes through `runScheduler`
   (`taskRunner.ts:2024`), then the review loop (`1930-2022`, `2048`), then
   dry-run + approval gate (`2059-2124`), then apply (`2126-2190`), then QA
   nodes (`2192-2204`), and returns `"completed"` (`2209`).
5. While nodes settle, `onOutcome` evaluates each result with
   `evaluateAfterExecution` (`taskRunner.ts:1671-1690`) and acts on it only when
   `authoritative` is on (`1704-1805`): `APPROVE` spawns a delegation node when
   the *agent* proposed exactly that capability (`1733-1740`), `REVISE` spawns
   a fix node when findings exist (`1771-1779`), `BLOCKED` halts only in
   `enforce` budget mode (`1705-1732`).
6. `finalize` runs static verification and `evaluateTask`
   (`taskRunner.ts:2576-2693`). A failed verdict triggers a replan
   (`1010-1090`) that clears all run state (`1076-1081`) and re-executes a
   brand-new plan; a failed execution takes the other replan branch
   (`1130-1194`, clearing at `1180-1185`).

## Proposed execution flow

```
UNDERSTAND        classify (deterministic) + objective + agent capabilities
    ↓
DECIDE(initial)   direct | sequential | parallel   (deterministic; LLM only if ambiguous)
    ↓
EXECUTE           scheduler executes the ready set (unchanged)
    ↓
OBSERVE           AgentResult + evidence: files, findings, verdicts, errors
    ↓
EVALUATE          policy gates → deterministic candidate decision
    ↓
DECIDE NEXT       deterministic if clear; LLM advisor only for ambiguity/failure/replan
    ↓                 (every advisor answer validated against the same contract)
    ├─ execute / parallel → add nodes, continue
    ├─ delegate           → validated proposal → add persisted node
    ├─ replan             → new plan, preserve completed state
    ├─ ask_user           → stop with an explicit question (no silent failure)
    └─ complete           → objective evidence satisfied → finalize
    ↓
CONTINUE or TERMINATE (objective met / budget / deadline / cancel / ask_user)
```

Separation of concerns stays exactly as today: the orchestrator decides, the
runner/scheduler executes, `policy.ts` + `BudgetTracker` enforce. A decision is
a *request*; `validateDecision` and the scheduler gates can still refuse it.

## Identified architectural problems

Every claim below points at live code.

1. **Plan-first with no mid-flight decision loop.** One plan is built at
   `taskRunner.ts:700-790`; `executePlan` only re-enters planning on failure or
   failed verification (`taskRunner.ts:1010-1090`, `1130-1194`). Nothing can
   change strategy between two subtasks on a successful run.

2. **Review is mandatory for every code change.** `ensureRequiredSubtasks`
   always appends a review node when a `code_change` exists
   (`planner.ts:199-223`) and is applied to every LLM plan (`planner.ts:120`);
   the planning prompt orders it (`planner.ts:188`) and the deterministic
   fallback hardcodes it (`planner.ts:390-418`). The classifier also always
   suggests `code-review` for a change verb (`classifier.ts:70-75`).

3. **QA is mandatory whenever a QA agent exists.** `planner.ts:225-239` and
   `planner.ts:420-431` add QA unconditionally; there is no risk signal, no
   user request, no dependency on whether the change is testable.

4. **An unroutable hint discards the whole LLM plan.** Inserting the review
   node at `planner.ts:212-223` followed by `ensureRoutable`
   (`planner.ts:256-263`, called at `121`) returns `null` when no agent serves
   `code-review`, so a perfectly good implementation plan is thrown away and
   the heuristic plan (which contains the same node) is used. With
   `allowFallback` on by default (`policy.ts:133`), `routeCapability` then
   routes that review node to the highest-priority *unrelated* agent
   (`capabilities.ts:126-133`) — a developer can end up "reviewing" its own
   work.

5. **The orchestrator's plan is a second, fictional plan.** `createOrchestratorPlan`
   emits `EXECUTE_PRIMARY` + `DELEGATE` steps derived from
   `classification.suggestedCapabilities.slice(1)`
   (`orchestrator.ts:143-164`), not from results; `needsAdditionalAgents`
   (`delegation.ts:72-76`) is true for every code change because the classifier
   always includes `code-review`. These steps are logged
   (`taskRunner.ts:760-771`) and then ignored: the executed plan is the
   planner's (`orchestrator.ts:366-379`).

6. **Two decision vocabularies, one acted on.** `OrchestratorDecision.action`
   has `EXECUTE_PRIMARY | DELEGATE | REVISE | COMPLETE | BLOCKED |
   BUDGET_EXHAUSTED` (`orchestrator.ts:42`); `DelegationDecision` has
   `APPROVE | REJECT | REVISE | COMPLETE | BLOCKED` (`delegation.ts:13`); the
   runner acts on the second (`taskRunner.ts:1704-1805`). There is no
   `ask_user`, `parallel`, or `replan` action anywhere in the worker
   (verified by grep: zero hits).

7. **Only agent-initiated delegation executes.** The APPROVE branch requires
   `agentResult.delegationRecommendation?.targetCapability ===
   evaluation.nextCapability` (`taskRunner.ts:1733-1740`). The deterministic QA
   approval path is explicitly demoted to a recorded decision
   (`taskRunner.ts:1741-1746`), so "the orchestrator decides QA is needed" can
   never add a QA node.

8. **The hybrid engine is inverted, not hybrid.** All post-execution decisions
   are deterministic (`delegation.ts:113-289`); `shouldCallLLM` is declared
   (`delegation.ts:20`) and returns `false` on every path. All planning is one
   LLM call (`planner.ts:58-148`). Ambiguous delegation and failures — the
   cases the brief asks an LLM for — get no reasoning; planning, which is
   mostly mechanical, always gets a call.

9. **Failure has no alternative strategy.** A failed result returns `REVISE`
   with no target and no findings (`delegation.ts:128-134`); the runner's
   REVISE branch requires findings (`taskRunner.ts:1771-1779`), so the failure
   only reaches the scheduler retry and then fails the whole run → full-DAG
   replan. There is no retry-with-another-agent path.

10. **Replanning destroys completed work.** Both replan branches clear
    `priorOutputs`, `fileChanges`, `qaVerdicts`, `feedback` and
    `completedKeys` (`taskRunner.ts:1076-1081`, `1180-1185`). Scenario F
    ("completed work is not unnecessarily repeated") is currently guaranteed to
    fail.

11. **QA failure is not iterative.** QA runs after apply
    (`taskRunner.ts:2192-2204`), its verdict is recorded (`1654-1661`), and
    `executePlan` still returns `"completed"` (`2209`). `finalize` then marks
    the task failed (`evaluator.ts:111-136`) and the runner replans everything
    (`taskRunner.ts:1010-1090`) instead of asking the implementer to fix the
    specific failure and re-running QA.

12. **Completion ignores the objective and open issues.** The verdict is "no
    check failed" (`evaluator.ts:132-136`); the checks are subtask status,
    applied files, on-disk verification, static verification and QA verdicts
    (`evaluator.ts:49-130`). `outstandingIssues` is collected
    (`orchestrator.ts:224`, `taskContext.ts:174-185`) and used only as replan
    text (`taskRunner.ts:514-523`); a task can end `done` with an open critical
    finding. There is no completion-rationale event.

13. **Context grows without selection.** `SharedTaskContext.agentExecutions`,
    `artifacts`, `outstandingIssues` are appended forever
    (`taskContext.ts:106-130`); `buildAgentExecutionContext` filters issues but
    does not summarize (`agentContext.ts:49`). A decision prompt built from this
    will grow with the task, which the brief explicitly forbids (§11).

14. **No bound for the new loop.** `maxPlanningIterations` bounds replans only
    (`taskRunner.ts:907-908`); there is no decision-step bound, and no
    review/QA mode. An objective-driven loop added without a bound can spin.

## What is already right and must be preserved

| Mechanism | Where | Why it stays |
| --- | --- | --- |
| Pre-call budget gate | `budget.ts:228-238`, threaded at `taskRunner.ts:1449` | non-negotiable #6 |
| One `AbortController` per task | `taskRunner.ts:690`, combined at `1446`, polled at `1539-1563` | non-negotiable cancellation model |
| Terminal-status guard | `orchestration.completeTask` | non-negotiable #3 |
| Approval gate | `taskRunner.ts:2074-2124` | non-negotiable #5 |
| Per-agent concurrency gate | `taskRunner.ts:1569-1574`, `dagScheduler.ts:340-355` | real parallelism bound |
| Dynamic subtask persistence | `taskRunner.ts:940-957`, `1302-1329` | recovery keeps the whole DAG |
| Ready-set scheduler + retry classification | `dagScheduler.ts:129-408` | proven execution engine |
| Provider pool + per-agent override | `llm/resolver.ts`, `planner.ts:77-84`, `types.ts:41-45` | Scenario J already works; do not add per-agent keys |
| Tool sandbox + exact-argv allowlist | `tools/sandbox.ts`, `tools/runCommand.ts` | non-negotiable #4 |

## Decisions that must not change during execution

- The orchestrator remains the single planning authority; there is still only
  one plan object per version, and the planner is its subroutine. No second
  routing path.
- Decisions are requests. `validateDecision` + `policy.ts` + `BudgetTracker`
  can refuse any of them. The LLM never bypasses a gate.
- No new per-agent credential, env key, or mandatory provider configuration.
- No schema migration in phases 2-5. `taskContexts.decisions` is stored as
  `v.array(v.any())` (`apps/api/convex/schema.ts:340`), so new decision fields
  inside that array need no schema change. If a later step needs a new column,
  it is additive `v.optional` and a separate plan step.
- The approval gate, sandbox, terminal guard, and budget gate are untouched.
- Review and QA become *conditional*, never removed: `ORCHESTRATOR_REVIEW_MODE=always`
  and `ORCHESTRATOR_QA_MODE=always` restore today's behaviour exactly.

## Steps

Phase 1 (this audit) is complete when the audit above is approved; it changes
no production code. Phases 2–6 are ordered by dependency and each ends green
before the next starts.

### Phase 2 — Decision contract and engine (behaviour-neutral)

**Step 2.0 — record the typecheck baseline**

`npm run --workspace=@moagent/worker typecheck` is red *before* this plan, and
the errors are pre-existing: `AgentDefinition._id`/`capability` are plain
`string`s (`types.ts:27`, `48-56`) while `WorkerApi` now expects
`Id<"agents">`/`Id<"tasks">`, and the `reviewLoop.integration.test.ts` fixtures
use string ids. Also pre-existing: `integrations.ts:226-227` (`body` is
`unknown`) and `llmCrypto.ts` (`BufferSource`/`KeyUsage` not in the worker's
lib). Save the full error list to `TASKS.md` (git-ignored) and compare against
it after every step. Do not "fix" the baseline by widening types or adding
`any`/`@ts-ignore`; fixing the existing fixture typing is a separate cleanup.
The completion criterion for this plan is **no new error from a touched line**.

**Step 2.1 — contract module**

Add `packages/worker/src/orchestrator/decision.ts`:

```ts
export type DecisionAction =
  | "execute"      // run the selected agent on one node
  | "delegate"     // add work for another capability
  | "parallel"     // add independent nodes in one batch
  | "replan"       // replace the remaining graph, keep completed work
  | "complete"     // objective evidence satisfied
  | "ask_user";    // blocked on missing information/approval

export interface DecisionContext {
  taskId: string;
  objective: string;
  classification: Classification;
  planVersion: number;
  plan: ExecutionPlan;
  results: ExecutionHistoryEntry[];      // summarized, not raw outputs
  openIssues: OutstandingIssue[];
  budget: BudgetSnapshot;
  policy: ExecutionPolicy;
  agents: AgentDefinition[];
  completedKeys: ReadonlySet<string>;
  step: number;
}

export interface OrchestratorDecision {
  id: string;
  action: DecisionAction;
  reasoning: string;                 // <= 500 chars, persisted
  target?: { agentId?: string; capability?: string };
  task?: { title: string; description: string; kind: SubtaskKind };
  dependencies?: string[];
  expectedOutcome?: string;
  constraints?: {
    maxConcurrency?: number;
    deadlineMs?: number;
    requiresApproval?: boolean;
  };
  decidedBy: "deterministic" | "llm";
  planVersion: number;
  createdAt: number;
}

export type DecisionValidation =
  | { ok: true; decision: OrchestratorDecision }
  | { ok: false; reason: string; violated: "contract" | "policy" | "routing" };
```

`validateDecision(raw, ctx)` checks, in order: known action; reasoning non-empty;
for `execute|delegate|parallel`: capability present, agent resolves via
`routeCapability(..., { allowFallback: false })`, node count within
`maxSubtasks - plan.subtasks.length`, dependencies exist or are accepted in the
same batch, no cycle (`findCycle`), no duplicate key; for `delegate`: depth
(`chainCapabilities.length - 1 < maxDelegationDepth`), task-wide count
(`budget.delegationDepth < maxDelegations`), agent diversity
(`canAddAgent`), circularity (`preventCircularDelegation`); for `complete`:
`expectedOutcome` evidence key present; for `ask_user`: question text present.
Return the typed rejection; never throw into the scheduler.

**Step 2.2 — deterministic decision function**

Add `nextDeterministicDecision(ctx, observation): OrchestratorDecision | "ambiguous"`:

| Observation | Decision |
| --- | --- |
| cancelled / deadline | `complete` is refused; the runner keeps exiting as cancelled (deterministic, outside the engine) |
| budget exhausted (policy) | `complete` with `expectedOutcome: "policy:budget"`; runner maps to `budget.exhausted` |
| failed result, permanent error | `replan` if a different capability can attempt it, else `complete` with failure evidence |
| failed result, transient | `execute` (scheduler retry owns backoff) |
| success + open critical finding | `delegate` to implementer (fix) |
| success + agent proposal | validate proposal; if valid `delegate`, else record `REJECT` and continue |
| success + no remaining node + evidence sufficient | `complete` |
| success + no remaining node + evidence missing | `replan` or `ask_user` |
| anything else | `"ambiguous"` |

**Step 2.3 — LLM advisor (optional, budget-gated)**

Add `decisionLlm.ts` with `decideWithLlm(ctx, observation)`:
- called only when `nextDeterministicDecision` returns `"ambiguous"`, or when
  `policy.decisionLlmMode === "always"` for A/B comparison;
- prompt contains the objective, plan goal, summarized results (last 6,
  findings only), open issues, available agents + capabilities, remaining
  budget, and the four allowed actions. It does **not** contain raw agent
  outputs, prompts, or any credential material.
- output is parsed with `extractJson` and passed through `validateDecision`;
  a parse failure, validation failure, timeout, or thrown error falls back to
  the deterministic decision and records `orchestrator.decision_fallback`.
- the pre-call gate `assertBudgetForCall()` runs before the request, and the
  call uses `llmTaskGate` + the task `signal`.

**Step 2.4 — wire the engine, keep behaviour identical**

In `taskRunner.ts`, replace the inline action selection at `1671-1804` with
`decide(...)` + `applyDecision(...)` helpers in the same file. `applyDecision`
performs exactly today's side effects (build node, push to plan, register
chain/fix depth, `persistDynamic`, set `dynamicNodes`) so Phase 2 changes no
behaviour: `ORCHESTRATOR_DECISION_ENGINE` defaults `false`, and when false the
current code path runs unchanged.

Policy additions in `policy.ts`:
- `decisionEngine: boolean` (`ORCHESTRATOR_DECISION_ENGINE`, default `false`)
- `decisionLlmMode: "off" | "ambiguous" | "always"` (`ORCHESTRATOR_DECISION_LLM`,
  default `"off"` until Phase 5)
- `maxDecisionSteps: number` (`ORCHESTRATOR_MAX_DECISION_STEPS`, default 20,
  min 1, max 200)

**Check**: `npm run --workspace=@moagent/worker typecheck` → no NEW error versus
the Step 2.0 baseline.
`npx --workspace=@moagent/worker vitest run tests/orchestrator.test.ts tests/delegation.test.ts tests/phase4Runner.test.ts` → all pass.
Add `tests/decision.test.ts` covering the contract and validator (accept,
policy reject, unknown capability, cycle, duplicate key).

### Phase 3 — Progressive planning

**Step 3.1 — hints instead of mandates**

Replace `ensureRequiredSubtasks` (`planner.ts:199-246`) with
`applyPlanningHints(plan, agents, ctx)`:
- review is added only when `reviewMode === "always"`, or `"auto"` **and** one
  of: the command/diff names auth, security, payments, migrations, or
  concurrency; the plan has ≥2 `code_change` nodes across different
  capabilities; `classification.kind === "multi"`; an agent explicitly offers
  review capability.
- QA is added only when `qaMode === "always"`, or `"auto"` **and** the project
  has a `devUrl`/`qaUrl` **and** one of: the risk signal above; the command asks
  for testing; a QA capability is present **and** the plan has a `code_change`.
- Both modes are policy knobs: `reviewMode`, `qaMode`
  (`ORCHESTRATOR_REVIEW_MODE`, `ORCHESTRATOR_QA_MODE`, default `"auto"`).

**Step 3.2 — prompt and heuristic parity**

- Replace the mandatory rules at `planner.ts:188-189` with: "Add a review node
  only when the change is risky (auth, security, payments, migrations,
  cross-domain, concurrency); add QA only when the change is user-visible or
  the request asks for verification. Keep the plan minimal."
- `heuristicPlan` (`planner.ts:266-441`): a single-domain code change yields one
  `code_change` node and `strategy: "direct"`; `multi` keeps frontend+backend
  and adds review/QA through `applyPlanningHints` only.
- `ensureRoutable` (`planner.ts:256-263`): drop unroutable *hint* nodes with a
  `plan.hint_dropped` event instead of discarding the whole LLM plan; degrade
  only when no subtask routes.

**Step 3.3 — direct execution is real**

`executePlan` already skips the review loop when there are no review nodes
(`taskRunner.ts:1931`) and skips QA when there are no QA nodes (`2192`). Add an
assertion test that a `direct` plan with one `code_change` runs zero review and
zero QA nodes, and still passes through dry-run + approval.

**Check**: worker typecheck (no new error vs baseline); `tests/planner.test.ts`, `tests/orchestrator.test.ts`,
`tests/classifier.test.ts`, `tests/taskRunner.replan.test.ts` green; new
`tests/phase6Progressive.test.ts` for scenarios A and B.

### Phase 4 — Adaptive delegation

**Step 4.1 — evaluate proposals, not just route them**

Extend `evaluateDelegation` (`delegation.ts:87-289`) with a `selfServe` check
before approving: if the proposing agent's own capabilities include the
proposed capability (normalized match), return `REJECT` with reason
`"proposing agent can serve this capability"`. This is Scenario E.

**Step 4.2 — one decision trail**

Every decision (deterministic or LLM) is recorded:
- `taskEvents` type `orchestrator.decision` with
  `{ id, action, reasoning, target, decidedBy, planVersion, step }`;
- `sharedContext.decisions` (existing array, `v.any()`), so replan feedback
  (`taskRunner.ts:498-525`) sees it;
- `orchestrator.evaluation` stays for backward compatibility (UI reads it).

**Step 4.3 — LLM escalation for weak proposals**

Enable `decisionLlmMode: "ambiguous"` once Phase 4 tests are green. The advisor
sees the proposal (`targetCapability`, `reason`, proposing agent), the plan
goal, the last results, and the remaining budget; it may `delegate`, `execute`
(do it in the current agent's next node), or `complete`. Its answer goes through
`validateDecision`, and the deterministic evaluator's policy rejections
(`maxDelegations`, depth, cycle, concurrency) always win.

**Check**: worker typecheck (no new error vs baseline); `tests/delegation.test.ts`,
`tests/phase4Runner.test.ts`; new `tests/phase6Delegation.test.ts` (scenarios C,
E); `tests/decision.test.ts` (LLM advisor throwing → deterministic fallback,
scenario H).

### Phase 5 — Objective evaluation, iterative correction, safe replan

**Step 5.1 — objective evidence**

Add `evaluateObjective(ctx)` (same module as the decision policy) returning
`{ satisfied: boolean; evidence: string[]; missing: string[] }`:
- every `code_change` in the executed graph has an applied file change, or a
  documented exemption (research/audit tasks have none);
- static verification ran and did not fail when a `code_change` was applied;
- required QA (if present in the plan) has a `passed` verdict;
- no `open` issue with `critical`/`high` severity raised after the last fix;
- the last decision's `expectedOutcome` is met (e.g. "file applied",
  "tests pass", "question answered").

`complete` is only emitted when `satisfied`; otherwise `replan`/`ask_user`.
Emit `orchestrator.completed` with the evidence array and the completion
rationale.

**Step 5.2 — targeted QA correction**

When a QA node settles `failed`, do not return `"completed"` from
`executePlan` (`taskRunner.ts:2192-2209`). Instead, inside the decision loop:
- if `fixDepth < 1` and a remediation budget remains, spawn
  `fix_qa_<n>` targeting the implementer capability with the QA findings
  (synthesize a finding from the QA details when `meta.findings` is absent),
  depend on the QA node, persist it (`persistDynamic`), then re-run the QA node
  in a fresh `runNodes([qaNode])` pass;
- bound remediation rounds with `maxReviewIterations` (reused, not a new knob);
- if the bound is hit, end with the QA failure as the explicit reason.

**Step 5.3 — replan without rework**

Both replan branches (`taskRunner.ts:1010-1090`, `1130-1194`) must stop clearing
everything (`1076-1081`, `1180-1185`). Replace the resets with
`carryForwardState(previousPlan, previousState, newPlan)`:
- keep `priorOutputs` and `fileChanges` for a new subtask whose
  `(kind, capability, normalized description)` matches a completed old one;
- keep `qaVerdicts` only for subtasks carried over unchanged;
- recompute `completedKeys` from the carried-over matches;
- clear `feedback` only.

This is the only place in the plan that changes replan semantics; it must be
covered by the existing `tests/taskRunner.replan.test.ts` plus Scenario F.

**Step 5.4 — loop bound**

Every decision step increments a counter in the run state. When
`step >= policy.maxDecisionSteps`, stop with an explicit
`task.error` + `completeTask(failed, "Decision step limit reached")`; never
silently mark done. The bound is subordinate to deadline, cancellation, and
budget.

**Check**: worker typecheck (no new error vs baseline); `tests/phase5Runner.test.ts`,
`tests/taskRunner.replan.test.ts`, `tests/qaTaskRunner.test.ts`; new
`tests/phase6Completion.test.ts` (scenarios D, F, G).

### Phase 6 — Hardening, tests, documentation

**Step 6.1 — turn the engine on**

Set `ORCHESTRATOR_DECISION_ENGINE` default to `true` only after the whole
worker suite is green with it forced on. Keep the flag documented for one
release cycle. `reviewMode`/`qaMode` stay `"auto"`.

**Step 6.2 — fix the test import**

`packages/worker/tests/llmResolver.test.ts:18` imports
`../../apps/api/convex/llmProviders`, which from `packages/worker/tests`
resolves to a non-existent `packages/apps/...`. Use the worker alias that
already exists in both `vitest.config.ts` and `tsconfig.json`:
`import { toPublicProvider } from "@/api/convex/llmProviders";` and remove the
`@ts-ignore` at line 17.

**Step 6.3 — documentation**

- `packages/worker/AGENTS.md` "Orchestrator contract": replace the fixed
  decision list with the six actions, state that review/QA are conditional, and
  document `ORCHESTRATOR_DECISION_ENGINE`, `ORCHESTRATOR_DECISION_LLM`,
  `ORCHESTRATOR_REVIEW_MODE`, `ORCHESTRATOR_QA_MODE`,
  `ORCHESTRATOR_MAX_DECISION_STEPS`.
- `ROADMAP.MD`: note the orchestrator refactor and what is still deferred
  (per-project policy overrides, decision UI).
- This plan: mark DONE in `plans/README.md` only when every completion criterion
  passes.

**Check**: `npm run --workspace=@moagent/worker typecheck` → no new error versus
the Step 2.0 baseline; `npm test` (whole worker suite); `npm run
--workspace=@moagent/api typecheck`; `npm run knip`.

## Test plan

Existing suites are unit/integration with mocked executors (see
`tests/phase4Runner.test.ts`, `tests/phase5Runner.test.ts`). Follow that pattern;
do not add a live-provider or Playwright test.

| # | Scenario | Test file | Assertion |
| --- | --- | --- | --- |
| A | Simple task | `tests/phase6Progressive.test.ts` + `tests/orchestrator.test.ts` | plan has 1 node, `strategy: "direct"`; zero review/QA nodes executed |
| B | Complex auth | `tests/phase6Progressive.test.ts` | ≥2 capabilities, dependencies respected; QA present because the risk signal fired |
| C | Dynamic delegation | `tests/phase6Delegation.test.ts` | validated proposal adds a node; `saveDynamicSubtasks` called with the delegation origin; the node executes |
| D | QA failure | `tests/phase6Completion.test.ts` | QA `failed` spawns a fix node for the implementer; QA re-runs; no full replan |
| E | Unnecessary delegation | `tests/delegation.test.ts` | proposal for a capability the proposer can serve is `REJECT`ed; no node added |
| F | Replanning | `tests/taskRunner.replan.test.ts` | a completed `code_change` key is not re-executed after replan; its file change survives |
| G | Budget exhaustion | `tests/phase5Budget.test.ts` | enforce mode: no call after exhaustion; task ends `budget.exhausted`; warn mode keeps running |
| H | LLM unavailability | `tests/decision.test.ts` | advisor throws/returns garbage → deterministic decision; `orchestrator.decision_fallback` recorded; run continues |
| I | Cancellation/recovery | `tests/phase4HardeningRecovery.test.ts` | no new node starts after abort; resumed run keeps completed keys |
| J | Shared LLM | `tests/llmResolver.test.ts` + `tests/decision.test.ts` | two agents resolve through one connection; no per-agent key required; no ciphertext in any decision/event payload |

Negative cases that must be refused (all in `tests/decision.test.ts`):
unknown action; missing reasoning; capability no agent serves; node over
`maxSubtasks`; dependency on an unknown node; dependency cycle; delegation over
`maxDelegationDepth`/`maxDelegations`; delegation to an agent at
`maxConcurrency`; `complete` without evidence; `ask_user` without a question.

## Compatibility notes

- `ExecutionPlan` shape and `v.any()` plan payload are unchanged.
- `taskContexts.decisions` is `v.any()`; new fields inside a decision need no
  migration. `orchestration.upsertTaskContext` already accepts free-form arrays.
- New task events (`orchestrator.decision`, `orchestrator.completed`,
  `orchestrator.decision_fallback`, `plan.hint_dropped`) require no schema
  change: `taskEvents.type` is a string (`apps/api/convex/schema.ts:269`).
- Default-off flags in Phase 2 mean a revert is a single env change until
  Phase 6.

## Completion criteria

- [ ] `ORCHESTRATOR_DECISION_ENGINE=true` and `npm test` is green (32 files /
      222 tests is the baseline; the new suites add to it).
- [ ] `npm run --workspace=@moagent/worker typecheck` introduces no new error
      versus the Step 2.0 baseline.
- [ ] `npm run --workspace=@moagent/api typecheck` stays clean (it is clean
      today; no backend change is planned).
- [ ] `npm run knip` reports no new finding from this work (the pre-existing
      baseline is tracked separately).
- [ ] Scenario A proves one agent, zero review, zero QA.
- [ ] Scenario D proves QA failure produces a targeted fix and a second QA run.
- [ ] Scenario F proves replan preserves completed work.
- [ ] Scenario G proves the policy still stops the run and the status is
      explicit.
- [ ] Scenario H proves a decision survives LLM unavailability.
- [ ] `packages/worker/AGENTS.md` matches the new contract.
- [ ] No secret, key, or ciphertext appears in any new event payload (asserted
      in Scenario J).

## STOP conditions

- A step needs a schema change (additive `v.optional` is allowed but must be a
  separate, reviewed step; a destructive change stops here).
- A step needs the approval gate, sandbox, terminal guard, or budget defaults
  changed.
- The decision engine cannot be made behaviour-neutral in Phase 2 (existing
  runner tests fail with the flag off).
- A QA-fix loop and the review loop both try to own the same fix node.
- `maxDecisionSteps` has to be raised repeatedly to make a test pass — that is
  a runaway loop, not a bound.
- A check fails twice after a reasonable fix.
