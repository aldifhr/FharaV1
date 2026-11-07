# Plan 006: Intelligent, context-aware, decision-driven multi-agent platform

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`. Supervision: the 41
> scenario wording comes from the platform brief (not in this repo). Phase 0
> maps those scenarios 1:1 onto the test clusters in this plan; any brief item
> with no cluster is added before Phase 1 starts.

## Status

- Priority: P1
- Size: L (worker + backend, plus one UI queue change; additive schema only)
- Risk: HIGH (touches the orchestrator/planner contract, the chat entry point,
  and the tool boundary)
- Dependencies: none. Supersedes plan 005 (its decision-engine content is
  adopted verbatim as Phase 2; see "Decision" below).
- Planned at: `main` @ `b55b7d6`, 2026-11-07

## Why this is needed

MOAgent today has two entry points that each guess intent independently, and
neither of them is the intent layer. The UI composer sends text to a Convex
action that matches implementation keywords with a regex and auto-creates a
task row (`apps/api/convex/chat.ts:12-21`, `223-249`); the worker then
classifies the same command again with a *different*, richer deterministic
classifier (`packages/worker/src/orchestrator/classifier.ts:17-94`). A question
containing the word "test" becomes a task. A task goes through a plan-first,
always-review, always-QA pipeline (plan 005's audit). There is no persistent
agent message queue (the composer queue in `apps/web/components/ChatPanel.tsx:289-297`
is client-side state that vanishes on reload), no conversation/thread model
(`apps/api/convex/schema.ts:214-226` — one flat `messages` table), no context
compaction or retrieval (`apps/api/convex/chatContext.ts:89-93` — last 12
non-task messages, raw), and no tool discovery (`packages/worker/src/governance/tools.ts:306`
— `resolveTools()` returns `{}`).

This plan turns the existing system into a platform with one intent entry
point, decision-driven orchestration, isolated contexts, a durable queue, and
a governed tool registry — without rebuilding the scheduler, provider pool,
or policy authority that already work.

## Target behaviour

| Situation | Today | After |
| --- | --- | --- |
| "How do I …?" / advice request | auto-creates a task if an impl keyword matches | answered in chat; no task row, no agent execution |
| "Fix the login button" | task created by regex, then always review + QA DAG | router routes to one developer, decision loop decides what else is needed (plan 005) |
| Greeting / small talk | task if the text happens to contain a keyword | routed to chat, answered by the lead agent |
| Reload the browser mid-queue | queued composer items are gone | queue is durable; pending items survive reload and worker restart |
| Long conversation (200 turns) | last 12 raw messages, unbounded agent replies | conversation context compacted; retrieval pulls older scope on demand |
| Agent needs an action mid-task | hardcoded JSON protocol per subtask kind | agent discovers tools via `tool_search`/`tool_describe`, calls via `tool_call` through governance |
| Agent-to-agent handoff | implicit in DAG order | explicit persisted message, addressed to an agent or capability, logged |

## Current state

Entry and routing:

- `apps/api/convex/messages.ts:31-49` — `send` inserts a user message and
  schedules `replyToChat` with `runAfter(0)`. No queue, no ordering, no retry.
- `apps/api/convex/chat.ts:12-21` — `classifyChatIntent`: keyword regexes;
  impl keywords force `kind: "task"`. `223-249` — auto-dispatch calls
  `tasks.createFromCommand` and returns.
- `apps/api/convex/chat.ts:49-124` — `completeWithAgent` fetches the provider
  directly (OpenAI/Anthropic HTTP). This path records no `tokenUsage`, runs
  no budget gate, and bypasses provider health — it is a second LLM pipeline
  outside the worker's gates.
- `apps/api/convex/chatContext.ts:52-113` — `getContext` selects preferred
  agents or a single lead (regex on role, `76-79`), returns the last 12
  non-task messages (`89-93`). No compaction, no retrieval, no thread scope.
- `packages/worker/src/orchestrator/classifier.ts:17-94` — the worker's own
  deterministic classifier (conversation/audit/research/multi/code_change).
  Different vocabulary from `classifyChatIntent`; the two never agree on
  boundary cases.

Execution (see plan 005 for the full audit — adopted, not repeated):

- `packages/worker/src/orchestrator/planner.ts:199-246` — `ensureRequiredSubtasks`
  forces review on every code change and QA whenever a QA agent exists.
- `packages/worker/src/orchestrator/orchestrator.ts:335-399` — one authoritative
  plan; the orchestrator's own step list is advisory.
- `packages/worker/src/orchestrator/delegation.ts:87-` — deterministic-only
  delegation evaluation; `shouldCallLLM` is `false` on every path.
- `packages/worker/src/execution/agentExecutor.ts:106-142` — dispatch by
  subtask kind; `executeCodeChange` (`175-318`) speaks a JSON file-change
  protocol. There is no function-calling tool loop.
- `packages/worker/src/governance/tools.ts:306` — `resolveTools()` returns
  `{}`. Governance (path validation, secret redaction, audit) exists but no
  agent ever calls it through a registry. Agents carry `capabilities`,
  `skills`, `supportedTools` in the schema (`apps/api/convex/schema.ts:101-103`)
  and `routeCapability` already scores them
  (`packages/worker/src/orchestrator/capabilities.ts:85-134`).

Persistence and UI:

- `apps/api/convex/schema.ts:214-226` — `messages`: `projectId`, optional
  `taskId`/`agentId`, `authorType` user|agent, `content`, `subtaskKey?`,
  `executionId?`, `replyToMessageId?`. No thread, no session, no queue status.
- `apps/api/convex/schema.ts:334-349` — `taskContexts` (shared task context,
  persisted decisions) already exists and is the orchestrator-decision scope.
- `apps/api/convex/tasks.ts:50-125` — `createFromCommand` appends a
  conversation-context block for short commands.
- `apps/web/components/ChatPanel.tsx:289-297` — `sendAllQueued` dispatches
  client-side, sequentially, through `messages.send`.

## What is already right and must be preserved

| Mechanism | Where | Why it stays |
| --- | --- | --- |
| Central orchestrator authority | `orchestrator.ts:335-399`, `packages/worker/AGENTS.md` | one planning authority; the router routes *to* it, never around it |
| Provider pool + per-agent override | `llm/resolver.ts`, `planner.ts:77-84` | shared pool; no per-agent keys, ever |
| Pre-call budget gate | `budget.ts`, `taskRunner.ts` | non-negotiable #6; the router and advisor both sit behind it |
| One `AbortController` per task | `taskRunner.ts` (see plan 005) | cancellation/deadline model |
| Terminal-status guard | `orchestration.completeTask` | non-negotiable #3 |
| Approval gate | `taskRunner.ts` review/apply path | non-negotiable #5 |
| Tool sandbox + exact-argv allowlist | `tools/sandbox.ts`, `tools/runCommand.ts` | non-negotiable #4; the registry calls these, it does not replace them |
| Dynamic subtask persistence | `taskRunner.ts` (see plan 005) | recovery keeps the DAG |
| Worker token gate | `apps/api/convex/worker.ts`, `authz.ts` | non-negotiable #2; every new worker-facing function keeps `...tokenArg` |
| Capability scoring | `capabilities.ts:85-134` | the router's multi-agent selection builds on this, not a new matcher |

## Decisions that must not change during execution

- The orchestrator remains the single execution authority. The router decides
  *where a message goes* (chat vs task vs queue); it never produces a plan.
- CTO is the default orchestrator agent, never a mandatory participant. The
  router selects by capability, not by fixed pipeline (CTO → Developer → QA).
- No per-agent credentials, no new required provider configuration.
- Schema changes are additive `v.optional` only (AGENTS.md rule 7). No
  destructive migration.
- The chat LLM path gets *less* privileged, never more: whatever replaces
  `completeWithAgent` runs behind budget, usage, and health, or the phase stops.
- Review/QA become conditional (plan 005), never removed without a policy flag
  restoring them.
- No speculative features: no vector DB, no embeddings, no memory service
  (plan 001 owns memory), no new dependency. Retrieval is index queries over
  `messages`/`taskContexts`; "semantic" retrieval is explicitly out.

## Proposed architecture

### 1. Intent/context router (before the orchestrator)

One router, called from the queue worker (Phase 4 moves it off the Convex
action). Input: message text + conversation scope + agent capabilities.
Output: `chat | task | question | advice | research | audit | ambiguous`.

- Deterministic first: reuse the worker `classifier.ts` vocabulary extended by
  plan 005's decision module — the Convex keyword classifier is deleted, not
  extended.
- `question`/`advice`/`chat` → chat reply by the selected agent(s). **No task
  row is created.** This is the headline behaviour change.
- `task` → `tasks.createFromCommand` (unchanged mutation), worker claims it as
  today.
- `ambiguous` → LLM advisor call, behind the budget gate, same fallback
  discipline as plan 005's decision advisor (garbage output → deterministic
  fallback + event, never a task).
- Agent selection: capability scoring over `routeCapability` with
  `allowFallback: false`; multi-agent replies only when ≥2 agents match
  distinct capabilities (today `chatContext` returns preferred agents or one
  lead; that selection logic moves to the router and is shared with task
  routing).

### 2. Conversation vs task paths

- The queue is the single door. Chat replies and task creation both originate
  from queued messages; explicit "Create task" buttons keep calling
  `createFromCommand` directly (an explicit user act, not a classification).
- Chat replies run in the worker (not the Convex action), so they share the
  provider pool, budget gate, `tokenUsage` recording, and health registry.
  `chat.ts:replyToChat` is removed in the same step; its multi-agent reply
  loop becomes the router's chat branch.

### 3. Context isolation, compaction, retrieval

Five scopes, each with a defined read surface — agents never get "everything":

| Scope | Content | Read via |
| --- | --- | --- |
| Conversation | non-task project messages | last N + compacted summaries |
| Task | objective, decisions, artifacts, open issues | `taskContexts` + `SharedTaskContext` (exists) |
| Agent-working | one subtask's brief + its prior outputs | `buildAgentExecutionContext` (exists) |
| Orchestrator-decision | decisions + budget snapshot | `taskContexts.decisions` (exists) |
| Project/memory | project metadata, agent roster | `projects`/`agents` queries (exists); plan 001 owns memory |

- Compaction: when conversation history exceeds a token/message budget, the
  worker inserts a summary row (new `contextSummaries` table, additive) and the
  prompt uses summary + last N. Trigger is deterministic (turn count), the
  summary call is budget-gated.
- Retrieval: `by_project`/`by_task` indexes already exist; add a scoped query
  (optional `beforeCreationTime` cursor) so an agent can fetch older messages
  explicitly through a tool (Phase 5), never by dumping everything.

### 4. Agent messaging + persistent queue

- `messages` gains optional `queueStatus: "pending" | "sending" | "sent" | "failed"`
  and optional `toAgentId`. A pending message is a durable queue item.
- `messages.send` inserts with `queueStatus: "pending"` and returns; the worker
  claims pending items with the same lease pattern as tasks (claim →
  `sending` → route → `sent`/`failed`). No new scheduler: the existing
  worker poll loop gains one more claim source.
- Agent-to-agent: an agent's delegation proposal references a `messages` row
  with `toAgentId` set (or a capability, resolved by `routeCapability` at
  claim time). It is persisted through the existing internal mutations, so it
  shows in the timeline and survives restarts.
- Controls: retry a failed item, cancel a pending item (new `internalMutation`s
  following the one-transition-per-mutation style rule). The client queue
  (`ChatPanel`) becomes a mirror of the durable queue; it no longer owns state.

### 5. Dynamic tool discovery

- A worker-side registry maps tool names to descriptions + the existing
  governance functions (`validateFilePath`, `runCommand` allowlist check,
  github wrappers, `read_file`/`write_file` from `tools/`).
- Three operations, all behind governance audit:
  - `tool_search(query)` → tools whose name/description matches, limited to the
    calling agent's `supportedTools`/capabilities when declared.
  - `tool_describe(name)` → arg schema + policy notes.
  - `tool_call(name, args)` → the existing implementations, called with the
    caller's `ToolContext`; audit entry recorded (exists in `governance/tools.ts`
    `AuditInput`).
- `agentExecutor` gains an opt-in tool loop for subtask kinds that request it
  (research/audit first); `code_change` keeps its JSON protocol until the loop
  proves itself. The registry never widens the sandbox or the argv allowlist —
  `tool_call` delegates to the same checks.

## Schema deltas (additive only)

| Table | Change | Phase |
| --- | --- | --- |
| `messages` | + optional `queueStatus`, `toAgentId`; + index `by_queue: ["queueStatus", "projectId"]` | 4 |
| `contextSummaries` | new table: `projectId`, `scope`, `upToMessageId?`, `summary`, `createdAt` (+ `by_project`) | 3 |
| `taskContexts` | unchanged (`decisions` is `v.any()`) | — |
| everything else | unchanged | — |

No migration function is needed: new writes populate the new fields; old rows
(read as `undefined`) are `sent` by definition. `verifyMigration` untouched.

## Steps

### Phase 0 — Scenario mapping + baseline

- Map the brief's 41 scenarios onto the test clusters below (R / A–J / C / M /
  T). Record the mapping in this plan's Test plan table. Anything unmapped
  stops here.
- Record `npm run --workspace=@moagent/worker typecheck` output to `TASKS.md`
  (pre-existing red, see plan 005 Step 2.0) and `npm test` green
  (32 files / 222 tests baseline).
- **Check**: `npm test` → green; baseline saved; mapping table filled.

### Phase 1 — Router (Convex side shrinks, worker side grows)

Implemented so far (2026-11-07): `packages/worker/src/router/route.ts`
(deterministic intent routing, injected advisor, fail-closed to chat),
`packages/worker/src/router/selectAgents.ts` (capability-scored selection,
`allowFallback: false`), `tests/router.test.ts` (R1–R7, 17 tests), policy
knobs `ORCHESTRATOR_ROUTER_LLM` (default `off`) and
`ORCHESTRATOR_CHAT_MAX_AGENTS` (default 1). Deliberately **not** yet done:
rewiring the Convex entry point and deleting `chat.ts:replyToChat` /
`completeWithAgent` — that step needs Phase 4's durable queue, because
chat replies must be claimed by the worker with the same lease discipline as
tasks (plan 006 Phase 1 STOP condition: "the queue becomes a second
scheduler" — the queue, not the Convex action, is the door). The Convex
entry-point change is therefore folded into Phase 4; Phase 1's exit
criterion is the router module + tests green, which holds.

- Move the chat entry off `chat.ts:replyToChat`: `messages.send` inserts the
  message and returns (the scheduling moves to Phase 4's queue claim; until
  then, keep a thin `scheduleChat` that calls the same worker entry point).
- Add `packages/worker/src/router/`:
  - `route.ts`: deterministic router on the `classifier.ts` vocabulary,
    producing `chat | task | question | advice | research | audit | ambiguous`.
    `question`/`advice`/`chat` never create a task.
  - `selectAgents.ts`: capability-scored selection via
    `capabilities.ts:routeCapability(..., { allowFallback: false })`;
    multi-agent reply only when ≥2 agents serve distinct capabilities.
  - `advisor.ts`: LLM fallback for `ambiguous` only, behind
    `assertBudgetForCall`, with plan 005's fallback discipline.
- Chat replies run as worker subtask-shaped work (streaming read-only path in
  `agentExecutor:executeReadOnly` already does this) so budget, usage, and
  health apply. `chat.ts:completeWithAgent` is deleted in this phase.
- Policy additions in `policy.ts`: `routerLlmMode: "off" | "ambiguous" |
  "always"` (`ORCHESTRATOR_ROUTER_LLM`, default `"ambiguous"` only after
  tests green), `chatMaxAgents: number` (default 1, max 5).
- **Check**: worker typecheck (no new error vs baseline); `npm test` green;
  new `tests/router.test.ts` covers the R cluster; `tests/chatAndTasks.test.ts`
  updated for the no-auto-task cases (never deleted, only extended).

### Phase 2 — Decision-driven orchestrator (adopts plan 005)

Execute plan 005 Phases 2–5 as written (decision contract, progressive
planning, adaptive delegation, objective evaluation, iterative QA correction,
safe replan), with the router from Phase 1 supplying the classification the
orchestrator consumes. Plan 005's STOP conditions apply here in addition to
this plan's. `ORCHESTRATOR_DECISION_ENGINE` defaults `false` until its
Phase 6 criteria pass.

- **Check**: plan 005's Phase 2–5 checks, verbatim.

### Phase 3 — Context isolation + compaction + retrieval

- Add the `contextSummaries` table + scoped retrieval query
  (`beforeCreationTime` cursor on `by_project`).
- Compaction worker step: deterministic trigger (history > 40 messages or
  > 24k chars), summary LLM call budget-gated, summary row inserted, prompt
  builder uses summary + last 12 (replacing `chatContext.ts:89-93`'s raw
  last-12 in the router path).
- Scope enforcement: `buildAgentExecutionContext` already filters; add a test
  that an agent prompt for a task contains no conversation-only messages and
  vice versa.
- **Check**: `npm run --workspace=@moagent/api typecheck` clean (schema
  changed); `npm run --workspace=@moagent/api test` green; new
  `tests/contextScope.test.ts` (worker) + a `convex-test` case for the cursor
  query.

### Phase 4 — Persistent queue + agent messaging

- Schema: `queueStatus`/`toAgentId` + `by_queue` index.
- Worker claim: pending messages claimed in `projectId` order with the task
  lease pattern; routed by Phase 1's router; chat replies and agent-to-agent
  messages both flow through it.
- Queue controls: `retryMessage`, `cancelMessage` internal mutations (one
  transition each); public `messages` queries expose `queueStatus` so
  `ChatPanel` renders the durable queue (replace the client-side buffer as
  the source of truth; keep the chip UX).
- `agentExecutor` delegation proposals write the addressed message row.
- **Check**: `npm run --workspace=@moagent/web typecheck`;
  `tests/queue.test.ts` (claim ordering, restart recovery, retry, cancel,
  no double-claim); api typecheck + tests green.

### Phase 5 — Dynamic tool discovery

- Registry module in `governance/` built from the existing tool
  implementations; `tool_search`/`tool_describe`/`tool_call` with the calling
  agent's `supportedTools` as the search scope.
- Wire `research`/`audit` kinds first (executeReadOnly tool loop, opt-in
  flag `ORCHESTRATOR_TOOL_LOOP`, default `false`); `code_change` unchanged.
- Governance invariants: every call audits through `AuditInput`; sandbox and
  argv allowlist unchanged; secret-shaped args redacted (existing `redact`).
- **Check**: `tests/toolRegistry.test.ts` (unknown tool refused, search scope
  enforced, audit recorded, sandbox escape refused, secret redaction);
  whole worker suite green.

### Phase 6 — Enable, document, reconcile

- Flip `ORCHESTRATOR_DECISION_ENGINE` default to `true` only after the full
  suite is green with it forced on (plan 005 Step 6.1 criteria).
- `packages/worker/AGENTS.md`: router ownership, six decision actions,
  conditional review/QA, new env knobs. `apps/api/convex/AGENTS.md`: queue
  claim is worker-facing and token-gated like every other `worker.ts` action.
- `ROADMAP.MD`: note the platform refactor and what stays deferred
  (per-project policy overrides, decision UI).
- Plan 005's state in `plans/README.md` → `REJECTED: superseded by 006`
  (content adopted as Phase 2).
- **Check**: `npm test`, both typechecks, `npm run knip` (no new findings),
  `npm run --workspace=@moagent/web build` (queue UI changed).

## Test plan

Unit/integration with mocked executors (plan 005's pattern). No live-provider
or Playwright tests in the default suite.

| Cluster | Scenario | Test file | Assertion |
| --- | --- | --- | --- |
| R1 | Greeting | `tests/router.test.ts` | routes `chat`; zero tasks created |
| R2 | Question | `tests/router.test.ts` | routes `question`; chat answer; no task row |
| R3 | Advice request | `tests/router.test.ts` | routes `advice`; no task row; no agent execution |
| R4 | Explicit change | `tests/router.test.ts` | routes `task`; `createFromCommand` called once |
| R5 | Bug report | `tests/router.test.ts` | routes `task`; capability = matching agent |
| R6 | Ambiguous | `tests/router.test.ts` | LLM advisor garbage → deterministic fallback + event |
| R7 | Capability selection | `tests/router.test.ts` | multi-agent only when ≥2 agents serve distinct capabilities; fallback agent never selected |
| A | Simple task | plan 005 `phase6Progressive.test.ts` | 1 node, `strategy: "direct"`, zero review/QA nodes |
| B | Complex auth | plan 005 | ≥2 capabilities, deps respected, QA via risk signal |
| C | Dynamic delegation | plan 005 `phase6Delegation.test.ts` | validated proposal persisted + executed |
| D | QA failure | plan 005 `phase6Completion.test.ts` | targeted fix + QA re-run, no full replan |
| E | Unnecessary delegation | plan 005 `delegation.test.ts` | self-serve proposal `REJECT`ed |
| F | Replanning | plan 005 `taskRunner.replan.test.ts` | completed work survives replan |
| G | Budget exhaustion | plan 005 `phase5Budget.test.ts` | enforce stops, warn continues |
| H | LLM unavailability | plan 005 `decision.test.ts` | deterministic fallback recorded |
| I | Cancellation/recovery | plan 005 `phase4HardeningRecovery.test.ts` | no new node after abort; resume keeps completed keys |
| J | Shared LLM | plan 005 `llmResolver.test.ts` | one connection, many agents; no per-agent key; no ciphertext in payloads |
| C1 | Context isolation | `tests/contextScope.test.ts` | task prompt has no conversation-only content; chat prompt has no decision payloads |
| C2 | Compaction | `tests/contextScope.test.ts` | >40 turns → summary row; prompt bounded (summary + last 12) |
| C3 | Retrieval cursor | api `convex-test` case | older messages fetchable by cursor; ordering stable |
| M1 | Queue durability | `tests/queue.test.ts` | pending item survives worker restart (re-claimed, not duplicated) |
| M2 | Queue controls | `tests/queue.test.ts` | retry failed item once; cancel pending item; no double-claim under concurrency |
| M3 | Agent-to-agent | `tests/queue.test.ts` | addressed message delivered to target agent; visible in timeline; logged |
| T1 | Tool search scope | `tests/toolRegistry.test.ts` | search returns only agent-allowed tools |
| T2 | Tool call governance | `tests/toolRegistry.test.ts` | unknown tool refused; sandbox escape refused; argv prefix attack refused |
| T3 | Audit + redaction | `tests/toolRegistry.test.ts` | every call audited; secret-shaped arg stored redacted |

Phase 0 exit criterion: every one of the brief's 41 scenarios maps to exactly
one row above (or a new row added in this table). Clusters R/A–J/C/M/T are
the reconstruction from the brief's functional requirements — if the brief's
actual wording differs, the table is corrected in Phase 0, not during
implementation.

## Completion criteria

- [ ] Phase 0 mapping table covers all 41 brief scenarios.
- [ ] "How do I …?" produces a chat answer and zero task rows (R2/R3 green).
- [ ] `npm test` green with `ORCHESTRATOR_DECISION_ENGINE=true` and
      `ORCHESTRATOR_ROUTER_LLM=ambiguous` forced on.
- [ ] Worker + api + web typechecks introduce no new error vs the Phase 0
      baseline; `npm run knip` reports no new finding.
- [ ] Queue item survives browser reload and worker restart (M1 green).
- [ ] No secret/key/ciphertext in any new queue, decision, or tool payload
      (T3/J green).
- [ ] `chat.ts:completeWithAgent` deleted; chat path runs behind the worker's
      budget/usage/health gates.
- [ ] All AGENTS.md surfaces updated (worker, convex, web) to match.
- [ ] Plan 005 marked superseded; this plan marked DONE only when every box
      above passes.

## STOP conditions

- A step needs a destructive schema change, or a new table that duplicates
  `taskContexts` / `messages` instead of extending them.
- A step needs the approval gate, sandbox, argv allowlist, terminal guard, or
  budget defaults changed.
- The queue becomes a *second* scheduler (its own retry/lease semantics
  diverging from the task claim loop) — stop and reuse the existing claim
  pattern.
- Chat reply latency through the worker poll loop makes chat unusable (>5s
  typical) — stop and revisit the entry point split (decision D-1) before
  proceeding.
- `maxDecisionSteps` or queue claim counts have to be raised repeatedly to
  make a test pass — that is a runaway loop, not a bound.
- A check fails twice after a reasonable fix.
