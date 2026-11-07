# Implementation plans

Plans for changes that touch a non-negotiable rule, a schema migration, the
orchestrator/planner contract, or more than one surface. Small fixes (copy,
dead code, a single-file bug) do not need a plan — fix them and report the
evidence. `ROADMAP.MD` stays the backlog; a plan is a backlog item with an
execution order and a definition of done.

## Order and state

| Plan | Title | Priority | Size | Dependencies | State |
| --- | --- | --- | --- | --- | --- |
| 001 | [Memory store and workspace UI](001-memory-store.md) | P2 | M | — | TODO |
| 002 | [In-app notifications](002-in-app-notifications.md) | P2 | S | — | TODO |
| 003 | [Integrations UI on the existing backend](003-integrations-ui.md) | P2 | M | — | TODO |
| 004 | [Unify appearance (theme + font + system)](004-appearance-unification.md) | P3 | S | — | TODO |
| 005 | [Decision-driven orchestrator](005-decision-driven-orchestrator.md) | P1 | L | — | TODO (superseded by 006) |
| 006 | [Intelligent, context-aware, decision-driven multi-agent platform](006-intelligent-multi-agent-platform.md) | P1 | L | adopts 005 Phase 2–5 | TODO |
| 007 | [Project agent registry and conversation participation](007-agent-registry-and-participation.md) | P1 | M | — | DONE |

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
