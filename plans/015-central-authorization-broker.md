# Plan 015: Central authorization broker (runtime prompt sufficiency)

> Instructions for the implementer: run each step in order, run the check, confirm the expected result. On a STOP condition, stop and report. Do not guess. When done, set this plan's state in `plans/README.md`.

## Status

- Priority: P2
- Size: S
- Risk: LOW
- Dependencies: —
- Planned at: commit `<sha>`, `2026-11-08`

## Why this is needed

The user wants a MausBot-equivalent authorization layer for MOAgent task runtime: one enforcement endpoint for risky agent actions (Allow/Deny/Ask), a per-tool permission decision that is visible and persistent across recovery, recorded approvals for audit, and durable task-start instructions (shared instructions persisted, not just prompt-discarded).

## Target behaviour

- A single server-side function `assertActionAllowed` provides the final Allow/Deny/Ask decision for a complete action (tool, arguments, workspace, approvals).
- Approvals record task ID, agent requester, tool name, arguments, workspace, expiration, decision, and history for audit.
- The permission layer can still mark run actions as pre-approved; browsing works normally.
- Shared instructions survive across recoveries.
- The current `enforce` path rejects risky actions before execution with a reason.
- Plan 013's capability matrix is already in `packages/worker/src/governance/registry.ts`; extend it with an execution broker (`ROLE_TOOL_PERMISSIONS`) and audit reuse.

## Current state

- `apps/api/convex/schema.ts`: approvals table exists (taskId/projectId/kind/summary/payload/requestedByAgentId/status/resolvedAt).
- `apps/api/convex/approvals.ts`: approval lifecycle mutations.
- `packages/worker/src/governance/registry.ts`: `tool_call` enforces sandbox + allowlist + supportedTools at call time with audit log.
- `packages/worker/src/tools/sandbox.ts`: path resolution.
- `packages/worker/src/tools/runCommand.ts`: exact argv allowlist.
- `packages/worker/src/orchestrator/policy.ts`: budget/capability knobs; runtime prompt sufficiency not a current input.

## Decisions that must not change during execution

- Approvals rows are created only by worker actions with `workerToken` and service-token guard.
- The broker checks execute server-side at execution time; UI subagents cannot bypass it.
- `enforce` + `pre-approved` semantics come from approval mode; anything unmet = `Deny` with a reason.
- Audit trail remains additive: new permission records/audit fields use optional fields only.
- Do not weaken sandbox `resolveSandboxPath` or argv allowlist.

## Steps

### Step 1: Schema additions (additive, optional fields only)

Add to the existing `approvals` table:
- `toolName`, `arguments`, `workspacePath`, `principalAgentId` (requester), `expiresAt`, `history: v.optional(v.array(v.any()))`.

Also add `instructions` (optional string) to `projects` and `agents` tables for durable shared instructions — no new tables.

**Check**: `apps/api/convex/schema.ts` compiles; no migration dropping existing fields.

### Step 2: Permission broker function

In `apps/api/convex/permissionBroker.ts` create `decidePermission` (query) and use it inside approval flows:
- Evaluate: would deny if action runs outside the workspace; deny if action lacks a valid approval when required (via approval rows); ask-user if no row.
- It must be a runtime query/mutation callable by backend (not worker-only token).

**Check**: `npx --workspace=@moagent/api vitest run convex/<permissionBroker>.test.ts` passes.

### Step 3: Runtime prompt sufficiency note

Ensure durable shared instructions load from `projects.instructions`/`agents.instructions` into execution planning prompts when present. No new planner; reuse existing `buildPlanningGuidance`.

**Check**: `npm run --workspace=@moagent/worker typecheck` → exit 0.

### Step 4: Enforce in worker paths

Wire broker verdict into the risky action execution (`applyChanges`, `git_push`, `run_command`, `merge_pr`) reuse approval row already required; broker Deniability is the guard. Record denial to audit events (`taskEvents`/`approval` log).

**Check**: worker tests cover denied path; `npm run --workspace=@moagent/web typecheck` passes.

## Test plan

- Deny path: action without approval in enforce mode is refused with reason.
- Allow path: pre-approved actions run.
- Audit: approval contains taskId, agent, tool, args, workspace, expiry, decision.
- Shared instructions from DB reach planning prompt.
- No regression: existing approval rows still resolve (additive schema).

## Completion criteria

- [ ] Central broker function decides Allow/Deny/Ask for risky actions.
- [ ] Approval rows persist all requested fields + history.
- [ ] Durable shared instructions in schema load into planning.
- [ ] Enforce mode blocks unapproved actions with audit event.
- [ ] Typechecks (worker/api/web) + focused tests pass.

## STOP conditions

- Approvals callers not found → report plan instead of inventing new table.
- A schema change requires dropping existing columns.
- A check fails twice after a reasonable fix.
