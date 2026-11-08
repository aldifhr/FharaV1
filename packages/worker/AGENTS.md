# `packages/worker` — task worker

Claims tasks from Convex, plans them, runs the DAG, executes agents, evaluates
results, gates risky actions behind human approval, and reports every state
change back to the backend.

Read the root [`AGENTS.md`](../../AGENTS.md) first.

## Data flow

```
index.ts            bootstrap: dotenv, policy, LLM concurrency, provider-health mirror
services/taskRunner processTask / resumeTask — the single task lifecycle
orchestrator/       classifier → planner → orchestrator plan → evaluator → delegation
context/            compaction (deterministic trigger >40 msgs / >24k chars, budget-gated summarize, prompt builder summary+last12)
scheduler/          dagScheduler — ready-set selection, per-agent gates
execution/          agentExecutor, qa, verification, repositoryContext
effects/llmCall     worker-wide + per-task LLM gates, one AbortController per task
llm/                resolver (priority → weighted → modelPatterns), health (circuit breaker), crypto
tools/              sandbox, runCommand, readFile, writeFile, gitDiff, github, liveBrowser, webClient
governance/         tools (policy + audit + redaction) + registry (tool_search/describe/call, supportedTools scope)
```

Anything that changes task state goes through `WorkerApi` (`src/workerApi.ts`)
into a `worker.ts` action. Do not call the Convex HTTP API directly and do not
import backend internals.

## Orchestrator contract

- `policy.ts#loadPolicy()` is the only place execution limits are read. Add a
  knob there with `intFromEnv` / `boolFromEnv` (with min/max), then read it from
  `ExecutionPolicy`. Do not scatter `process.env` reads through the runner.
- The orchestrator is authoritative by default (`ORCHESTRATOR_AUTHORITATIVE`).
  Its `ExecutionPlan` is the plan that runs; the planner is a subroutine. Do not
  add a second routing path or a second planner call.
- Decisions are `APPROVE | REJECT | REVISE | COMPLETE | BLOCKED` in the
  evaluation layer, and `execute | delegate | parallel | replan | complete |
  ask_user` in the decision engine (`orchestrator/decision.ts`). The engine
  is the only orchestrator path (since plan 013 step 7; flag deleted), maps
  each observation to a validated request; `APPROVE` may spawn a delegation
  subtask, `REVISE` may spawn a fix subtask with structured findings,
  `BLOCKED` halts new scheduling without killing completed work. A refused
  request is a recorded `orchestrator.decision_fallback`, never a bypass. The
  engine terminates on `maxDecisionSteps` (`ORCHESTRATOR_MAX_DECISION_STEPS`,
  default 20): a step-limit hit fails the task explicitly, never a replan. The LLM advisor (`ORCHESTRATOR_DECISION_LLM`,
  default `ambiguous`) is consulted on ambiguous proposals and unmet objectives; deterministic
  policy rejections always win. Completed work is judged by
  `evaluateObjective` — a `complete` decision with unmet explicit outcomes
  (`recovery` / `policy:budget` / `decision:step_limit`) is converted to a
  replan or a question, never a silent done.
- Dynamic subtasks must be persisted (`upsertDynamicSubtasks`) so recovery keeps
  them. In-memory-only plan mutation is a bug.
- Review/QA nodes are conditional (plan 005 Phase 3): `reviewMode` / `qaMode`
  (`ORCHESTRATOR_REVIEW_MODE` / `ORCHESTRATOR_QA_MODE`, default `"auto"`) decide
  when `applyPlanningHints` adds them — a risk signal (auth/security/payments/
  migrations/concurrency, multi-domain, multi-capability) or a verification
  request/URL. There is no always-review/always-QA pipeline anymore; `"always"`
  restores the legacy mandate for one knob at a time.
- Delegation is bounded: `maxDelegations` (task-wide count) and
  `maxDelegationDepth` (chain depth). Circular delegation must stay rejected.
- A failing QA node is corrected by the runner itself, not by a full replan:
  `runQaLoop` spawns a `fix_qa_<n>` subtask carrying the QA checks as findings,
  applies its staged files (skipped in `ask` mode so the approval gate stays
  authoritative), re-runs the same QA nodes, and is bounded by
  `maxReviewIterations`. The same bound governs the review loop.
- Replanning carries matching completed work forward (`carryForwardState`):
  a completed `code_change` with the same kind/capability/description keeps its
  `priorOutputs` and file changes and is not re-executed. Only `feedback` is
  cleared.
- Plan 006 Phase 3 context isolation: `context/compaction.ts` owns task vs
  chat isolation (`buildTaskPrompt` / `buildChatPrompt`), the deterministic
  compaction trigger (>40 messages or >24k chars), the budget-gated summary
  LLM call (`compactIfNeeded`), and the bounded prompt builder
  (summary + last 12). The worker persists summaries via the backend
  `contextSummaries` table; the chat prompt builder replaces the raw
  last-12 history in `chatContext.getContext`.
- Plan 006 Phase 4 durable queue: worker claims pending messages with
  `claimNextMessage` (same lease pattern as tasks: `leasedBy` /
  `leaseExpiresAt`), `completeMessage` / `failMessage` transition,
  `retryMessage` / `cancelMessage` / `recoverStaleMessages` bound retries
  to 3 attempts. `agentExecutor` delegation proposals write the addressed
  message row (`appendAgentMessage` + `recordDelegation`).
- Plan 006 Phase 5 tool registry: `governance/registry.ts` exposes
  `tool_search` / `tool_describe` / `tool_call`; the calling agent's
  `supportedTools` is the search scope. Wired for `research`/`audit`
  first behind `ORCHESTRATOR_TOOL_LOOP` (default `false`); `code_change`
  unchanged. Every call audits, secret-shaped args are redacted, sandbox
  and argv allowlist are unchanged.

## Budget and cancellation

- `BudgetTracker` (`orchestrator/budget.ts`) counts LLM calls, tokens, and agent
  diversity. The pre-call gate must run **before** the request. `budgetMode`
  defaults to `"warn"`; only `enforce` hard-stops. Do not change the default
  without a plan.
- One `AbortController` per task carries both user cancel and the task deadline.
  Thread `signal` into LLM calls, QA, commands, and verification. A new async
  call that ignores the signal is a defect.
- Retry only transient failures and respect the deadline and budget veto. Never
  add a blanket retry loop around a provider call.

## Tools and sandbox

- Every path goes through `resolveSandboxPath(workspaceRoot, requested)`. It
  rejects absolute paths and `..` escapes. Do not resolve paths by hand.
- `runCommand` allows exact argv pairs only (`npm run test`, `git status`,
  `git diff --stat`, …). Do not add prefix matching; `npm run test; rm -rf /`
  would pass one.
- Risky actions (`apply_changes`, `git_push`, `run_command`, `merge_pr`) must
  request approval before executing and must re-check the approval result after
  the wait. Waiting out `approvalTimeoutMs` means "not approved".
- A tool must not write outside the workspace, and must not read `.env`,
  credential files, or another task's workspace.

## Providers

- Credentials arrive as ciphertext and are decrypted locally (`llm/crypto.ts`).
  A mismatch with the backend key fails with an explicit error — do not fall
  back to a plaintext or env key silently.
- Selection order: priority → weighted among equals → `modelPatterns` filter →
  provider health (circuit breaker) → fallback chain. Do not hardcode a model.
- Provider-health reports are best-effort: a failed report must never fail the
  provider call.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONVEX_SERVICE_TOKEN` | — | Must match the deployment; fails closed when unset |
| `PROVIDER_ENCRYPTION_KEY` | — | Must match the deployment |
| `WORKER_CONCURRENCY` | 2 | Tasks in flight |
| `WORKER_POLL_INTERVAL_MS` | 1500 | Claim loop cadence |
| `WORKER_HEARTBEAT_MS` | 10000 | Lease heartbeat |
| `WORKER_LEASE_MS` | 60000 | Claim lease |
| `WORKER_STALE_GRACE_MS` | 30000 | Stale-task recovery grace |
| `ORCHESTRATOR_*` | per `policy.ts` | Bounds, timeouts, budget mode, authority |
| `ORCHESTRATOR_DECISION_ENGINE` | — | **Deleted** (plan 013 step 7): the decision engine is the only path; the env var is no longer read. |
| `ORCHESTRATOR_DECISION_LLM` | `ambiguous` | `off` / `ambiguous` / `always` — when the LLM decision advisor is consulted |
| `ORCHESTRATOR_MAX_DECISION_STEPS` | `20` | Decision-step bound per task run |
| `ORCHESTRATOR_REVIEW_MODE` / `ORCHESTRATOR_QA_MODE` | `auto` | `always` / `auto` / `never` — when planning adds review/QA nodes |
| `ORCHESTRATOR_MCP_TOOL_LOOP` | `true` | Read-only agents may use discovered MCP tools mid-task |
| `ORCHESTRATOR_MCP_WRITE_TOOLS` | `false` | Expose write/move MCP tools to developers (delete stays denied) |
| `ORCHESTRATOR_MCP_MAX_TOOL_ITERATIONS` | `6` | Bound on tool-loop rounds per subtask |
| `ORCHESTRATOR_MCP_TIMEOUT_MS` | `30000` | Per-MCP-request timeout; a hung server is killed |
| `ORCHESTRATOR_MCP_MAX_RESULT_CHARS` | `8000` | Cap on a tool result before it reaches the LLM |
| `WORKER_LLM_MAX_CONCURRENCY` | from policy | Worker-wide LLM gate (set once) |

The worker loads the root `.env` (`../../.env` from `packages/worker`).

## Tests

Vitest, pure unit/integration — no Convex deployment, no live provider.

```
npm test                                              # whole worker suite
npx --workspace=@moagent/worker vitest run tests/orchestrator.test.ts
```

Existing suites: `orchestrator`, `delegation`, `budget`, `taskContext`,
`planner`, `planValidator`, `dagScheduler`, `reviewLoop` (+ integration),
`verification`, `sandbox`, `runCommand`, `evaluator`, `classifier`,
`capabilities`, `fileChanges`, `llmCall`, `chatAndTasks`, and the `phase4`/`phase5`
hardening suites.

- A policy change must update `POLICY` fixtures in the affected tests.
- Add a test for the invariant you changed, not for the implementation detail.
- Do not assert elapsed time; wait for a promise, event, or state.
- Do not add a live-provider or Playwright test to the default suite.
