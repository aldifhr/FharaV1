# Plan 020: Permission modes and the compact activity log

## Status

- Priority: P1
- Size: M
- Risk: MEDIUM (changes when the approval gate pauses a task; rule 5)
- Dependencies: 015 (broker), 019 (push card)
- Planned at: branch `feat/permission-modes`, 2026-11-09
- Inspired by goat-si/goat (MIT): `docs/user/permission-modes.md`,
  `docs/user/activity-log.md`.

## Decision (AGENTS.md rule 5)

The developer asked for per-task permission modes. Rule 5 is amended, not
dropped: every gated action still gets an **approval row before it runs**.
In an automatic mode the row is written already `approved` with
`decidedBy: "auto"`, plus an `approval.auto_approved` task event and an
audit row (`approval.auto_approve`). Push / PR always asks.

## Modes

| Mode | Auto-approved | Still asks |
| --- | --- | --- |
| Supervised (default; every pre-020 task) | nothing | every apply_changes (plan apply, verification fix, QA fix) |
| Auto-accept edits | apply_changes incl. fix_verify / fix_qa | batches deleting > 3 files, policy-flagged batches, run_command, push / PR |
| Full access | apply_changes, run_command | push / PR |

Always, in every mode: the broker still denies targets outside the
workspace and stale rejections; the policy dry-run still denies protected
paths (lockfiles, .ssh) — those fail the task rather than ask. Push is only
ever started by the user's click on the push card.

## Shape

- Schema (additive): `tasks.permissionMode`, `projects.defaultPermissionMode`,
  `approvals.decidedBy`. Unset = supervised.
- Pure policy: `apps/api/convex/lib/permissionModes.ts`
  (`autoApprovalDecision`), shared by backend, worker and web.
- Backend: `orchestration.autoApprove` (internal) re-checks the mode from
  the task row, so a worker cannot raise it; `worker.autoApprove` is the
  token-gated entry. It never moves the task to `needs_approval`.
- Worker: `runner/autoApprove.ts` (`tryAutoApprove`). Called before
  `requestApproval` in `applyStage.brokerCheckAndApply` and
  `fixApply.applyOrRequestFixApproval`; on refusal or any error it falls
  back to the normal request (fail closed).
- The legacy project switch `approvalMode: "auto"` keeps its old behaviour
  until the project settings are saved, which writes `approvalMode: "ask"`
  plus the chosen default mode (legacy auto maps to full access).

## Activity log

`apps/web/lib/activityGroups.ts` groups consecutive activity cards
(changes, verification, QA, handoffs, reads) from one agent into one
collapsed row; see the module header for the rules.
