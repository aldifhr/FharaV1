# 043 — O-flow: supervised auto-merge, issue intake, research fan-out, phone-friendly approvals

Source study: `ai-orchestrator-topic-adoption.md` phases O2, O4, O7, O6. The
user delegated the open choices ("atur aja"); the decisions below are theirs
by that delegation and are recorded here because O2 touches non-negotiable
rule 5 (approval gate).

## Decisions

### O2 Supervised auto-merge
- OFF by default. Per-project switch (`projects.autoMerge`) and a new-project
  default in Settings → Diffs & PR (`appSettings.newProjectAutoMerge`).
- Merges only when ALL hold: every check on the head passed (a pending,
  failed or errored check blocks or waits; a PR with no checks waits), the
  size / sensitive-path gate passed (fails closed), no failing dependency
  check (`taskPushes.dependencyCheck`, written by O8 when it lands), and the
  PR head equals the commit the user approved for push.
- Every wait has a plain reason (push card line, Inbox notification when the
  user must act). Merge is requested with `sha` pinned; never forced.
- **Rule 5 exception, recorded:** the merge writes an `approvals` row
  `kind: "merge_pr"`, `status: "approved"`, `decidedBy: "auto"` plus an audit
  row `pr.auto_merge`. It applies only to a PR whose every commit the user
  already approved for push, and only in projects with the switch on. Push
  approvals are unchanged (always the user's click).
- Knobs: `FHARA_AUTO_MERGE_MAX_LINES` (400), `FHARA_AUTO_MERGE_SENSITIVE`
  (globs), `FHARA_AUTO_MERGE_METHOD` (squash).

### O4 Issue → draft task
- Only issues opened by the connected GitHub login, carrying the project's
  label (default `fhara`). Anything else is ignored with an audit row.
- Creates a DRAFT (`issueDrafts` row) shown in the Inbox. Never started: the
  user presses Start (the chat-never-starts-a-task rule holds; no auto-start
  option is offered).
- "Already done?" preflight: merged PRs that reference the issue, and a
  closed issue, mark the draft "looks done"; Start then needs a confirm.
- Status labels go back on the issue (`fhara:draft`, `fhara:running`,
  `fhara:done`, `fhara:failed`). OFF by default, per-project switch.

### O7 Research fan-out
- Explicit only: a task whose command starts with `/research`. The plan is
  built deterministically: 2–4 read-only Researcher angles in parallel plus
  one synthesis node that depends on all of them. Each node is an ordinary
  subtask, so the budget gate runs before each LLM call.

### O6 Phone-friendly Inbox and approvals
- Inbox and approval cards are responsive.
- `FHARA_BIND_TAILSCALE=1` makes the web server listen on the Tailscale
  address (plus 127.0.0.1). No URL token and no login: the tailnet is the
  boundary. Without a Tailscale address the server refuses to start rather
  than falling back to 0.0.0.0.
- Approvals are bound to a fingerprint of what was shown plus an expiry
  (10 minutes): approve/reject with a fingerprint that no longer matches, or
  past the expiry, is refused. Calls without one keep the old behaviour.

## State

See `plans/README.md`.
