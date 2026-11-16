# Plan 058: Port FharaV2 tooling verbatim, stage by stage (C)

## Status

- Priority: P1
- Size: L
- Risk: MEDIUM
- Dependencies: 056, 057 (informs, does not block)
- Planned at: `2026-11-16`

## Why this is needed

Developer decision (recorded in session `2026-11-16`): Fhara's agent tooling
is the weak layer, and the sibling checkout `D:\CODE\FharaV2` (t3code fork)
has a mature tooling stack. Rather than hand-reimplementing each piece (the
057 approach), the packages are lifted **verbatim** into this workspace and
Effect-TS is installed. Plan 057's note that the FharaV2 drivers "cannot be
lifted as-is" was written before this decision; with `@fhara/shared` and
`@fhara/contracts` copied too (stage 2), the binding blockers it lists are
removed.

Package names in FharaV2 already use the `@fhara/*` scope (and `effect-acp`
is unscoped), so verbatim copies keep upstream merges trivial.

## Decisions that must not change during execution

- AMENDED `2026-11-16` with the developer's approval: pnpm workspaces replace
  npm workspaces to preserve FharaV2's `catalog:`, `workspace:*` and
  `patchedDependencies` verbatim. Root `packageManager` is `pnpm@12.21.0`;
  lockfiles are `pnpm-lock.yaml` (authoritative) and `package-lock.json`
  (legacy, not maintained by this plan). Scripts use `pnpm --filter` and
  `pnpm exec`. The non-negotiables below are unaffected.
- The non-negotiables hold everywhere: `resolveSandboxPath` sandboxing, the
  approval gate, the budget gate before every LLM call, one `AbortController`
  per task, terminal-task immutability, worker token gating.
- The ACP runtime is a subroutine of the existing executor, not a second
  planner or routing path.
- The legacy execution paths stay default until the ACP runtime is verified
  end-to-end.

## Steps (dependency ordered)

1. **Groundwork + `effect-acp`** — DONE `2026-11-16`.
   - Copied `D:/CODE/FharaV2/packages/effect-acp` verbatim (incl.
     `src/_generated`, `test/` fixtures) to `packages/effect-acp`.
   - `package.json`: `catalog:` → concrete (`effect ^4.1.3`,
     `@effect/* 4.1.2`), `effect-tsgo`/`vite-plus` → `tsc --noEmit` /
     `vitest run`. Root `effect` bumped `^4.1.2` → `^4.1.3`; root `typecheck`
     chains the new package.
   - `tsconfig.json` self-contained (ESNext, bundler, `.ts` import
     extensions kept for upstream-merge ease). `scripts/generate.ts` is
     excluded from typecheck: it uses APIs typed only by FharaV2's
     effect-tsgo fork (`RegExp.escape`), and the generated schemas ship
     committed.
   - Fixed a pre-existing upstream test skew: `src/agent.test.ts` still
     expected `$t3:jsonrpc:*` ids while `protocol.ts` (rebranded in
     FharaV2 itself) emits `$fhara:jsonrpc:*`. Expectations updated to the
     rebranded prefix — a string correction, not a behavioral weakening.
   - Verified: package typecheck clean, 84/84 vitest tests pass, `npm run
     knip` reports no findings for the new package (all reported findings
     are pre-existing elsewhere).
2. **Provider foundation** — DONE `2026-11-16`.
   - Copied whole: `shared`, `contracts`, `provider-core`, `provider-acp`,
     `provider-acp-registry`, `provider-testing`, `provider-opencode`, and
     `effect-codex-app-server` (upstream's actual name; the plan's
     `provider-codex-app-server` did not exist).
   - Manifests kept `workspace:*`, resolved FharaV2 catalog values to
     concrete versions, and replaced `effect-tsgo`/`vp` with `tsc`/`vitest`.
     `scripts/convert-fharav2-package.mjs` documents the pnpm adaptation.
   - Adapted `provider-opencode/src/server/v2/OpenCode2Client.ts:277` with an
     explicit `directory: string` annotation: tsc cannot infer the parameter
     through `Effect.map` where upstream's effect-tsgo could. No behavior
     change.
   - Verified: all copied packages typecheck clean. Test suites match the
     FharaV2 baseline exactly (same failing names/counts on Windows; the
     extra `provider-opencode` timeout was a flake and passed on rerun).
     `effect-codex-app-server`: 5 files / 54 tests passing.
   - Root `pnpm -r run typecheck` still fails in `apps/web`/`apps/api` on
     pre-existing role-roster edits in this working tree (`designer`,
     `reviewer`, `devops`, `researcher` removed from `roles.ts`), unrelated to
     this port. Knip has no new Stage 2 findings; four duplicate exports in
     `contracts` and the `shared` testing setup file are recorded verbatim
     from upstream.
3. **ACP execution runtime** — add an ACP branch beside the OpenCode path in
   `packages/worker/src/execution/nativeProvider.ts` (extends
   `AgentRuntimeChoice`). Budget gate before every call, task
   `AbortController` threaded through, deny-by-default policy mapped onto
   ACP client policy, events to `taskEvents`/`lifecycleHistory`. Verify via
   the `smoke` skill.
4. **MCP toolkit** — port the `McpToolAccess` / session-registry / toolkit
   patterns into `packages/worker/src/mcp/` without weakening the approval
   gate or `buildMcpChildEnv` env allowlist.
5. **Source control** — `source-control-core/-definitions/-github/-testing`
   behind `gitCheckpoint`, `gitWorktree`, `gitDiff`, `gitPush`.
6. **Secrets** — `secret-provider-core/-definitions/-onepassword` beside the
   AES-256-GCM ciphertext store; keys never leave the backend as plaintext.

## Test plan

- Each stage: typecheck of the touched workspaces + the copied packages'
  own vitest suites + `npm run knip`.
- Stage 3: worker tests for the executor seam + one live smoke run
  executing a subtask through the ACP runtime.
- The invariant each step protects: legacy paths keep passing their tests
  while a new path is added.

## Completion criteria

- All six steps done, `npm run typecheck` green, knip clean for new code,
  a smoke run exercising the ACP runtime passed.

## STOP conditions

- A non-negotiable rule in `AGENTS.md` must change.
- A schema change needs a destructive operation.
- A check fails twice after a reasonable fix.
- The change needs work outside this repository.
