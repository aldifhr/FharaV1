# Plan 077: Add DevOps to the fixed team

## Status

- State: DONE
- Priority: P2
- Size: S
- Risk: MEDIUM
- Dependencies: 040
- Planned at: 2026-11-23

## Why this is needed

The fixed team has no dedicated owner for CI, container, and infrastructure changes.

## Target behaviour

Seed a DevOps role in the fixed team and route CI/deployment work to it. Enforce the existing Plan 040 path limits (`.github/**`, `Dockerfile*`, `docker-compose*`, `infra/**`) and allowlisted shell commands.

## Steps

1. Add DevOps to the role registry, prompt source, seed order, and visible ordering.
2. Restore DevOps routing and update planner/capability/executor policy descriptions.
3. Update role, roster, routing, and prompt tests; run focused checks.

## Test plan

- Role permissions allow writes only to the Plan 040 DevOps paths and deny pushes.
- Fixed-team sync seeds one DevOps role with its intended tools.
- CI/deployment chat requests route to DevOps when present and Backend when absent.
- Worker and API focused checks pass.

## Completion criteria

- [x] DevOps is seeded and shown in the fixed team.
- [x] DevOps task routing and scoped permissions are enforced.
- [x] Focused checks pass.

## STOP conditions

- The change requires weakening Plan 040 permissions or changing schema.
