# Plan 040: Team roles — enforced permissions, routing correctness, usage ledger

## Status

- Priority: P1
- Size: M (three lane-sized commits: P1, P2, P3)
- Risk: MEDIUM (changes who may write and who gets routed work)
- Dependencies: 022 (read-only reviewer, escalations), 036 (web_reach), 038 (OpenCode provider)
- Planned at: commit `fc449a2`, 2026-11-10, from the team-architecture audit
  (phases P1–P3, decisions D1–D10 taken at their defaults)

## Decisions (user: defaults)

| # | Decision | Taken |
|---|---|---|
| D1 | Designer file writes | None |
| D2 | Support `general` catch-all | Removed |
| D3 | `security-audit` owner | Reviewer (was CTO) |
| D7 | DevOps write paths | `.github/**`, `Dockerfile*`, `docker-compose*`, `infra/**` |
| D8 | Unknown role / no capability match | BLOCKED with a reason (no CTO / Frontend fallback) |
| D10 | Seed prompt updates | Only rows whose prompt is exactly an earlier seed |

Deferred by the user: budget caps / cost limits (P3 is tracking only).

## P1 — role permissions enforced in the executor

`ROLES[k].permissions` (`apps/api/convex/lib/roles.ts`) is the table:

| Role | write | shell | web |
|---|---|---|---|
| CTO, Designer, Support, Reviewer, Researcher | no | none | Researcher only |
| QA | no | verify (tests, typecheck, build, read-only git) | no |
| Frontend, Backend | yes (subtask scope) | allowlist | no |
| DevOps | D7 paths only | allowlist | no |

Push is `false` for every role (push / PR stay user-approved runtime steps).

Enforcement (worker):

- `roleRefusal` in `executeSubtaskScoped` runs before any LLM call or
  runtime (API or OpenCode): a `code_change` needs write permission, a
  `shell` node shell permission. Refusal = `Refused: …`, non-retryable,
  `agent.permission_denied` event.
- `executeCodeChange` and the OpenCode staging gate refuse / revert each
  file the role may not write (DevOps outside D7 paths).
- `executeShell`: role shell scope after the allowlist; a destructive /
  push-like command (`dangerousCommandReason`) never runs without an
  approval channel. With one, it always asks (unchanged, `commandRules.ts`).
- `web_reach` needs the role's `web` permission as well as the declared tool.
- MCP writes only for roles with unrestricted write.
- The governance broker's role matrix is derived from the same table.
- Custom roles (not one of the nine, no alias) keep what their declared
  tools allowed (`permissionsFromTools`).

Back-compat (`syncFixedTeam`):

- Tools: only `ADDED_DEFAULT_TOOLS` (Researcher `web_reach`, DevOps
  `write_file`) are unioned in and only `REVOKED_DEFAULT_TOOLS` (Designer /
  Support `write_file`) removed; other user tool choices stay.
- Prompts (D10): replaced only when exactly equal to an entry in
  `PREVIOUS_SEED_PROMPTS`. Seeds changed here: Support, QA, DevOps.
- One `audit` row (`agent.sync`, field names only) per patched agent.

## P2 — routing correctness

- **No fallback owner (D8).** `routeCapability` returns null when no
  enabled agent declares (or fuzzily matches) the capability. The old
  last resort (highest priority = the CTO) is opt-in only
  (`ORCHESTRATOR_ALLOW_FALLBACK=true`, default now `false`) and even then
  never picks the CTO. A code-writing capability (frontend/backend
  development) routes only to a role that may write. `unroutedReason`
  names why.
- **Unknown role.** `normalizeRole` returns null instead of `frontend`;
  `roleForAgent` uses the role name, else the declared capabilities.
- **Runtime.** An unrouted node fails as `Blocked: No agent available for
  capability "…": …` (non-retryable) with a `subtask.routed` warn event
  (`blocked: true`, reason). A review with no Reviewer is BLOCKED (no CTO
  review fallback).
- **Planner never drops silently.** `ensureRoutable` keeps an unroutable
  code_change/shell node (it is BLOCKED at run time), drops only an
  unroutable helper node (and the dependencies on it), and turns a
  code_change owned by a read-only role (Designer spec, Support docs) into
  an `analysis`. Every change is a `routingAdjustment` logged as a warn
  event (`plan.hint_dropped` / `plan.routing_adjusted`) with title,
  capability and reason.
- **One fix-owner rule.** `ownerForFix` (`orchestrator/ownership.ts`): the
  code_change subtask that owns the findings' files (`pickFixOwner`) and
  the agent that actually ran it (the run's `agentByKey`), else its
  capability owner; never a role that may not write, never a catch-all.
  Used by the review, QA (UI owners first) and verification loops and by
  the orchestrator's critical-findings REVISE (was the first FE/BE in the
  roster). The fix subtask is pinned to that agent. No owner → the loop
  stops with a feedback line and a `review.fix_unowned` / `qa.fix_unowned`
  event.
- **D2 / D3.** Support loses `general`; the CTO gets `project-coordination`
  (conversation replies, the classifier's greeting capability) and loses
  `security-audit`, which moves to the Reviewer. `REVOKED_DEFAULT_CAPABILITIES`
  strips both from existing rows; the sync unions the new ones. Docs
  concerns stay with the implementer unless a docs owner may write.

## P3 — usage ledger

(See the P3 section once it lands.)

## Completion criteria

- P1: no non-implementer role can stage a file change (API or OpenCode);
  every Researcher row has `web_reach` after sync; existing tests green.
- Browser / live checks: not done in this lane (unit + convex-test only).
