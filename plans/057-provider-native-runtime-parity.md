# Plan 057: Provider-native runtime parity with FharaV2 (B)

> Instructions for the implementer: run each step in order, run the check,
> confirm the expected result. On a STOP condition, stop and report. Do not
> guess. When done, set this plan's state in `plans/README.md`.

## Status

- Priority: P1
- Size: L
- Risk: HIGH
- Dependencies: 014, 035, 038, 056
- Planned at: `2026-11-16`

## Why this is needed

Plan 056 removed the hand-written file/search/git parsing in the worker, but
coding subtasks still run on the `api` runtime by default: the agent's LLM
drives Fhara's own host tools (`packages/worker/src/execution/agentExecutor.ts`
â†’ `tools/`). FharaV2/T3Code has no such tool layer. The provider CLI does the
work with its native read/edit/search/shell tools, and the server only routes
sessions, approvals, and checkpoints:
`apps/server/src/provider/ClaudeProvider.ts`, `CodexProvider.ts`,
`ProviderRegistry.ts`, `acp/`, and the `packages/provider-*` packages.

The developer asked for that behaviour after the file/git port. This plan
covers it; it is separate because it changes the approval, budget, and sandbox
rules.

## Step 1 inventory (done `2026-11-16`)

Read: `apps/server/src/provider/Drivers/ClaudeDriver.ts`, `Drivers/CodexDriver.ts`,
`ProviderRegistry.ts`, `packages/provider-core/src/client.ts`, and Fhara's own
`packages/worker/src/execution/nativeProvider.ts`.

Findings:

- The FharaV2 drivers are Effect/Schema services bound to
  `@fhara/contracts`, `orchestration-v2/Adapters/*`, managed runtimes, and
  update brokers. They cannot be lifted into Fhara's worker as-is; they are
  reference for event shapes and lifecycle only.
- Fhara already has a working subprocess native runtime: `nativeProvider.ts`
  spawns `opencode run --format json`, parses NDJSON into `NativeEvent`, arms
  the OpenCode permission policy, and reuses the LLM ciphertext as
  `MOAGENT_OPENCODE_API_KEY`. That is the right template.
- Therefore the smallest second driver is a **Claude Code CLI** driver
  (`claude -p --output-format stream-json --verbose`), a sibling of the
  OpenCode spawner, not a port of `ClaudeDriver.ts`. Codex (`codex exec
  --json`) is the same shape and can follow later.
- Driver choice is a product decision; see the question recorded in the
  handoff note rather than changing `nativeProvider.ts` before it is answered.

## Progress `2026-11-16`

- Decision: **Codex CLI** is the second driver (developer choice).
- Implemented the worker slice:
  `execution/codexProvider.ts` (argv, availability probe, JSON event parser,
  usage, spawn with stdin prompt, tree kill), a `nativeDriver` branch in
  `agentExecutor.ts`, env plumbing in `nodeRunner` (`nativeDriver`,
  `codexCommand`), and `ORCHESTRATOR_NATIVE_DRIVER` / `ORCHESTRATOR_CODEX_COMMAND` / `ORCHESTRATOR_CODEX_MODEL` in the config
  schema (env examples regenerated). The driver *choice* itself moved to the
  app-wide setting (see below) so the app is configured like FharaV2, which does
  not use `.env` for provider selection.
- The driver is stored/selected through the app-wide setting:
  `opencodeSettings.driver` (`opencode` | `codex`) via `api.opencodeSettings.setDriver`,
  read into the run context as `nativeDriver`, and used by the worker resolver
  (the legacy native gate now checks Codex when the setting selects it;
  `codexGateFor`). Env (`ORCHESTRATOR_NATIVE_DRIVER`, `ORCHESTRATOR_CODEX_COMMAND`,
  `ORCHESTRATOR_CODEX_MODEL`) stays as the last fallback. The Codex binary path
  stays machine-local (env) because a worker can sit on a different machine.
- Grounded the parser against a real `codex exec --json` run (codex-cli
  0.169.0, ChatGPT login): `thread.started`, `item.completed`
  (`agent_message`, `error`), `turn.started`, `turn.completed` with
  `usage.input_tokens` (total) and `cached_input_tokens`.
- Tests: `tests/codexProvider.test.ts` (13) pass; worker typecheck passes.
- Not done yet: session resume, a Codex model catalog, and the plan-014 waiver
  assertions as dedicated tests. The runtime/driver selection is now the
  app-wide setting (Settings → LLM & Models → Native runtime driver); the env
  vars are the fallback, not the primary path.
- Security note: Codex uses the operator's `~/.codex` login and therefore
  runs without a scoped home. That is a trusted-machine runtime; it must
  not be offered to a hosted/multi-tenant worker without a new decision.

## Decisions that must not change without a recorded decision

- Plan 014 already records the user-confirmed rule for the native path:
  provider sessions run with their own tools in `danger-full-access` inside
  the task workspace; the human approval gate, per-action sandboxing, and the
  per-LLM-call budget gate are waived for that path. The `api` path keeps all
  three. Do not quietly extend the waiver to `api`.
- One planning authority stays (`ORCHESTRATOR_AUTHORITATIVE`). A provider
  runtime executes a subtask; it does not plan or route.
- Cancellation is still one `AbortController` per task and must reach the
  provider process tree.
- Provider credentials never cross to the worker as plaintext; the existing
  ciphertext path in `llm/crypto.ts` stays.
- Per plan 056 and root rule 4, the `api` path's sandbox resolution stays
  exactly as it is.

## Steps

### Step 1: Inventory and choose one driver [DONE]

Read `apps/server/src/provider/ClaudeProvider.ts`, `CodexProvider.ts`,
`ProviderInstanceRegistry.ts`, and `packages/provider-core` in FharaV2. Pick
the smallest driver that fits Fhara's transport: `@anthropic-ai/claude-agent-sdk`
or the Codex app-server protocol. Record the choice and its events.

**Check**: a design note in this plan names the driver, the SDK version, the
event mapping, and the credential source.

### Step 2: Adapter behind the existing runtime flag [DONE: worker; settings wiring landed via opencodeSettings.driver; resume pending]

Extend `execution/nativeProvider.ts` (it already owns OpenCode) with a second
driver behind `resolveExecutionRuntime`. Keep the OpenCode path working and
the `api` path as fallback when the CLI/SDK is absent.

**Check**: `npm run --workspace=@fhara/worker typecheck`; one focused adapter
test starts a fake session, streams a tool event, and finishes.

### Step 3: Approval, budget, checkpoint reconciliation [PARTIAL: staging reused; waiver tests pending]

For the native path, record the plan-014 waiver in code (not comments): skip
the per-action approval rows, report usage into `BudgetTracker` after each
turn, and snapshot/revert changed paths through the existing diff pipeline so
review still sees what the provider wrote.

**Check**: invariant tests: native write does not request approval, usage is
reported, out-of-scope writes are reverted; `api` path still requests
approval.

### Step 4: Persist session state and recovery

Persist the provider/session id needed after a worker restart, as plan 014
step 4 requires. Dynamic subtasks and runtime choice stay in the database.

**Check**: resume test starts a task, restarts the adapter, and resumes the
same session.

### Step 5: UI and migration

Expose the runtime choice where plan 035 put the OpenCode choice; migrate
existing agents without writing new fields non-optionally.

**Check**: web + worker typecheck; one smoke task on each runtime.

## Test plan

- Native provider cannot write outside the task workspace.
- Cancellation/deadline kills the provider process tree.
- Budget usage is visible before the next turn.
- Missing SDK/CLI degrades to `api` with one warning, never a crash.
- Existing `api` approval/sandbox tests stay green.

## Completion criteria

- [ ] One additional provider driver runs real coding subtasks natively.
- [ ] Plan-014 waiver is enforced in code and tested, not implied.
- [ ] Recovery resumes a native session.
- [ ] `api` runtime remains the fallback and its gates are unchanged.
- [ ] Worker + web typechecks and the focused suites pass.

## STOP conditions

- A driver needs credentials or a runtime that cannot be installed on the
  worker machine.
- Approval/budget parity would require changing a root non-negotiable without
  a new user-confirmed decision.
- A check fails twice after a reasonable fix.

