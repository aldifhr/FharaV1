# Plan 078: Add Lead role

## Status

- State: DONE
- Priority: P2
- Size: M
- Risk: MEDIUM
- Dependencies: 040, 076, 077
- Planned at: 2026-11-23

## Why this is needed

The fixed team has no dedicated project-facing role for clarifying outcomes,
priorities, milestones, and stakeholder context.

## Target behaviour

Add a read-only Lead to the fixed team. Lead helps clarify project outcomes and
summarize context, but does not plan task DAGs, dispatch agents, schedule work,
or make architecture decisions. The Orchestrator remains the only execution
planner; the CTO owns technical direction.

## Steps

1. Add Lead to the wire contract, shared registry, prompt source, and fixed team.
2. Add Lead's project-context routing and keep its tools and permissions read-only.
3. Update visible ordering and legacy Lead role resolution.

## Completion criteria

- [x] Lead appears in the fixed team and role menus.
- [x] Lead can be mentioned and selected for project-context conversations.
- [x] Lead cannot write files, run commands, dispatch, schedule, or replace the Orchestrator.
- [x] Existing role ids and task routing stay compatible.

## STOP conditions

- The change needs a second planning or scheduling authority.
- A permission boundary would need to be weakened.
