# Architecture Validation Matrix — MOAgent

Date: 2026-11-07 baseline. Worker baseline: 40 files / 307 tests green; typecheck 57 pre-existing.
API baseline: 4 files / 25 tests green; typecheck clean. Web typecheck clean. Knip: 8 unused files / 10 unused deps / 1 dup (baseline).

## How to read
- **FACTS**: implementation verified by reading code + running tests. **INFERENCE**: reasoning from diagrams/types.
- Status: COVERED = existing test exercises it; GAP = no test; PARTIAL = unit only, integration missing.

## 1. Component → implementation → test

| Req component | Implementation (file:line) | Existing tests | Status |
|---|---|---|---|
| IntentClassifier | `worker/src/orchestrator/classifier.ts:17 classifyCommand`, `:92 isGreeting` | `classifier.test.ts` 5 tests | PARTIAL — gaps: empty, greeting variants, Indonesian verbs (tambah/buat/ubah/perbaiki/hapus), precedence (audit+changeVerb), defaulted flag |
| ContextResolver / CSO | `orchestrator/agentContext.ts:20 buildAgentExecutionContext`, `taskContext.ts:100 createSharedTaskContext`, `context/compaction.ts:28 shouldCompact`, `:54 buildTaskPrompt`, `:63 buildChatPrompt` | `contextScope.test.ts`, `taskContext.test.ts` | PARTIAL — capability filter + compaction trigger tested; gaps: exact boundary 40/24k, `maxPreviousResults` cap, most-recent-always, `previousOutputsFromContext`, summarize throwing, budget-gate throw propagation |
| ProjectAgentRegistry | `api/convex/conversations.ts:30 selectDefaultChatAgents`, `:53 activeParticipantRows`, `agents.listByProject/getRegistryView` | `conversations.test.ts`, `chatAndTasks.test.ts` mirror | COVERED — membership+enabled gate, leave/rejoin, empty team, disabled-after-join, lead selection |
| ConversationRouter | `worker/src/router/route.ts:67 routeMessage`, `selectAgents.ts:19 selectAgentsForChat` | `router.test.ts` R1-R7 (17) | PARTIAL — gaps: advise-not-called invariant, chatMaxAgents 0/negative, advisor case-sensitivity (`"TASK"`), disabled/offline agents, dedupe |
| TaskRouter | `orchestrator/capabilities.ts:85 routeCapability`, `delegation.ts:33 routePrimaryAgent` | `capabilities.test.ts`, `router.test.ts:119`, `orchestrator.test.ts` | PARTIAL — gaps: tie-break priority/name, `offline` vs `isEnabled` inconsistency, strategy direct/single mapping unpinned |
| ConversationEngine | `api/convex/chat.ts:164 replyToChat`, `chatContext.ts:61 getContext`, `messages.send` | `conversations.test.ts` (summary + last12), `chatAndTasks.test.ts` | PARTIAL — gaps: closed-conversation reuse, conversationId ignored in history fetch, `ensureForChat` vs project mismatch only partially |
| Orchestrator | `orchestrator/orchestrator.ts:74 createOrchestratorPlan`, `:189 evaluateAfterExecution`, `:338 createAuthoritativePlan` | `orchestrator.test.ts`, `phase4Hardening.test.ts:306` | PARTIAL — gaps: BUDGET_EXHAUSTED step, stored-plan adoption, `applyDecision`/`kindForCapability` zero tests, `evaluateObjective` edge (critical open, skipped verification) |
| Planner | `orchestrator/planner.ts:70 createPlan`, `:233 applyPlanningHints`, `:367 ensureRoutable`, `:389 heuristicPlan` | `planner.test.ts`, `phase6Progressive.test.ts` | PARTIAL — gaps: LLM success path (createdBy orchestrator), `pickOrchestrator`, abort mid-LLM, `hasQaUrl` trigger, uniqueKey collision |
| DelegationEvaluator | `orchestrator/delegation.ts:88 evaluateDelegation`, `:330 preventCircularDelegation` | `delegation.test.ts` (incl. selfServe E), `phase6Delegation.test.ts` C | COVERED except: critical-findings-no-implementer fallthrough, empty-enabled BLOCKED suffix, QA heuristic branch |
| AgentRuntime | `execution/agentExecutor.ts:106 executeSubtask`, codeChange/review/QA/readOnly/shell | `phase4Execution.test.ts`, `phase5Runner.test.ts`, `qaTaskRunner.test.ts` | PARTIAL — gaps: readOnly-no-write assertion, untrusted-output-can't-override-policy, shell allowlist bypass |
| PolicyEngine | `orchestrator/policy.ts:129 loadPolicy`, `governance/registry.ts:85 tool_search`, `:95 tool_describe`, `:107 tool_call`, `governance/tools.ts` | `toolRegistry.test.ts` T1-T3, `phase5Budget.test.ts` | PARTIAL — `loadPolicy` env parsing has **zero** dedicated tests (NaN/floor/clamp, bool vocab, planningMode garbage) |
| ProviderPool | `api/convex/lib/llmResolver.ts:64 loadProviderPool`, `:117 pickPrimaryConnection`, `:135 resolveConnectionKey`; worker `llm/resolver.ts` | `llmResolver.test.ts` J, `llmCall.test.ts`, `llmHealth.test.ts` | COVERED — shared connection, priority/weighted/modelPatterns/health, no per-agent key; gap: malformed ciphertext / wrong `PROVIDER_ENCRYPTION_KEY` explicit error |
| TaskLifecycle | `api/convex/orchestration.ts:970 completeTask`, `:1028 setTaskStatus` terminal guard; `taskRunner.ts` | `securityInvariants.test.ts` terminal, `evaluator.test.ts`, `phase6Completion.test.ts` D | PARTIAL — backend originial: `completeTask` accepts any status, no workerId check; `setTaskStatus` no transition matrix; `tasks.remove` destroys audit trail |
| Cancellation | `taskRunner.ts` AbortController per task, `dagScheduler.shouldCancel`; `api/convex/tasks.ts cancel` | `phase4HardeningRecovery.test.ts` I, `phase4Execution.test.ts`, qaThreading | COVERED — no new node after abort, resume keeps completed keys; gap: cancellation **during QA** re-run (`runQaLoop`) — partially via `taskCancelled()` |
| Recovery | `taskRunner.buildStateFromDb`, `carryForwardState`, `recoverStale` (backend), `recoverStaleMessages` | `taskRunner.replan.test.ts` F, `phase4HardeningRecovery`, `queue.test.ts` | COVERED — completed work survives replan; gap: corrupted/missing execution context (`buildStateFromDb` with malformed subtasks) |
| BudgetTracker | `orchestrator/budget.ts:162 recordLLMCall`, `:228 assertLlmCallAllowed`, `:240 isBudgetExhausted`, `:113 seed/restoreExtras` | `budget.test.ts`, `phase5Budget.test.ts` G | COVERED — pre-call gate, enforce/warn, seed/restore; gaps: `canDelegate()`/`canCallLLM()` no direct test, monotonic-max seed |

## 2. Integration 20 scenarios

| # | Scenario | Test file | Result |
|---|---|---|---|
| 1 | Greeting does not create task | `router.test.ts` R1, `chatAndTasks` | COVERED |
| 2 | General questions do not create task | `router.test.ts` R2 | COVERED |
| 3 | Technical questions use appropriate agent | `router.test.ts` R2/R7 + `selectAgentsForChat` | COVERED |
| 4 | Advice does not auto-authorize execution | `router.test.ts` R3 + `chatAndTasks` no auto-task | COVERED |
| 5 | Project members discoverable independent of participation | `conversations.test.ts` registry views | COVERED |
| 6 | Asking about agent returns registry info | **GAP** — no test asks "who is X?" / capability lookup via registry | GAP → add `validation-integration` #6 |
| 7 | Consulting agent does not create execution task | `chatAndTasks` + router R3 | PARTIAL → add explicit integration (#7) |
| 8 | Orchestrator not forced to answer every conversation | `chat.ts:221` role regex + `ROADMAP` non-orchestrator fix | **GAP** — no test pins non-orchestrator persona (backend chat not in convex-test) |
| 9 | Simple tasks do not generate unnecessary DAGs | `phase6Progressive.test.ts` A (1 node, direct, zero review/QA) | COVERED |
| 10 | Complex tasks delegate only when necessary | `delegation.test.ts` E (selfServe REJECT), `phase6Delegation C` | COVERED |
| 11 | QA/Security/Review conditional | `phase6Progressive B` (risk signal), `decision.test.ts` | COVERED |
| 12 | Multiple providers shared across agents | `llmResolver.test.ts` J | COVERED |
| 13 | Provider failures handled correctly | `llmResolver` fallback, `decision H` | COVERED |
| 14 | Duplicate commands do not duplicate execution | `chat.ts:172` checkAlreadyReplied, `tasks.cancel` idempotency | **GAP** — `checkAlreadyReplied` has no test |
| 15 | Original instructions intact through planning/delegation | `taskRunner.replan` feedback, `buildAgentExecutionContext` originalRequest | PARTIAL → add integration test |
| 16 | Approval required when policy demands it | `planValidator` + `fileChanges.test.ts`, `phase4Runner` | COVERED |
| 17 | Cancellation propagates to child processes | `phase4HardeningRecovery I`, `qaThreading`, `runCommand` signal | COVERED |
| 18 | Recovery does not repeat completed work | `taskRunner.replan F`, `carryForwardState` | COVERED |
| 19 | Read-only tasks do not modify workspace files | `agentExecutor` readOnly prompt + `governance/registry` dry-run | **GAP** — no assertion that readOnly path never calls write path |
| 20 | Task status reflects actual execution state | `evaluator.test.ts` + `securityInvariants` terminal guard | COVERED |

## 3. Failure injection (proposed → existing coverage)

| Failure | Existing | GAP |
|---|---|---|
| LLM timeout | **GAP** — planner fallback exists but no timeout test | add |
| Invalid credentials | `securityInvariants` ciphertext-only; `decryptApiKey` error named | partial → add |
| Provider rate limits | `llmHealth` circuit breaker | COVERED |
| Agent unavailable (offline/disabled) | `capabilities.isAgentAvailable` unit | PARTIAL → add integration |
| Worker crash / restart | `recoverStale` + `queue recoverStaleMessages` | COVERED (backend) |
| Partial execution failure | `phase4Hardening`, `executeQa failed` meta | COVERED |
| Concurrent tasks | `WORKER_CONCURRENCY`, `maxConcurrentLLMCalls` | PARTIAL — no concurrency test asserts claim atomicity |
| Duplicate commands | **GAP** (see #14) | add |
| Cancellation during execution | `phase4HardeningRecovery` | COVERED |
| Cancellation during QA | `runQaLoop` `taskCancelled()` mapping | PARTIAL → pin |
| DB mutation conflicts (savePlan destructive) | `savePlan` vs `upsertDynamic` | PARTIAL → add |
| Missing/corrupted execution context | **GAP** | add |

## 4. Security

| Check | Status |
|---|---|
| API keys never reach frontend | **FAIL (pre-existing)** — `search.global` returns raw agents (incl. `llmApiKey`); `inbox.list` returns raw agents; `integrations.get` spreads doc, masks only `accessToken` last-4, leaks `refreshToken/webhookSecret/config`; `integrations.*` mutators lack `assertProjectAccess` |
| Credentials never in prompts/logs/events/payloads | COVERED worker-side (`maskSecrets`, `redactAuditDetails`), **GAP** backend `any` payloads |
| Agent permissions server-side | PARTIAL — `assertProjectAccess` + membership gate; `messages.send` has no authz before enqueue |
| Cannot bypass Orchestrator/Policy | COVERED worker (selfServe, `routeCapability allowFallback:false`) |
| Workspace/project isolation | COVERED (`resolveSandboxPath`, `validateFilePath`) |
| Untrusted agent outputs cannot override policy | **GAP** — no test with malicious fixed string |
| Approval cannot be bypassed via delegation | COVERED (`planValidator` forces `requiresApproval`; delegation REJECT on selfServe) |

## 5. E2E (Playwright)

Not present. Root + web `package.json` have no `@playwright/test` or e2e script; only `packages/worker` devDep `playwright` for QA screenshots. AGENTS.md: "Do not add Playwright or live-provider tests to the default suite". Recommendation: **skip Playwright**; cover sequence via `convex-test` + worker-mocked integration tests, and manual browser smoke via `smoke` skill. Filing a plan for Playwright would be a **new dependency** (unnecessary infra per brief §7).

## 6. Bugs ranked

- **P0 (security)**: `search.global` / `inbox.list` raw agent leak; `integrations.get` leak + missing access checks.
- **P1**: `chatContext.getContext` history ignores `conversationId` (conversation B prompts conversation A); `insertUser/AgentMessage` accepts mismatched `conversationId` without project check; `ensureForChat` reuses closed conversation.
- **P1**: `registry.tool_call` drops `write_file.content` before governed call.
- **P2**: `completeTask` accepts any status / no workerId check; `tasks.remove` destroys audit trail.
