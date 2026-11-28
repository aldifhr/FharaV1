# Implementation plans

This directory holds design plans and their state. `README.md` is the index.

Plans are for changes that touch a non-negotiable rule, a schema migration, the
orchestrator/planner contract, or more than one surface. Small fixes (copy,
dead code, a single-file bug) do not need a plan — fix them and report the
evidence. `ROADMAP.md` stays the backlog; a plan is a backlog item with an
execution order and a definition of done.

## Order and state

| Plan | Title | Priority | Size | Dependencies | State |
| --- | --- | --- | --- | --- | --- |
| 001 | [Chat role-assignment contract](001-chat-role-assignment-contract.md) | P1 | L | — | TODO (step 4 DONE 2026-11-27: role-choice fallback removed entirely; steps 1–3 remain) |
| 002 | [Worker capability resolution contract](002-worker-capability-resolution-contract.md) | P2 | M | 001 | DONE 2026-11-27 (one resolver, no regex, shell/write capability enforced at route) |
| 003 | [Structured handoff and mention contract](003-structured-handoff-and-mention-contract.md) | P1 | L | 001 | TODO (audit 2026-11-27: CTO/Lead prompts contradict structured handoff; 17/19 handoff tests fail at HEAD) |
| 004 | [Unowned-finding decision outcome](004-unowned-finding-decision-outcome.md) | P2 | M | — | TODO (audit 2026-11-27: non-budget BLOCKED reported as budget halt) |
| 005 | [Clear project activity](005-clear-project-activity.md) | P3 | S | — | DONE 2026-11-27 |
| 006 | [Runtime-aware capability discovery and Blocked outcome](006-runtime-capability-discovery.md) | P1 | L | 001, 002, 004 | IN PROGRESS 2026-11-27 (discovery module + terminal `blocked` + task badge done; per-agent live probe not wired) |
| 007 | [CTO as the single planning authority](007-cto-as-orchestrator.md) | P0 | L | 001, 003, 006 | IN PROGRESS 2026-11-28 (C1–C5, C7–C12, C14–C18 done incl. CTO-first chat routing; remaining: C13 runtime probe, C16 plan 003, test-debt cleanup) |
| 008 | [Reuse an approved apply snapshot](008-approval-snapshot-reuse.md) | P0 | M | — | DONE 2026-11-28 (no repeated approval card for the same file set) |

Allowed states: `TODO`, `IN PROGRESS`, `DONE`, `BLOCKED: <reason>`,
`REJECTED: <reason>`.

## Writing a plan

Copy the template below into `plans/NNN-short-title.md`, then add the row to the
table above. Write it against the live code: every claim about the current state
needs a `path:line`. If you cannot point at the line, you have not read the code
yet.

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
