# Plan 041: "Always allow this exact command" for run_command approvals

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

- Priority: P2
- Size: S
- Risk: MEDIUM (touches the command approval policy, rule 5)
- Dependencies: 020 (permission modes), 028 (in-process command approvals and head rules)
- Planned at: commit `57d906c`, 2026-11-11

## Why this is needed

A command an agent runs again and again (for example `npx vitest run tests/a.test.ts`) asks every time in
Supervised and Auto-accept edits. The only shortcut today is the plan 028 "Always allow" rule, which is keyed
on the command HEAD (`npm run test`, `npx vitest`): once allowed, the same program with any other arguments is
approved too. Users who want to stop being asked for one specific command, and nothing broader, have no option.

## Target behaviour

| Action on a run_command card | Today | After |
| --- | --- | --- |
| Allow | runs once | unchanged |
| Always allow `<head>` | head rule, any arguments | unchanged |
| Always allow this exact command | — | exact-argv entry for the project; only the identical program + argument list auto-approves |
| Deny | denied | unchanged |
| Manage project | lists head rules, remove | also lists exact entries, remove (audited) |

An exact entry never matches a command that is dangerous or push-like, and push / PR approvals never offer it.

## Current state

- `apps/api/convex/lib/commandRules.ts:38-60` `commandHead`; `:145-157` `matchCommandAllowRule` (head equality,
  dangerous commands never match); `:170-190` `commandApprovalPolicy` (danger → ask, no "always"; rule → auto;
  full access → auto; else ask); `:197-199` `effectiveCommandDecision` (server downgrades "always" when the card
  did not offer it); `:202-212` `addCommandAllowRule`.
- `apps/api/convex/commandApprovals.ts:44-174` `request` (server-side policy; an auto decision inserts an
  approved row with `decidedBy: "auto"`, a `history` entry, an `approval.auto_approved` event and an audit row);
  `:261-325` `resolveCommandApproval` (writes the head rule on "always"); `:333-344` `respond`;
  `:391-411` `removeRule`.
- `apps/api/convex/schema.ts:267-275` `projects.commandAllowRules`.
- `apps/api/convex/lib/decisionTray.ts:103-123` builds the card actions (allow / always / deny).
- Web: `components/ApprovalCard.tsx:34` `CommandDecision`; `components/ChatPanel.tsx:591` action dispatch;
  `components/chat/MessageList.tsx:109`; `app/inbox/page.tsx:58`; `components/chat/ManageProjectModal.tsx:180-195`.
- Worker: `packages/worker/src/tools/runCommand.ts` exact-argv allowlist runs before any approval (rule 4).
  Nothing in this plan touches it.

## Decisions that must not change during execution

1. Security invariants (AGENTS.md rules 4 and 5) hold:
   - the worker's exact-argv allowlist in `runCommand.ts` is unchanged and still a hard deny first;
   - push and merge are never automatic: `git_push` / `merge_pr` approvals do not go through `respond`, and
     `dangerousCommandReason` (git push, gh pr merge, forced git, rm -rf, sudo, shell control, paths outside the
     workspace) makes `offerAlways` false and blocks any exact match;
   - an automatic decision from an exact entry is the existing `request` auto path: an approval row with
     `status: "approved"`, `decidedBy: "auto"`, a history entry, an `approval.auto_approved` event and an audit row;
   - the decision is made by the backend (`request` computes the policy); a client cannot force it:
     `effectiveCommandDecision` downgrades `always_exact` to `allow` when the card did not offer "always".
2. An exact entry is the literal `command` string plus the literal `args` array. No normalisation beyond what the
   worker sends, no prefix, no glob, no head. One extra, missing or changed argument does not match.
3. Schema change is additive: `projects.commandAllowExact: v.optional(v.array(...))`. Head rules stay as they are.
4. Capped at 50 entries per project (oldest dropped), deduped by exact argv.
5. Out of scope: per-task or global entries, editing entries, any change to permission modes.

## Steps

### Step 1: pure policy (`lib/commandRules.ts`)

Add `CommandAllowExact`, `matchCommandAllowExact`, `addCommandAllowExact`, `removeCommandAllowExact`, the
`always_exact` decision, and an `exact` input to `commandApprovalPolicy` checked right after the danger check.
`effectiveCommandDecision` downgrades both `always` and `always_exact` without `offerAlways`.

The worker's waiter (`packages/worker/src/services/runner/commandApproval.ts`) maps `always_exact` to its
existing `via: "always"` outcome; `api.worker.getCommandApproval` widens its return type.

**Check**: `npx --workspace=@fhara/api vitest run convex/lib/commandRules.test.ts` → new cases pass.

### Step 2: schema + backend

`projects.commandAllowExact` (optional). `request` passes it to the policy and records `exact: true` in the audit
details. `resolveCommandApproval` writes the entry on `always_exact` (audited `command_exact.add`). `respond`
accepts `always_exact`. New `removeExactRule` mutation (project access + audit `command_exact.remove`).

**Check**: `npm run --workspace=@fhara/api typecheck`; `npx --workspace=@fhara/api vitest run convex/commandApprovals.test.ts convex/securityInvariants.test.ts`.

### Step 3: UI

`decisionTray` adds the "Always allow this exact command" action next to the head rule when the card offers
"always". ApprovalCard / ChatPanel / MessageList / inbox accept the new decision. ManageProjectModal lists exact
entries with a remove button. Theme tokens only.

**Check**: `npm run --workspace=@fhara/web typecheck`.

## Test plan

- After "always exact", the identical argv auto-approves (`decidedBy: "auto"`, audit row with `exact: true`).
- One extra or changed argument asks again.
- A dangerous / push-like command never offers it and never matches a stored entry (also when an entry for it was
  written directly into the project).
- A client sending `always_exact` for a card that did not offer "always" gets a one-time allow, no entry.
- A removed entry asks again.
- `securityInvariants.test.ts` stays green.

## Completion criteria

- [x] Steps 1-3 checks pass (api / web / worker typecheck; `lib/commandRules.test.ts`,
      `commandApprovals.test.ts`, `lib/decisionTray.test.ts`).
- [x] `securityInvariants.test.ts` passes.
- [x] README row updated.
- [ ] Browser check of the new card button and the Manage project list (not done).

## STOP conditions

- Any step would need the worker's `runCommand.ts` allowlist widened, or an automatic decision without an
  approval row, or push / PR to become automatic.
- A schema change needs a destructive operation.
- A check fails twice after a reasonable fix.
