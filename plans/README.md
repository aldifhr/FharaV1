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
| 010 | [CTO agent delegation](010-cto-agent-delegation.md) | P1 | L | — | TODO |
| 013 | [Real orchestrator decisions and effective completion guards](013-real-decisions-and-guards.md) | P1 | L | 011, 012 | IN PROGRESS (Steps 1-7 landed; live smoke pending) |
| 014 | [Provider-native execution runtime (hybrid)](014-provider-native-runtime.md) | P1 | L | 011, 012 | IN PROGRESS (plan recorded; rule decisions pending) |
| 017 | [Orchestrator / Executor / Lead management through a single thread/UI](017-single-thread-agent-management.md) | P2 | M | — | TODO |
| 018 | [Path ownership, review snapshot binding, worktree isolation](018-path-ownership-review-snapshot-worktree.md) | P1 | M | 012, 013 | IN PROGRESS (Steps 1-4 implemented, Step 4 default-off; live smoke pending) |
| 019 | [Chat cards and the GitHub push / PR flow](019-chat-cards-and-github-push.md) | P1 | L | 018 | IN PROGRESS (implemented with unit tests; live GitHub smoke pending) |
| 020 | [Permission modes and the compact activity log](020-permission-modes.md) | P1 | M | 015, 019 | IN PROGRESS (implemented with unit tests; browser check pending) |
| 021 | [Decision visibility: Plan Inspector, Task Estimator, Routing, Decomposer graph](021-decision-visibility.md) | P1 | L | 019, 020 | IN PROGRESS (implemented with unit tests; live smoke pending) |
| 022 | [Subtask contract, escalation, acceptance gates, idempotent dispatch, user pause, model tiers](022-subtask-contract.md) | P1 | L | 018, 020, 021 | IN PROGRESS (implemented with unit tests; live smoke pending) |
| 023 | [Second Opinion, Shadow Agent, Incident Room, Self-Improvement Lab](023-reviewer-observer-incidents.md) | P1 | L | 020, 021, 022 | IN PROGRESS (implemented with unit tests; live smoke and browser check pending) |
| 024 | [Organizational Intelligence: org chart, agent profile, workload manager, collaboration graph](024-organizational-intelligence.md) | P2 | L | 021 | IN PROGRESS (implemented with unit tests; browser check pending) |
| 025 | [Intent-to-execution traceability and execution observations](025-traceability-and-observations.md) | P1 | M | 013, 022 | IN PROGRESS (implemented with unit tests; live smoke pending) |
| 026 | [Decision Outcome Calibration](026-decision-outcome-calibration.md) | P1 | L | 021, 022, 025 | IN PROGRESS (implemented with unit tests; live smoke and browser check pending) |
| 028 | [Chat activity timeline, decisions tray, in-process command approvals](028-chat-activity-and-decisions-tray.md) | P1 | L | 015, 020 | IN PROGRESS (implemented with unit tests; browser check and live worker smoke pending) |
| 031 | [User-selectable LLM selection mode (fallback vs round robin)](031-llm-selection-mode-fallback-or-round-robin.md) | P2 | M | 022 | IN PROGRESS (implemented with unit tests; browser check pending) |
| 032 | [Global LLM selection mode (fallback vs round robin)](032-global-llm-selection-mode.md) | P2 | M | 031 | IN PROGRESS (implemented with unit tests; browser check pending) |
| 033 | [Remove the model capability registry and capability routing](033-remove-model-capabilities.md) | P2 | L | — | IN PROGRESS (implemented with unit tests; browser check pending) |
| 035 | [Global OpenCode runtime, per-agent Fhara LLM](035-global-opencode-runtime.md) | P2 | M | 014, 032 | IN PROGRESS (implemented with unit tests; live check done; worker restart pending) |
| 036 | [Agent Reach web tool for read-only agents](036-agent-reach-web-tool.md) | P2 | M | — | IN PROGRESS (implemented with unit + executor tests; live CLI smoke done, full task smoke pending) |
| 037 | [LLM & Models simple flow, one model order](037-llm-models-simple-flow.md) | P2 | M | 032, 035 | IN PROGRESS (implemented with unit + local-test; browser check pending) |
| 038 | [OpenCode as a provider, with detection](038-opencode-provider.md) | P2 | M | 035, 037 | IN PROGRESS (implemented with unit + local-test + live CLI test; browser check pending) |
| 040 | [Team roles: enforced permissions, routing, usage ledger](040-team-roles-routing-usage.md) | P1 | M | 022, 036, 038 | IN PROGRESS (P1 implemented with unit + local-test; no live run) |
| 041 | ["Always allow this exact command" for run_command approvals](041-command-always-allow-exact.md) | P2 | S | 020, 028 | IN PROGRESS (implemented with unit + local-test; browser check pending) |
| 043 | [O-flow: supervised auto-merge, issue intake, research fan-out, phone approvals](043-o-flow-merge-intake-research-phone.md) | P1 | L | 019, 020 | IN PROGRESS (O2, O4, O7, O6 implemented with unit tests; live GitHub merge/issue smoke and phone browser check pending) |
| 050 | [One modal primitive for every overlay](050-one-modal-primitive.md) | P2 | M | — | TODO (web-UI audit: 3 shared modal implementations + 2 bespoke overlays; the context drawer has no focus trap) |
| 051 | [Lint the web app and pay down its `any` debt](051-lint-and-any-sweep.md) | P2 | L | — | TODO (web-UI audit: no ESLint, 269 `any`, 68 Fhara runtime id casts) |
| 052 | [Split the oversized chat/settings components](052-split-oversized-components.md) | P3 | L | 050 (optional) | TODO (web-UI audit: six files over 700 lines, one `next/dynamic`) |
| 053 | [Retire the legacy route layer](053-retire-legacy-routes.md) | P3 | S | - | TODO (web-UI audit: 5 redirect-only routes; decision A/B/C needed) |
| 057 | [Provider-native runtime parity with FharaV2 (B)](057-provider-native-runtime-parity.md) | P1 | L | 014, 035, 038 | IN PROGRESS (Codex driver done in the worker; app-wide driver selection landed via `opencodeSettings.driver`; session resume and Codex model catalog remain) |
| 058 | [Port FharaV2 tooling verbatim, stage by stage (C)](058-verbatim-tooling-port.md) | P1 | L | 057 | STAGE 3 DONE (2026-11-17): acp runtime beside opencode/codex — effect-acp client, policy-mapped permission requests, sandboxed fs handlers, native.* events; 21 vitest tests incl. fake-ACP-agent stdio round trip; LIVE SMOKE PASS (2026-11-17: codex-acp 2.6.0, default ChatGPT provider via throwaway CODEX_HOME, read-only task read notes.md and streamed the magic word; stages 4-6 pending) |
| 060 | [FharaV2-style settings.json model for chat via the worker](060-settings-json-chat-model.md) | P1 | M | — | IN PROGRESS (settings.json + worker bridge + chat client; live smoke pending) |
| 067 | [Match the workspace mockup (accent + rail + sidebar + chat restyle)](067-mockup-parity.md) | P1 | L | — | IN PROGRESS (all 5 stages landed 2026-11-17: accent tokens + guard, rail, NeedsYou cards, chat surface restyle incl. composer @ / buttons and TaskCard ref/due, QA wording; guards + web typecheck + 197/198 web tests green; only the light+dark visual smoke remains) |

| 068 | [Local-first SQLite backend with a Fhara runtime-compatible runtime (desktop-ready)](068-local-sqlite-backend.md) | P1 | L | — | IN PROGRESS (2026-11-22: Fhara runtime removed entirely, 694 functions on Drizzle/SQLite, all 4 typechecks green, e2e mutation/query pass; 193/1539 backend tests + Electron packaging remain) |

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
