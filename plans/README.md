# Implementation plans

Plans for changes that touch a non-negotiable rule, a schema migration, the
orchestrator/planner contract, or more than one surface. Small fixes (copy,
dead code, a single-file bug) do not need a plan — fix them and report the
evidence. `ROADMAP.md` stays the backlog; a plan is a backlog item with an
execution order and a definition of done.

## Order and state

| Plan | Title | Priority | Size | Dependencies | State |
| --- | --- | --- | --- | --- | --- |
| 001 | [Memory store and workspace UI](001-memory-store.md) | P2 | M | — | TODO |
| 002 | [In-app notifications](002-in-app-notifications.md) | P2 | S | — | TODO |
| 003 | [Integrations UI on the existing backend](003-integrations-ui.md) | P2 | M | — | TODO |
| 004 | [Unify appearance (theme + font + system)](004-appearance-unification.md) | P3 | S | — | TODO |
| 005 | [Decision-driven orchestrator](005-decision-driven-orchestrator.md) | P1 | L | — | DONE (adopted as plan 006 Phase 2) |
| 006 | [Intelligent, context-aware, decision-driven multi-agent platform](006-intelligent-multi-agent-platform.md) | P1 | L | adopts 005 Phase 2–5 | DONE |
| 007 | [Project agent registry and conversation participation](007-agent-registry-and-participation.md) | P1 | M | — | DONE |
| 009 | [Filesystem MCP integration](009-filesystem-mcp-integration.md) | P1 | L | 007 | DONE |
| 010 | [CTO agent delegation](010-cto-agent-delegation.md) | P1 | L | 006, 007 | TODO |
| 013 | [Real orchestrator decisions and effective completion guards](013-real-decisions-and-guards.md) | P1 | L | 011, 012 | IN PROGRESS (Steps 1-7 landed; live smoke pending) |
| 014 | [Provider-native execution runtime (hybrid)](014-provider-native-runtime.md) | P1 | L | 011, 012 | IN PROGRESS (plan recorded; rule decisions pending) |
| 017 | [Orchestrator / Executor / Lead management through a single thread/UI](017-single-thread-agent-management.md) | P2 | M | 007 | TODO |
| 018 | [Path ownership, review snapshot binding, worktree isolation](018-path-ownership-review-snapshot-worktree.md) | P1 | M | 012, 013 | IN PROGRESS (Steps 1-4 implemented, Step 4 default-off; live smoke pending) |
| 019 | [Chat cards and the GitHub push / PR flow](019-chat-cards-and-github-push.md) | P1 | L | 018 | IN PROGRESS (implemented with unit tests; live GitHub smoke pending) |
| 020 | [Permission modes and the compact activity log](020-permission-modes.md) | P1 | M | 015, 019 | IN PROGRESS (implemented with unit tests; browser check pending) |
| 021 | [Decision visibility: Plan Inspector, Task Estimator, Routing, Decomposer graph](021-decision-visibility.md) | P1 | L | 019, 020 | IN PROGRESS (implemented with unit tests; live smoke pending) |
| 022 | [Subtask contract, escalation, acceptance gates, idempotent dispatch, user pause, model tiers](022-subtask-contract.md) | P1 | L | 018, 020, 021 | IN PROGRESS (implemented with unit tests; live smoke pending) |
| 023 | [Second Opinion, Shadow Agent, Incident Room, Self-Improvement Lab](023-reviewer-observer-incidents.md) | P1 | L | 020, 021, 022 | IN PROGRESS (implemented with unit tests; live smoke and browser check pending) |
| 024 | [Organizational Intelligence: org chart, agent profile, workload manager, collaboration graph](024-organizational-intelligence.md) | P2 | L | 021 | IN PROGRESS (implemented with unit tests; browser check pending) |
| 025 | [Intent-to-execution traceability and execution observations](025-traceability-and-observations.md) | P1 | M | 013, 022 | IN PROGRESS (implemented with unit tests; live smoke pending) |
| 026 | [Decision Outcome Calibration](026-decision-outcome-calibration.md) | P1 | L | 021, 022, 025 | IN PROGRESS (implemented with unit tests; live smoke and browser check pending) |
| 027 | [Model Capability Registry and performance routing](027-model-capabilities-and-performance-routing.md) | P2 | L | 022, 024, 025 | REJECTED: the model capability registry and its routing were removed by user request (plan 033); agent performance routing stays |
| 028 | [Chat activity timeline, decisions tray, in-process command approvals](028-chat-activity-and-decisions-tray.md) | P1 | L | 015, 020 | IN PROGRESS (implemented with unit tests; browser check and live worker smoke pending) |
| 030 | [Workflow Studio persistence on the backend](030-workflow-studio-backend.md) | P2 | M | 028 | REJECTED: feature removed by user request (studio UI, backend module and tests deleted; `workflows` table kept, unwritten) |
| 031 | [User-selectable LLM selection mode (fallback vs round robin)](031-llm-selection-mode-fallback-or-round-robin.md) | P2 | M | 027, 022 | IN PROGRESS (implemented with unit tests; browser check pending) |
| 032 | [Global LLM selection mode (fallback vs round robin)](032-global-llm-selection-mode.md) | P2 | M | 031 | IN PROGRESS (implemented with unit tests; browser check pending) |
| 033 | [Remove the model capability registry and capability routing](033-remove-model-capabilities.md) | P2 | L | 027 | IN PROGRESS (implemented with unit tests; browser check pending) |
| 034 | [OpenCode model catalog in the agent editor](034-opencode-model-catalog.md) | P2 | M | 014 | DONE (implemented with unit tests; live check in the running app) |

Allowed states: `TODO`, `IN PROGRESS`, `DONE`, `BLOCKED: <reason>`,
`REJECTED: <reason>`.

## Writing a plan

Copy the template below into `plans/NNN-short-title.md`, then add the row to the
table. Write it against the live code: every claim about the current state needs
a `path:line`. If you cannot point at the line, you have not read the code yet.

```markdown
# Plan NNN: Title

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

- Priority: P1 | P2 | P3
- Size: S | M | L
- Risk: LOW | MEDIUM | HIGH
- Dependencies: …
- Planned at: commit `<sha>`, `<date>`

## Why this is needed

The user problem, in one paragraph. No solution yet.

## Target behaviour

What a user can do after the change that they cannot do now. One table or list.

## Current state

`path:line` for every file the change touches, plus what exists today.

## Decisions that must not change during execution

The contract. Scope boundaries. What is explicitly out.

## Steps

### Step 1: …

What to change.

**Check**: `<command>` → expected result.

### Step 2: …

## Test plan

- The invariant each test protects.
- Negative cases (what must be refused).

## Completion criteria

A checklist, each item verifiable by a command or a file read.

## STOP conditions

- A non-negotiable rule in `AGENTS.md` must change.
- A schema change needs a destructive operation.
- A check fails twice after a reasonable fix.
- The change needs work outside this repository.
```

## Rules

- One plan per concern. Do not bundle "fix memory" and "add notifications".
- A plan never authorizes breaking a non-negotiable rule. If it needs one
  changed, the plan records the decision and the developer confirms it.
- Steps are ordered by dependency. Each step ends at a state where the repo
  still typechecks.
- The plan is finished when its completion criteria pass, not when the code is
  written.
