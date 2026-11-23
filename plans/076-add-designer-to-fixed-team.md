# Plan 076: Add Designer to the fixed team

## Status

- State: DONE
- Priority: P2
- Size: S
- Risk: MEDIUM
- Dependencies: 040
- Planned at: 2026-11-23

## Why this is needed

The default roster previously seeded only CTO, Frontend, Backend, and QA, so
new workspaces had no dedicated design agent.

## Target behaviour

The fixed team includes Designer. New and existing fixed-team syncs seed one
Designer agent, the team list places it beside Frontend, and design requests can
route to that agent. Designer remains read-only and hands implementation to
Frontend.

## Steps

1. Add Designer to the shared fixed-team seed and display order.
2. Update fixed-team and routing tests for the five-role roster.
3. Run focused API and web typechecks/tests.

## Completion criteria

- [x] Fixed-team sync seeds Designer with the role's existing permissions.
- [x] Team ordering and design routing include Designer.
- [x] Focused tests and web/worker typechecks pass.

## Result

Designer is now seeded between Frontend and Backend, retains read-only
permissions, and receives design-related chat routing. The focused API tests
and web/worker typechecks passed on 2026-11-23. API typecheck remains blocked by
an unrelated existing type error in `functions/devFixtures.ts:52`.

## STOP conditions

- The change requires a schema migration or weaker role permissions.
