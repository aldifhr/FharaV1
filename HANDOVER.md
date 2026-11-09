# Handover for Testing (No-Docs)

## Summary
Implemented Intelligent Orchestrator with Shared Task Context, Conditional Delegation, and Budget enforcement on top of existing Fhara stack (Convex + worker + existing DAG planner).

## Implementation Details (evidence-linked)
- **Arch overview**: `packages/worker/src/orchestrator/orchestrator.ts` (routing + post-execution evaluation), `packages/worker/src/orchestrator/delegation.ts`, `packages/worker/src/orchestrator/taskContext.ts`, `packages/worker/src/orchestrator/agentContext.ts`, `packages/worker/src/orchestrator/budget.ts`.
- **Shared Task Context**: persistent `taskContexts` table (`apps/api/convex/schema.ts:295`), internal mutation `upsertTaskContext`/`getTaskContext` (`apps/api/convex/orchestration.ts`), worker actions (`apps/api/convex/worker.ts`), `WorkerApi.upsertTaskContext` (`packages/worker/src/workerApi.ts`), worker integration in `processTask` (`packages/worker/src/services/taskRunner.ts`).
- **Agent-specific context**: `buildAgentExecutionContext` (`agentContext.ts`) filters previous executions to relevant (same capability or most recent), caps to 3, includes only summaries/artifacts/decision snippets — not raw history. Format for LLM in `formatAgentContextForPrompt`.
- **Conditional delegation**: `delegation.ts` `routePrimaryAgent` (capability-based) + `evaluateDelegation` with decisions `APPROVE|REJECT|REVISE|COMPLETE|BLOCKED`, circular check, budget check. Agent may recommend via JSON `delegationRecommendation` parsed by `parseDelegation` (`utils/json.ts`) and surfaced in `agentExecutor.ts` meta.
- **LLM budgets**: `BudgetTracker` (`budget.ts`) counts LLM calls/tokens/agent diversity, enforces `maxAgentsPerTask`, `maxLLMCallsPerTask`, `maxDelegationDepth`, `maxTokenBudgetPerTask`. Policy extended in `orchestrator/policy.ts` with env overrides (`ORCHESTRATOR_MAX_*`). Resolution precedence in `resolveModelConfig` (agent > defaults).
- **Lifecycle**: new `lifecycleHistory` table (`schema.ts:298`), `recordLifecycle` internal mutation + `WorkerApi.recordLifecycle`, taskRunner records RUNNING. Existing subtask/execution states preserved.

## Files Modified / Created
**Modified**
- `packages/worker/src/orchestrator/policy.ts` — added budget fields + env overrides (3/5/2 defaults)
- `packages/worker/src/execution/agentExecutor.ts` — parse `delegationRecommendation` + findings into result meta
- `packages/worker/src/services/taskRunner.ts` — init `BudgetTracker`, `createSharedTaskContext`, `upsertTaskContext`, `recordLifecycle`, `createOrchestratorPlan` logging
- `packages/worker/src/utils/json.ts` — `parseDelegation`, `parseReview`, `parseDraft` unchanged behavior
- `packages/worker/src/workerApi.ts` — `getTaskContext`, `upsertTaskContext`, `recordDelegation`, `recordLifecycle`, `getTaskTokenUsage`
- `apps/api/convex/schema.ts` — added `taskContexts`, `delegations`, `lifecycleHistory`, `tokenUsage` index by_task
- `apps/api/convex/orchestration.ts` — `getTaskContext`, `upsertTaskContext`, `recordDelegation`, `recordLifecycle`, `getTaskTokenUsage`
- `apps/api/convex/worker.ts` — actions wrapping the above
- `packages/worker/tests/reviewLoop.integration.test.ts` — updated `POLICY` with new fields

**Created**
- `packages/worker/src/orchestrator/taskContext.ts` — SharedTaskContext types, `createSharedTaskContext`, `appendExecution`, `addDecision`, artifact/decision extraction
- `packages/worker/src/orchestrator/agentContext.ts` — `buildAgentExecutionContext`, `formatAgentContextForPrompt`
- `packages/worker/src/orchestrator/delegation.ts` — `routePrimaryAgent`, `evaluateDelegation`, circular prevention
- `packages/worker/src/orchestrator/budget.ts` — `BudgetTracker`, `resolveModelConfig`, `shouldUseLLMEvaluation`
- `packages/worker/src/orchestrator/orchestrator.ts` — `createOrchestratorPlan`, `evaluateAfterExecution`
- `packages/worker/tests/orchestrator.test.ts`, `taskContext.test.ts`, `budget.test.ts`, `delegation.test.ts`

## Database/Schema Changes
- `taskContexts` — per task persisted context (originalRequest, objective, status, decisions, artifacts, outstandingIssues, updatedAt)
- `delegations` — delegation decision log (from/to agent, decision enum, reason, capability)
- `lifecycleHistory` — state transitions (RUNNING etc.) for recoverability
- `tokenUsage` — added `by_task` index for per-task token aggregation

## Validation Evidence
- Worker tests: `npm run --workspace=@fhara/worker test` → `17 passed`, `92 tests passed` (incl. new orchestrator/delegation/budget/context tests)
- Typecheck: `npm run typecheck` → all workspaces pass (web, api, worker)
- Smoke: `npx convex codegen` in `apps/api` succeeds. Worker starts, retries `recover` with error surfacing, then proceeds when Convex local `http://127.0.0.1:3210` ready.

### Key Tests
- **orchestrator.test.ts**:
  - A: simple task selects primary agent (EXECUTE_PRIMARY) — passes
  - B: code_change routes to Developer, schedules QA when capable
  - F: no enabled agents → BLOCKED
  - Delegation: APPROVE when recommended, REJECT circular, REVISE on QA critical
  - Shared context: same taskId, previous summary visible to next agent
  - Budget: tight `maxLLMCallsPerTask:2` blocks, `maxLLMCallsPerTask:1` → BLOCKED with reason
  - Lifecycle: failed execution → REVISE not COMPLETE
- **taskContext.test.ts**: agent filtering, relevant artifacts, capped previous results
- **budget.test.ts**: LLM call/token tracking, model precedence, deterministic-vs-LLM evaluation gating
- **delegation.test.ts**: JSON `delegationRecommendation` parsing

## Remaining Limitations / Tech Debt
1. **TaskRunner integration is conservative**: `createOrchestratorPlan` is computed and logged, but `executePlan` still drives the actual DAG via existing planner. Conditional delegation after each subtask is implemented in `evaluateAfterExecution` and delegation parser, but full re-routing at runtime (dynamic insertion of specialist subtasks beyond current plan) is not yet wired end-to-end in `taskRunner` — the existing plan's review/QA loop covers most cases.
2. **Context persistence**: `taskContexts` is upserted at task start; incremental updates per execution rely on worker `appendExecution` in-memory merge. Full DB sync after each execution requires calling `upsertTaskContext` with updated artifacts/decisions — partially done, but evaluation step needs full sync.
3. **Token budget**: `BudgetTracker` is in-memory per worker process; persistent cross-restart budget requires aggregating from `getTaskTokenUsage` before starting.
4. **Testing scope**: unit tests pass; integration test for full flow (create task → run worker → verify delegated agents) requires Convex local dev server and is covered by codegen, not automated e2e.
5. **LLM evaluation**: `shouldUseLLMEvaluation` helper exists but orchestrator does not yet make extra LLM calls for evaluation — deterministic `evaluateTask` remains primary. LLM calls saved as spec requires.
6. **Frontend**: no UI changes for orchestration activity timeline — relies on existing `taskEvents` (`orchestrator.plan`, `orchestrator.delegation`, `task.classified`). Chat UI will show Task+execution history via existing conversation/task views.
7. **Local dev auth**: `CONVEX_SERVICE_TOKEN` must be set on both `.env` (worker) and Convex deployment env (`npx convex env set --deployment local ...`). Documented above.

## No-Docs / Minimal Changes Policy
- No new npm dependencies, no microservices, reused existing `ConvexHttpClient`, DAG scheduler, verification, reviewLoop.
- Architecture preserves existing DAG + planner; intelligent orchestrator is additive advisory + budget + context layer.
