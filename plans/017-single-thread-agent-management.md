# Plan 017: Orchestrator / Executor / Lead management through a single thread/UI

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

- Priority: P2
- Size: M
- Risk: LOW
- Dependencies: 007 (project agent registry and conversation participation)
- Planned at: commit `a6c7709`, `2026-11-08`

## Why this is needed

Agent management is scattered across at least four places: the Sidebar "Team"
list (create/edit/delete agents), the chat header avatar stack (open agent),
the "Manage project" modal (assign agents to a project), and the agent detail
modal (capabilities, tools, history). A user who wants to see or change who
the Orchestrator, the Lead, or the Executors are must jump between all of
them. There is no single thread/UI that answers "who is doing what right
now, and how do I change it" in one place.

## Target behaviour

| Today | After this plan |
| --- | --- |
| Management split across Sidebar, chat header, Manage-project modal, detail modal | One "Team thread" panel in the project chat view groups agents as Orchestrator (CTO), Lead, and Executors (Engineering/Quality/Research/Product roles), each row showing live execution status from the backend lease |
| Clicking an avatar only highlights the agent (`openAgent` sets `highlightAgentId`) | Clicking a row opens that agent's detail/management actions in the same thread context, and offers "mention in chat" which inserts `@Role` into the composer draft |
| Project team assignment only via Manage-project modal checkboxes | The same panel offers add/remove from this project for each agent, reusing `api.projects.updateTeam` |
| Create/edit agent only from Sidebar modals | Create/edit remain available, but are launched from the single panel (Sidebar entry points delegate to it instead of duplicating form code) |

Out of scope: changing who the orchestrator *is* at runtime (that stays a
worker policy decision), adding a new backend table, or a new `/agents` route.

## Current state

Role model (worker, authoritative):

- `packages/worker/src/orchestrator/roles.ts:43-52` — `lead` role definition
  (Leadership, coordination/delegation, `read_file` only).
- `packages/worker/src/orchestrator/roles.ts:53-61` — `cto` role definition,
  commented as "Leadership, mandatory Orchestrator"; read-only, no code writing.
- `packages/worker/src/orchestrator/roles.ts:163-166` — `normalizeRole` maps
  `orchestrator` / `planner` / `architect` to `cto`. There is **no** `executor`
  role in the registry: executors are the implementer roles (`frontend`,
  `backend`, `devops` at `roles.ts:71-88,116-124`) plus `qa`/`reviewer`
  (`roles.ts:89-97,125-133`). Any UI grouping must call these "Executors",
  not invent an `executor` role.
- `packages/worker/src/router/selectAgents.ts:17` — the CTO/orchestrator is
  never forced to answer chat; selection is capability-based.

Web labels (mirror):

- `apps/web/lib/agentRoles.ts:5-19` — `ROLE_LABELS` display labels.
- `apps/web/lib/agentRoles.ts:21-30` — `FIXED_ROLE_KEYS` (lead, cto, designer, frontend, backend, qa, growth, support).
- `apps/web/lib/agentRoles.ts:53-54` — default prompts: Lead = WHAT/spec, CTO = HOW/architecture.

Management surface today:

- `apps/web/components/Sidebar.tsx:435-595` — "Team" section: list, status
  from `api.executionView.activeByAgent`, expand, edit, delete.
- `apps/web/components/Sidebar.tsx:605-665` — Create-agent modal.
- `apps/web/components/Sidebar.tsx:666-762` — Edit-agent modal (incl. LLM assignment).
- `apps/web/components/Sidebar.tsx:597-603` — `AgentDetailPanel` opened from the Team list.
- `apps/web/components/AgentDetailPanel.tsx:167-352` — detail modal: role,
  capabilities, tool permissions, assigned projects/tasks, execution history
  (`api.agents.getDetail`, `api.agents.getExecutionHistory`).
- `apps/web/components/ChatPanel.tsx:456,513-567` — chat header avatar stack;
  click calls `onOpenAgent`.
- `apps/web/app/WorkspaceClient.tsx:30-32` — `openAgent` only sets
  `highlightAgentId`; it does not open a detail view or a thread.
- `apps/web/app/WorkspaceClient.tsx:91-117` — shell layout: `IconRail` +
  `Sidebar` + chat `children` + per-task `TaskThreadPanel` (opened by
  `selectedTaskId`, not by agent).
- `apps/web/components/ChatPanel.tsx:282-319` — Manage-project modal saves
  name/path/approval/instructions and team via `api.projects.updateTeam`.
- `apps/web/components/ChatPanel.tsx:868-889` — raw checkbox list of all
  agents for team assignment (no grouping, no status).
- `apps/web/app/chats/[id]/ChatSection.tsx:9-26` — chat route entry; holds
  `tab` state (`chat` | `tasks` | `files`).

Backend (read-only from the UI, no schema change needed):

- `apps/api/convex/agents.ts:49` — `agents.list` query.
- `apps/api/convex/agents.ts:225` — `agents.create` mutation; `:284` — `agents.update`; `:378` — `agents.getDetail`.
- `apps/api/convex/projects.ts` — `projects.updateTeam` (used by ChatPanel).

## Decisions that must not change during execution

- **One planning authority stays.** The orchestrator (CTO) remains the single
  planning authority (`ORCHESTRATOR_AUTHORITATIVE`, `packages/worker/AGENTS.md`).
  This plan is presentation/management only — no worker, planner, or routing
  change, and no second management path that can reassign runtime roles.
- **No new "executor" role.** Grouping labels are UI-only: Orchestrator =
  `cto`, Lead = `lead`, Executors = engineering/quality roles. Do not add a
  role to `ROLE_DEFINITIONS` or `FIXED_ROLE_KEYS`.
- **No schema change.** Reuse `api.agents.*`, `api.projects.updateTeam`,
  `api.executionView.activeByAgent`, `api.approvals.*` as they exist. If a
  step needs a new query, stop (see STOP conditions).
- **Single entry point, not a second copy.** The new panel becomes the one
  place that launches create/edit/detail/assign. Sidebar and Manage-project
  controls delegate to it (or are removed); do not keep two live edit forms
  for the same agent in two components.
- **UI never executes work.** Per `apps/web/AGENTS.md`: the UI reads Convex
  state and writes intent only. Status comes from the execution lease, never
  from persisted `agents.status`.

## Steps

### Step 1: Grouping helper (pure, tested by typecheck only)

Add `apps/web/lib/agentGroups.ts` exporting
`groupAgents(agents): { orchestrator: Agent[]; lead: Agent[]; executors: Agent[]; other: Agent[] }`
where `orchestrator` = role `cto`, `lead` = role `lead`, `executors` =
`frontend | backend | devops | qa | reviewer`, `other` = the rest. Sort each
group by role label. No Convex import; operates on plain objects with a
`role` field.

**Check**: `npm run --workspace=@moagent/web typecheck` → exit 0.

### Step 2: Single "Team thread" panel component

Add `apps/web/components/TeamThreadPanel.tsx` ("use client"):

- Queries `api.agents.list`, `api.executionView.activeByAgent`,
  `api.projects.get` (for `agentIds`), reusing `statusFromActive` from
  `AgentDetailPanel.tsx` for the status label.
- Renders the four groups from Step 1 with a header row per group
  (Orchestrator / Lead / Executors / Other), each agent row showing avatar,
  role label, live status, and project membership.
- Row actions (every button must have a working `onClick`):
  - **Details** → opens `AgentDetailPanel` for that agent.
  - **Mention** → inserts `@<RoleLabel> ` into the chat draft. This requires
    lifting the draft setter up: `ChatSection` already owns `tab`; pass an
    `onMention(roleLabel)` callback through `ChatPanel` to `ChatComposer`'s
    draft state. If lifting the draft proves invasive, STOP and report
    rather than duplicating a second composer.
  - **Edit** → opens the existing edit-agent form. Extract that form from
    `Sidebar.tsx:666-762` into `components/AgentForm.tsx` first, then have
    both the panel and Sidebar render it — one form, two launchers max.
  - **Add to / remove from this project** → `api.projects.updateTeam` with
    the current `agentIds` ± this agent, mirroring `ChatPanel.tsx:294-319`.
- **Create agent** button at the panel top → same extracted `AgentForm`
  in create mode (from `Sidebar.tsx:605-665`).
- Loading state: render skeleton rows while `agents === undefined`
  (per web AGENTS.md, never an empty state as a loading state).

**Check**: `npm run --workspace=@moagent/web typecheck` → exit 0.

### Step 3: Mount it in the single thread

- Add a `"team"` tab to `ChatSection.tsx` (`tab` state is
  `"chat" | "tasks" | "files"` today at `ChatSection.tsx:11`); extend
  `ChatPanel` props (`tab`, `setTab`) and its tab bar
  (`ChatPanel.tsx:572-585`) with a `Team` tab rendering `TeamThreadPanel`
  with the same `projectId`. Default tab stays `chat`.
- Wire the chat-header avatar stack (`ChatPanel.tsx:519-534`) so clicking an
  agent switches to the Team tab and highlights that row, instead of only
  calling `openAgent`/`highlightAgentId`. Keep `openAgent` for backwards
  compatibility if other callers exist.
- Remove the now-duplicated team-assignment checkbox fieldset from the
  Manage-project modal (`ChatPanel.tsx:868-889`) and its
  `manageAgentIds` state, since assignment now lives in the Team tab;
  `handleSaveProject` keeps saving the remaining fields and must no longer
  call `updateTeam`.

**Check**: `npm run --workspace=@moagent/web typecheck` → exit 0;
`npm run --workspace=@moagent/web build` → exit 0 (routing/tab change).

### Step 4: De-duplicate Sidebar

- Replace the Sidebar Team section's create/edit/detail launchers with
  links that navigate to `/chats/<projectId>?tab=team` (or, when no project
  is open, keep the modal but render the extracted `AgentForm`). The goal:
  exactly one create form and one edit form in the codebase.
- Do not remove the Sidebar Team list itself in this step; it stays as the
  compact status overview.

**Check**: `npm run --workspace=@moagent/web typecheck` → exit 0;
`npm run knip` → no new unused-file/unused-export findings for the moved
form component.

### Step 5: Verify in the running app

- `npm run dev`, open a project chat, confirm: Team tab groups CTO under
  Orchestrator, Lead under Lead, frontend/backend under Executors; status
  text matches the execution lease; Mention inserts `@Role` in the
  composer; add/remove from project persists after reload; create/edit from
  the panel work; Manage-project modal no longer shows team checkboxes.
- Mark each item in Completion criteria below.

## Test plan

- No new backend or worker tests: this plan changes no contract, query, or
  mutation. The grouping helper (Step 1) is pure and covered by typecheck;
  if a unit test is added, it must assert the grouping of a fixed fixture
  (`cto` → orchestrator, `lead` → lead, `frontend`/`qa` → executors,
  `researcher` → other) and the empty-input case — nothing about timing.
- Negative cases (must hold after the change):
  - An agent with an unknown role falls into `other`, never crashes the panel.
  - Clicking Mention with no chat draft target does not throw; the Team tab
    still renders.
  - Removing the last Orchestrator (CTO) from a project shows the worker's
    existing "no orchestrator-capable agent" behaviour unchanged — the UI
    must not invent a fallback orchestrator.
- Manual smoke (Step 5) is the evidence; record what was and was not checked.

## Completion criteria

- [ ] `apps/web/lib/agentGroups.ts` exists; `cto`→Orchestrator, `lead`→Lead,
  `frontend|backend|devops|qa|reviewer`→Executors, anything else→Other.
- [ ] Team tab renders in the project chat at `/chats/<id>?tab=team` with
  live status per row.
- [ ] Every button in `TeamThreadPanel` has a working handler (Details,
  Mention, Edit, Add/Remove, Create).
- [ ] Exactly one create-agent form and one edit-agent form exist in the
  codebase (grep for the form's submit handler returns one definition).
- [ ] Manage-project modal no longer contains team-assignment checkboxes.
- [ ] Mention from the Team tab inserts `@<Role>` into the chat composer draft.
- [ ] `npm run --workspace=@moagent/web typecheck` passes.
- [ ] `npm run --workspace=@moagent/web build` passes.
- [ ] `npm run knip` reports no new findings.
- [ ] Root `npm run typecheck` run before handoff, result stated.
- [ ] Smoke steps in Step 5 executed and reported, including what was not checked.

## STOP conditions

- A non-negotiable rule in `AGENTS.md` must change (e.g. UI executing work,
  a second planning authority, a new worker-facing action without
  `assertServiceToken`).
- A schema change or a new backend query/mutation is required.
- Lifting the chat draft for Mention would require duplicating `ChatComposer`
  or forking the send path — report instead of guessing.
- A check fails twice after a reasonable fix.
- The change needs work outside this repository.
