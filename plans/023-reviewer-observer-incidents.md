# Plan 023: Second Opinion, Shadow Agent, Incident Room, Self-Improvement Lab

## Status

- Priority: P1
- Size: L
- Risk: LOW–MEDIUM (additive schema: three new tables, two optional
  fields; no change to the orchestrator/planner contract; the Reviewer runs
  in Convex actions, read-only, outside the worker's execution path)
- Dependencies: 020 (input guard / steers), 021 (Replan with note), 022
  (contracts, acceptance gates, escalation)

## Target behaviour

| Feature | Behaviour |
| --- | --- |
| Second opinion | "Second opinion" on a finished subtask (task thread, `/runs/[taskId]`) or an agent chat reply (⋯ menu). The Reviewer (agent persona, LLM: agent assignment > reviewer tier > pool) reads the subtask's contract, acceptance gates, gate results, output and diff — or the reply and the question it answered — may call only `list_files` / `grep` / `read_file`, and stores a verdict (agree / concerns / disagree), a short reason and file:line evidence in `reviewOpinions`. Never applies anything. |
| Replan with this note | Offered on concerns / disagree. Explicit only. Pending plan review → `planReview.replanPendingPlan` (same as Replan with note). Finished task → `tasks.requeueForRetry` with `planReviewNote` (completed subtasks kept). Running / queued / paused → steer through `admitTaskInput`. Audited (`review.replan_with_note`). |
| Shadow agent | `tasks.shadowAgent` (per task) and `projects.shadowAgentDefault` (new tasks; off). `orchestration.updateSubtask` schedules one observer review per newly completed subtask; notes (risk / missed requirement / suggestion) go to the task thread and `/runs`. Budget: `SHADOW_MAX_NOTES_PER_TASK` notes and `SHADOW_TOKEN_CAP_PER_TASK` estimated tokens per task, 2 repo tool calls per review. Never executes, blocks, or edits the plan. |
| Incident Room | `incidents` row opened inside the failing mutation: `completeTask(failed)`, `recoverStale` failure, `recordSubtaskAcceptance(escalated / blocked)`. Groups failure point, error, last 12 events, escalation, related audit rows (ids); owner / status / note. Idempotent per (task, trigger, subtask) while open. `/incidents` list + `/incidents/[id]` detail with Open run and Replay links. |
| Self-Improvement Lab | "Suggest fix" on `/incidents/[id]` and `/improve`. One LLM call reads the failed run (subtasks, last 40 events, incident; snapshots once that table exists) and the candidate texts (agent prompts, attached skills, role prompts of the agents in the run) and returns find/replace edits for one target. Stored as `improvementSuggestions` with a unified diff against the current text. Apply re-checks the current text (stale → refused), writes with the editors' access checks and audit shape (`agent.update` / `skill.update` / `role.update` with `source: "improve"`) plus `improve.apply`. Dismiss is audited. Nothing is automatic. |

## Rules kept

- Non-negotiable 5 (approval gate): untouched — the Reviewer has no write
  tool at all; `runReviewerLoop` only forwards read tools.
- Non-negotiable 6 (budget before the call): the Reviewer and the
  suggestion call gate on an estimated token cap before every LLM call. The
  chat LLM client reports no usage, so tokenUsage rows are `estimated`.
- Terminal tasks stay immutable for workers; only the user's explicit
  "Replan with this note" re-queues one, through the same path as Retry.

## Tests

- `apps/api/convex/reviewerObserver.test.ts`: parsing, read-only loop,
  pre-call token gate, second opinion and shadow review leave task /
  subtasks / fileChanges / approvals / plans / taskInputs / agents unchanged,
  token + audit rows, replan paths, shadow budget, project default.
- `apps/api/convex/incidentsImprove.test.ts`: incident triggers (failed,
  done, escalation idempotency, stale recovery), owner/status audit, diff
  helpers, suggestion → diff → Apply (audited) / stale refusal / Dismiss.

## Not done / follow-ups

- Snapshots: `improve.getSuggestionContext` passes `snapshots: []` until the
  context-snapshot table lands.
- Live smoke with a real provider and a browser pass are pending.
