# `packages/worker` — task worker

Claims tasks from Convex, plans them, runs the DAG, executes agents, evaluates
results, gates risky actions behind human approval, and reports every state
change back to the backend.

Read the root [`AGENTS.md`](../../AGENTS.md) first.

## Data flow

```
index.ts            bootstrap: dotenv, policy, LLM concurrency, provider-health mirror
services/taskRunner processTask (setup → plan → bounded replan loop); re-exports resumeTask
services/runner/    planning (initial plan), replan (replanOnce), executePlan (stage driver),
                    runContext, applyStage (approval/broker/worktree), resume, session
                    (budget gate, usage sink), terminal (task endings), abort, review/QA/verify loops
orchestrator/       classifier → planner → orchestrator plan → evaluator → delegation
scheduler/          dagScheduler — ready-set selection, per-agent gates
execution/          agentExecutor, agentContext, qa, verification, repositoryContext, nativeProvider
tools/              sandbox, runCommand, readFile, gitDiff, gitWorktree, gitPush, githubPr, webClient
mcp/                MCP client/registry/permissions/tool loop
effects/llmCall     worker-wide + per-task LLM gates, one AbortController per task
llm/                resolver (priority → weighted → modelPatterns), health (circuit breaker), crypto
governance/         tools (policy + audit + redaction) + registry (tool_search/describe/call, supportedTools scope)
context/            compaction (deterministic trigger >40 msgs / >24k chars, budget-gated summarize)
prompts/            ALL LLM prompt text, as named builders (planner, decision, codeChange, review, ...)
types/              domain types split by domain (agent, plan, subtask, task, execution, qa, llm, events)
utils/              pure helpers (json, draft parsing, ownership paths, capability resolution, ...)
```

Layering (enforced by `tests/layering.test.ts`): a module imports only from
its own layer or a lower one — types/prompts/utils ← llm/effects/governance/
context/workerApi ← tools/mcp ← execution ← orchestrator/scheduler/router ←
services ← index. Prompt wording lives only in `src/prompts/`; shared types
only in `src/types/`. Test fixtures: `tests/helpers/`.

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
- Review/QA nodes are conditional (plan 005 Phase 3): `reviewMode` defaults to
  `"auto"` (risk signal: auth/security/payments/migrations/concurrency,
  multi-domain, multi-capability). `qaMode` defaults to `"auto"` with
  tightened triggers: browser QA runs only when changes were APPLIED, the
  project is browser-runnable (QA/dev URL, `dev`/`start` script, or a root
  `index.html`), AND the change touches UI (frontend/design work or UI paths)
  or the user explicitly asks for QA / e2e / browser testing ("unit tests"
  alone does not count). `"never"` removes QA everywhere (LLM plans,
  heuristic plans, browser-testing delegation); `"always"` adds it to every
  code change.
- Stage order after apply: verification loop → QA loop → worktree
  commit/merge → final decision boundary → acceptance stage (plan 022) →
  requirement coverage check (plan 025). None of these is gated on QA.
- Plan 025: requirements come from the request at plan time (planner
  JSON `requirements` in the same call, deterministic fallback
  `extractRequirementsFallback`); every subtask maps to `requirementIds`.
  `runner/coverage.ts` runs `computeRequirementCoverage` before "done": a
  requirement with no subtask or no passing evidence is a bounded replan
  (`Requirements not covered: …`), and with no replan left the task ends
  "completed with gaps" = status `failed` + `requirementCoverage.outcome`.
  `DecisionObservation.observations` carries typed `ExecutionObservation`s
  (`@/api/convex/lib/observations`); the backend derives and stores the
  same observations from events (`executionObservations`).
- QA outcomes: `passed`; `failed` (app defect → at most
  `ORCHESTRATOR_QA_MAX_FIX_ITERATIONS`, default 1, fix round, routed to the UI
  owner with its `allowedPaths`; in ask mode the fix is put up for approval);
  `blocked` (environment: no Chromium, missing `node_modules`, no dev script,
  not browser-runnable) → one "QA skipped" note, never a fix loop, and the
  task can still complete unless `ORCHESTRATOR_QA_REQUIRED=1`.
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

## OpenCode runtime

Subtasks run on one of two runtimes (`execution/nativeProvider.ts`,
`agentExecutor.ts` → `executeNativeProvider`):

- `api` (default): the agent's LLM drives Fhara's own host tools.
- OpenCode (`native-provider`): `opencode run --format json --auto [-m model]
  <message> -f prompt.md` runs in the task worktree with OpenCode's own tools.

Selection: the agent row's `executionRuntime` (`api` | `opencode`, edited in the
web agent form) overrides the global `ORCHESTRATOR_EXECUTION_RUNTIME`
(`resolveExecutionRuntime`). QA and review nodes always use the API path. When
the CLI is missing (availability is probed once per process), the subtask falls
back to the API path with a `native.runtime.unavailable` warning.

Model: the agent's `opencodeModel` (`provider/model`) is passed as `-m` and uses
OpenCode's own credentials. Without it, a temporary `OPENCODE_CONFIG` (0600,
deleted after the run) defines a `fhara` provider (`@ai-sdk/openai-compatible`
or `@ai-sdk/anthropic`) on the agent's resolved Fhara LLM, and the run is
pinned to `fhara/<model>`. The key is referenced as
`{env:MOAGENT_OPENCODE_API_KEY}` and passed only in the child env — never in
argv, the config file, events, or logs (outputs are redacted).

Safety: the generated config denies `external_directory`, `question`, `.env`
reads, and `git push`/`git remote`. The run is pinned to the worktree with
`--dir` and `PWD` (OpenCode prefers `$PWD` over the spawn cwd). stdin is closed
(an open pipe makes `opencode run` hang). The run has a wall-clock limit
(`ORCHESTRATOR_NATIVE_TIMEOUT_MS`, default 10 min); timeout or abort kills the
whole process tree. Afterwards every changed path is gated: in-scope changes of
`code_change`/`shell` subtasks are staged through the normal diff/approval
pipeline (deletions included); forbidden paths, paths outside `allowedPaths`,
and any write by a read-only subtask are reverted to their pre-run content
(`native.change.rejected`). Events: `native.run.started`, `native.tool`
(tool name/status/target only), `native.run.finished` (tokens, exit, timeout);
text streams through `onChunk`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONVEX_SERVICE_TOKEN` | — | Must match the deployment; fails closed when unset |
| `PROVIDER_ENCRYPTION_KEY` | — | Must match the deployment |
| `WORKER_CONCURRENCY` | 1 | Tasks in flight (sequential by default) |
| `WORKER_POLL_INTERVAL_MS` | 1500 | Claim loop cadence |
| `WORKER_HEARTBEAT_MS` | 10000 | Lease heartbeat |
| `WORKER_LEASE_MS` | 60000 | Claim lease |
| `WORKER_STALE_GRACE_MS` | 30000 | Stale-task recovery grace |
| `ORCHESTRATOR_*` | per `policy.ts` | Bounds, timeouts, budget mode, authority |
| `ORCHESTRATOR_DECISION_ENGINE` | — | **Deleted** (plan 013 step 7): the decision engine is the only path; the env var is no longer read. |
| `ORCHESTRATOR_DECISION_LLM` | `ambiguous` | `off` / `ambiguous` / `always` — when the LLM decision advisor is consulted |
| `ORCHESTRATOR_MAX_DECISION_STEPS` | `20` | Decision-step bound per task run |
| `ORCHESTRATOR_REVIEW_MODE` | `auto` | `always` / `auto` / `never` — when planning adds review nodes |
| `ORCHESTRATOR_QA_MODE` | `auto` | `always` / `auto` / `never` — when browser QA runs (auto: applied UI changes in a browser-runnable project, or an explicit QA/e2e request) |
| `ORCHESTRATOR_QA_MAX_FIX_ITERATIONS` | `1` | Automatic QA fix rounds (separate from review) |
| `ORCHESTRATOR_QA_REQUIRED` | `false` | When true, an environment-blocked QA run fails the task instead of being reported as skipped |
| `QA_STARTUP_TIMEOUT_MS` | `90000` | How long QA waits for the auto-started dev server |
| `QA_CHROMIUM_PATH` | — | Chromium executable for QA (fallback `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`, then Playwright's bundled browser). Use on linux-arm64, where Playwright's CDN has no build |
| `QA_CHROMIUM_NO_SANDBOX` | auto | `1` adds `--no-sandbox`; it is also added automatically when running as root or inside a container (`/.dockerenv`). `0` disables it |
| `ORCHESTRATOR_MCP_TOOL_LOOP` | `true` | Read-only agents may use discovered MCP tools mid-task |
| `ORCHESTRATOR_MCP_WRITE_TOOLS` | `false` | Expose write/move MCP tools to developers (delete stays denied) |
| `ORCHESTRATOR_MCP_MAX_TOOL_ITERATIONS` | `6` | Bound on tool-loop rounds per subtask |
| `ORCHESTRATOR_MCP_TIMEOUT_MS` | `30000` | Per-MCP-request timeout; a hung server is killed |
| `ORCHESTRATOR_MCP_MAX_RESULT_CHARS` | `8000` | Cap on a tool result before it reaches the LLM |
| `WORKER_LLM_MAX_CONCURRENCY` | from policy | Worker-wide LLM gate (set once) |
| `ORCHESTRATOR_EXECUTION_RUNTIME` | `api` | Global runtime default: `api` or `opencode` (alias `native-provider`); legacy `ORCHESTRATOR_RUNTIME` still read. A per-agent `executionRuntime` overrides it |
| `ORCHESTRATOR_NATIVE_PROVIDER_COMMAND` | `opencode` | OpenCode CLI binary |
| `ORCHESTRATOR_NATIVE_TIMEOUT_MS` | `600000` | Wall-clock limit per OpenCode run; the process tree is killed on expiry |

The worker loads the root `.env` (`../../.env` from `packages/worker`).

### Browser QA setup

QA drives a real Chromium through Playwright. Install the browser once per
worker machine/image:

```
cd packages/worker && npx playwright install chromium   # add --with-deps on Debian/Ubuntu images
```

Playwright's CDN has no linux-arm64 Chromium build. There, install a system
Chromium (e.g. Debian's `chromium` package) and point QA at it with
`QA_CHROMIUM_PATH=/path/to/chromium`. Without a browser, QA reports
"QA skipped: Chromium is not installed" and the task still completes (unless
`ORCHESTRATOR_QA_REQUIRED=1`).

## Tests

Vitest, pure unit/integration — no Convex deployment, no live provider.

```
npm test                                              # whole worker suite
npx --workspace=@fhara/worker vitest run tests/orchestrator.test.ts
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
