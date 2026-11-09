# Plan 014: Provider-native execution runtime (hybrid)

> Instructions for the implementer: run each step in order, run the check, confirm the expected result. On a STOP condition, stop and report. Do not guess. When done, set this plan's state in `plans/README.md`. This plan changes working rules the developer must confirm before implementation.

## Status

- Priority: P1
- Size: L
- Risk: HIGH
- Dependencies: 011, 012
- Planned at: commit `<sha>`, `2026-11-08`

## Why this is needed

The current execution path implements coding tools in MOAgent (`packages/worker/src/tools/`), so every agent feature depends on MOAgent maintaining its own sandbox, command allowlist, browser, GitHub, and MCP tooling. The developer wants a provider-native runtime where coding agents use their provider's native tools instead, while MOAgent remains responsible for planning, approval, budget accounting, and verification.

## Target behaviour

What a user can do after the change:

| Capability | After |
| --- | --- |
| Choose `runtime: native-provider` for eligible subtasks | Coding work executes through the provider CLI/ACP session in the task workspace |
| Human approval still required for risky effects | Provider session is constrained to read/plan modes; writes remain approval-gated |
| Budget accounting remains visible | Turn usage reported to BudgetTracker even though provider tools are native |
| Existing API-based execution remains available | `runtime: api` continues current behavior |

## Current state

- `packages/worker/src/tools/sandbox.ts`: path resolution and sandboxed file tools.
- `packages/worker/src/tools/runCommand.ts`: exact argv allowlist command execution.
- `packages/worker/src/execution/agentExecutor.ts`: API-based subtask execution using shared tools.
- `packages/worker/src/effects/llmCall.ts`: pre-call budget gate and LLM provider invocation.
- `packages/worker/src/llm/resolver.ts`: priority/weighted/model-pattern/health provider selection.
- `packages/worker/src/orchestrator/roles.ts`: role definitions, capabilities, and system prompt hints.
- `packages/worker/src/orchestrator/policy.ts`: execution bounds and timeouts.
- `apps/api/convex/schema.ts`: persisted schema for tasks/subtasks/executions/provider state.

## Decisions that must not change during execution

- ~~Do not remove the human approval gate for `apply_changes`, `git_push`, `run_command`, or `merge_pr` without an explicit recorded decision.~~
- **Decision recorded (2026-11-08, user-confirmed): provider-native runs use the provider's own tools in `danger-full-access` mode; the human approval gate, per-action sandboxing, and per-LLM-call budget gate are waived for the native path.`budgetMode` may still warn, but writes/command execution are not gated.** The existing API path (Runtime `api`) keeps all three gates unchanged.
- ~~Do not replace the budget gate with post-hoc accounting; native-provider turns still need a pre-call gate or an explicit approved policy change.~~ (Waived by decision above; usage is still reported to task events for observability.)
- ~~Do not silently allow native provider writes outside the workspace sandbox.~~ (Waived by decision above; native workspaces run provider-native in the task workspace directory only.)
- Do not replace the orchestrator/planner contract with a second planner.
- Do not depend on one provider CLI being installed everywhere; discovery and absence must degrade cleanly to the existing API runtime.

## Steps

### Step 1: Define provider-native runtime contract

Add an execution runtime adapter contract so task execution can choose `api` or `native-provider` without changing orchestration decisions.

**Check**: `npm run --workspace=@moagent/worker typecheck` → exit 0.

### Step 2: Implement provider CLI/ACP adapter

Implement the provider-native path for one provider first (prefer OpenCode/ACP-compatible path), mapping turn start, message delivery, tool constraints, cancellation, and usage reporting onto existing worker services. Keep the existing API runtime as fallback.

**Check**: typecheck + one focused provider-adapter test → pass.

### Step 3: Reconcile approval, sandbox, and budget gates

Constrain native provider sessions so file writes, shell, browser, and merge actions either remain approval-gated internal tools or are denied. Report provider usage into BudgetTracker before the next call/turn. If inversion is required (provider performs effects internally), stop and record the changed rule in this plan.

**Check**: invariant tests for write/command approval and budget accounting.

### Step 4: Persist runtime choice and recovery state

Store the selected runtime/provider/session identifiers needed for task recovery in persisted schema/state rather than worker memory only.

**Check**: worker restart/resume exercises the persisted native session without losing task state.

### Step 5: UI and validation surface

Expose runtime choice where appropriate and preserve the existing work verification/approval flow.

**Check**: worker + web typechecks and one smoke task.

## Test plan

- Native-provider session cannot write files or run commands without approval.
- Native-provider usage updates task budget accounting.
- Cancellation/deadline stops the provider session.
- API runtime remains the fallback when the provider CLI is unavailable.
- Existing API runtime behavior remains covered by current worker suites.

## Completion criteria

- [ ] Provider-native execution is available behind an explicit runtime choice.
- [ ] Human approval, budget accounting, sandbox, and orchestrator rules remain enforced or their rule changes are recorded here.
- [ ] Native session recovery works across worker restart.
- [ ] API runtime fallback remains functional.
- [ ] Focused worker tests and workspace typechecks pass.

## STOP conditions

- A non-negotiable rule in `AGENTS.md` must change without explicit confirmation in this plan.
- Native provider writes cannot be constrained to the workspace sandbox.
- Budget usage cannot be accounted before continued execution.
- The provider adapter cannot be isolated to one provider first.
- A check fails twice after a reasonable fix.
