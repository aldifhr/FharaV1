# Plan 028: Chat activity timeline, decisions tray, in-process command approvals

## Status

- Priority: P1
- Size: L
- Risk: MEDIUM (touches non-negotiable rule 5: one new automatic-approval source)
- State: IN PROGRESS (implemented with unit + convex-test coverage; browser check and live worker smoke pending)

## Decision recorded (rule 5)

The user asked for "Always allow" on agent commands. This adds ONE automatic
approval source next to the permission mode: a project rule
(`projects.commandAllowRules`, normalized command head such as `npm run test`).
Guard rails, all enforced server-side in `commandApprovals.ts` +
`lib/commandRules.ts`:

- The worker's exact-argv allowlist (`packages/worker/src/tools/runCommand.ts`)
  stays a hard deny before any approval. Rules never widen it (rule 4 unchanged).
- Every auto-approval is still an approval row (`decidedBy: "auto"`) plus an
  audit row, like plan 020.
- `git push`, `merge_pr`, and dangerous patterns (rm -rf / -r / -f, git reset
  --hard, git clean, force push, recursive chmod/chown, pipe-to-shell, `sh -c`,
  sudo/su, shell control characters, paths outside the workspace) always ask,
  in every mode, never match a rule, and never offer "Always allow".
- `respond` downgrades "always" to "allow" when the row did not offer it.
- Rules are listed and removable in Manage project; adding/removing is audited.

## Why in-process

`orchestration.requestApproval` moves the task to needs_approval and releases
the lease; approving re-queues it. Per-command approvals through that path would
stall or re-run the DAG. A run_command approval therefore waits in-process
(`services/runner/commandApproval.ts`): lease and heartbeat kept, node activity
"Waiting for approval: …", pause / stop / a 10-minute wait timeout
(`ORCHESTRATOR_COMMAND_APPROVAL_TIMEOUT_MS`) cancel the row and end the wait as a
denial. apply_changes keeps its existing flow.

## Schema (additive, optional)

- `messages.toolSteps`, `messages.intentLine`
- `approvals.offerAlways`, `approvals.decision`, `approvals.note`, index `by_project_and_status`
- `projects.commandAllowRules`
