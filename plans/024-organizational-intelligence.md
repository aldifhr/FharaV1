# Plan 024: Organizational Intelligence (org chart, agent profile, workload manager, collaboration graph)

## Status

- Priority: P2
- Size: L
- Risk: LOW–MEDIUM (read-only projections; one opt-in routing change behind a flag, default off)
- Dependencies: 021 (Routing Inspector graph, subtask.routed role/match), Workload view (`workload.byRole`)
- Planned at: commit `1cb770e`, 2026-11-09

## Why this is needed

The Team page showed who is busy now and how work splits per role, but not
how the team is organised, how one agent performs over time, whether agents
have spare capacity, or who actually works with whom. Routing ignored load:
a busy agent kept getting work while an equally capable one sat idle.

## Target behaviour

1. **Org chart** (`/team`, `orgIntel.orgChart`, `lib/orgChart.ts`): CTO at the
   top, the eight other fixed roles under it in registry order, one node per
   custom-role agent, a vacant node for a fixed role with no agent. A node
   shows role label, enabled state, model, library skills count and tools,
   and opens the agent profile. Drawn with the shared `GraphCanvas`
   (extracted from the run page's Decomposer graph).
2. **Agent performance profile** (`/team/[agentId]`, `orgIntel.agentProfile`,
   `lib/agentProfile.ts`): window 7/30/90 days + project filter. Subtasks by
   status, success rate (done ÷ done+failed), median/avg run time, tokens and
   cost, fix subtasks and retries, first-pass review/QA rate of its work,
   verdicts it gave as reviewer/QA, latest evaluation of tasks it worked on,
   chat replies, latest 15 subtasks linking to `/runs/[taskId]`.
3. **Workload Manager**:
   - Live capacity (`orgIntel.capacity`, `lib/capacity.ts`): running +
     waiting-approval executions on live tasks per agent vs
     `maxConcurrency` (unset = 1, as the scheduler gate reads it). Running
     rows with a lapsed lease are stale and not counted.
   - Load-aware router (worker `orchestrator/loadAwareRouting.ts`, used by
     `runContext.assign`): project setting `projects.loadAwareRouting`
     (`orgIntel.setLoadAwareRouting`), else env
     `ORCHESTRATOR_LOAD_AWARE_ROUTING`, default off. Only when the normal pick
     declares the capability exactly, it picks among agents that also
     declare it exactly the one with the lowest running/limit ratio below its
     limit (ties → normal order). Load = max(this run's count, the cross-task
     snapshot read once per `runNodes` via `worker.getAgentLoad`). A changed
     pick is logged on `subtask.routed` as `loadAware: {from, to, fromRole,
     toRole, reason, load}`; the Routing Inspector and Workload view show it.
4. **Collaboration graph** (`/team`, `orgIntel.collaboration`,
   `lib/collaboration.ts`): role nodes on a ring, weighted directed edges
   for delegations (`delegations`), CTO chat handoffs, review/QA → fix owner
   (`review_fix_N` ← review roles, `fix_qa_N` ← QA roles) and cross-role DAG
   dependencies. Edge-type toggles, 7/30/90 days, project filter.
   Chat handoffs were not recorded anywhere: `chat.ts` now marks the
   teammate's reply with `messages.handoffFromAgentId`; older replies are
   inferred from the CTO's stored @mentions with the chat's own
   `selectHandoffs` rule (counted separately as inferred).

## Schema (additive)

- `projects.loadAwareRouting?: boolean`
- `messages.handoffFromAgentId?: Id<"agents">`

No new indexes. Requires a Convex deploy for the new module, fields and the
worker action.

## Completion criteria

- Pure aggregation tests (`lib/orgIntel.test.ts`), convex-test of the four
  queries (`orgIntel.test.ts`), router tests (`packages/worker/tests/loadAwareRouting.test.ts`:
  off = unchanged, on = spare capacity wins, never violates capabilities).
- Browser check of `/team` and `/team/[agentId]` with live data (pending).
