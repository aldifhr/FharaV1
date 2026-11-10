# 045 — Role memory: each role writes its own notes per project

State: IMPLEMENTED (convex-test + worker unit tests; browser check pending)

## Why
The user asked that every role (CTO, Designer, Frontend, Backend, QA, Reviewer,
DevOps, Researcher, Support) keep its own memory per project and write it by
itself. Before this, agent-scope memories were keyed by agentId only (global
across projects) and the L5 suggestions needed the user's acceptance.

## Design
- Storage (additive): a `memories` row with `scope: "agent"`, the role's
  `agentId` AND a `projectId` is that role's note in that project. Index
  `by_project_agent [projectId, agentId]`. Agent rows without `projectId`
  stay valid ("this agent, every project"). Project toggle
  `projects.roleMemoryDisabled` (absent = on).
- Write: after a task finalizes, the worker makes ONE budget-gated call per
  role that completed subtask work (its subtasks batched; ≤ ~3.8k chars in,
  ≤ 5 short learnings out: title, content, kind fact|convention|pitfall).
  `worker.recordRoleLearnings` → `roleMemories.upsertLearnings` writes them
  UNPINNED, source "agent", without approval. Secrets masked twice
  (worker `redactText`, backend `redactSecrets`); diffs refused; dedupe by
  normalized title/content + token similarity (update instead of insert;
  pinned or user-written notes are never rewritten); cap 50 per role per
  project, evicting the oldest unpinned agent-written rows.
- Recall: pinned shared + pinned project + pinned own agent rows (global or
  this project); full-text recall over shared, project, own role@project and
  own legacy global rows. A role never sees another role's rows nor its own
  rows from another project. Personal chat (no project) sees only global
  agent rows. Budget caps unchanged.
- Off switch: project "Role memory" toggle stops writes (zero LLM calls);
  existing rows are still recalled. `FHARA_ROLE_MEMORY=0` disables it on a
  worker.
- Cascade: rows carry `projectId`, so `PROJECT_CASCADE`'s `memories/by_project`
  already removes them (tested).

## Not done
- Live run with a real provider and the /memory + Manage project UI in a
  browser.
