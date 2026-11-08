# Plan 010: CTO agent delegation

> Instructions for the implementer: run each step, run the check, confirm the expected result. On a STOP condition, stop and report. Do not guess. When done, set this plan's state in `plans/README.md`.

## Status

- Priority: P1
- Size: L
- Risk: HIGH
- Dependencies: 006, 007
- Planned at: current working tree, 2026-11-08

## Why this is needed

The orchestrator has planner and decision-engine delegation primitives, but the chat experience does not expose a clear, structured CTO-to-agent assignment flow. A textual mention must become a validated, persisted delegation/subtask rather than a second routing path or an untracked chat message.

## Target behaviour

- CTO can assign a bounded subtask to a selected agent.
- The assignment is persisted with parent task, source/target agent, capability, depth, and description.
- The worker executes the existing authoritative plan path; no second planner is introduced.
- Circular, terminal-task, stale-worker, and budget-limit delegations are refused.
- Chat shows a concise delegation card and the target agent's result.

## Current state

- `packages/worker/src/orchestrator/decision.ts` supports `delegate` decisions.
- `packages/worker/src/orchestrator/taskContext.ts` models delegation decisions and shared task context.
- `apps/api/convex/orchestration.ts` persists dynamic subtasks and delegation lifecycle events.
- `apps/api/convex/conversations.ts` and `apps/api/convex/chat.ts` accept `preferredAgentIds` for initial routing.
- `apps/web/components/ChatPanel.tsx` currently renders selected routing chips and delegation messages, but does not provide a structured CTO assignment control.

## Decisions that must not change during execution

- The orchestrator remains the sole execution authority.
- Existing approval gates, budget gates, sandboxing, service-token checks, terminal-task immutability, and cancellation signal propagation remain intact.
- Delegation is additive and bounded; textual mentions alone never execute work.
- No destructive schema migration.

## Steps

### Step 1: Define the delegation contract

Reuse existing task/subtask and decision structures where possible. Add only optional/additive fields if persistence is missing.

**Check**: API and worker typechecks.

### Step 2: Validate and persist CTO delegation

Add a worker/API path that validates source/target agent membership, task state, delegation depth/budget, and current execution ownership before creating the dynamic subtask/event.

**Check**: backend tests for accepted delegation and negative terminal/circular/stale cases.

### Step 3: Connect execution to the authoritative scheduler

Route the persisted delegation through the existing dynamic-subtask scheduler path. Do not add a parallel planner or direct agent execution path.

**Check**: worker orchestration/delegation tests.

### Step 4: Add the chat assignment interaction

Expose agent selection/assignment from the CTO/task context, show structured delegation cards, and render results without duplicating raw internal messages.

**Check**: web typecheck and focused UI smoke check.

## Test plan

- Delegation to an enabled project agent creates exactly one persisted subtask.
- Delegation to an agent outside the project is refused.
- Delegation from a terminal task is refused.
- Circular/depth-limit delegation is refused.
- Duplicate callback does not create duplicate work or duplicate lifecycle event.
- Delegated result appears in chat as one structured card.

## Completion criteria

- [ ] Contract documented in code/types.
- [ ] Backend negative cases pass.
- [ ] Worker uses the existing authoritative scheduler.
- [ ] Chat can select a target agent for a CTO assignment.
- [ ] Web, API, and worker checks pass.

## STOP conditions

- A non-negotiable rule in `AGENTS.md` must change.
- A schema change needs a destructive operation.
- A check fails twice after a reasonable fix.
- The change needs work outside this repository.
