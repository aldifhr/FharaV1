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

(See the P2 section once it lands.)

## P3 — usage ledger

(See the P3 section once it lands.)

## Completion criteria

- P1: no non-implementer role can stage a file change (API or OpenCode);
  every Researcher row has `web_reach` after sync; existing tests green.
- Browser / live checks: not done in this lane (unit + convex-test only).
