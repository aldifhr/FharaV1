# Plan 086: honest status labels

> Small UI/reporting fix found during live smoke testing. No schema, policy or
> non-negotiable rule changes.

## Status

- Priority: P2
- Size: S
- Risk: LOW
- Planned at: working tree after `4395b2d9`, 2026-11-26

## Why

The final task summary said `Verification: passed` while QA was not requested
and only build/lint/typecheck ran. The approval card reported `Tests: Passed`
using one blanket verification status, while the PR card reported
`Tests: Not run` for the same task. Both are misleading.

## Target

- Final summary names the checks that actually ran and states `QA not requested`.
- Approval metrics report `build` and `tests` from their own check rows;
  a missing check reads `not run`, never `passed`.

## Changes

- `services/runner/reportSummary.ts`: `buildVerificationLine`.
- `services/runner/finalize.ts`: use that line.
- `services/runner/verificationMetrics.ts`: `metricForCheck` / `verificationMetrics`.
- `services/runner/applyStage.ts`: both approval payloads use per-check metrics.
- Tests in `tests/reportSummary.test.ts`, `tests/verificationMetrics.test.ts`.

## Check

`pnpm --filter @fhara/worker exec vitest run tests/reportSummary.test.ts tests/verificationMetrics.test.ts`,
`pnpm --filter @fhara/worker run typecheck`, `pnpm run check:guards` — all green.
