# Plan 082 — route verification steps through the governed command path

- Date: 2026-11-27
- State: TODO
- Priority: P2
- Size: M
- Risk: MEDIUM
- Dependencies: —
- Planned at: commit `d6cf0a6c83`, 2026-11-27

## Why this is needed

Verification is the one command-execution path in the worker that does not use
the governed shell tools. It builds a command string and spawns it with
`shell: true`, so it bypasses the exact-argv allowlist, the L2 shell guard and
the bwrap OS sandbox that every agent-facing command goes through. Its binary
fallback interpolates a path derived from `changedFiles`, so a workspace
directory whose name contains shell metacharacters can inject a command that
runs unconfined.

## Current state

- `packages/worker/src/execution/verification.ts:494` —
  `spawn(command, { cwd, shell: true, ... })` with no allowlist, shell guard or
  sandbox check.
- `packages/worker/src/execution/verification.ts:429-449` — `buildCommand`
  returns `` `${manager} run ${name}` `` for package scripts (both parts are
  fixed literals) or `` `"${binary}" ${fallback.args.join(" ")}` `` for the
  `tsc --noEmit` fallback.
- `packages/worker/src/execution/verification.ts:452-465` — `resolveLocalBinary`
  builds `binary` from `targetDir`, which comes from `findPackageDir`
  (`verification.ts:392-401`) resolving a workspace-relative `changedFiles`
  entry (`services/runner/verifyLoop.ts:65`, `finalize.ts:97`).
- `packages/worker/src/tools/runCommand.ts:60-88` and
  `packages/worker/src/tools/runPty.ts:169-198` — the governed paths: exact
  argv allowlist, shell guard, bwrap wrap, scrubbed env, redacted output.
- `packages/worker/src/execution/shellRun.ts:39-80` — the shared runner
  (`runShellCommand`) that chooses PTY vs exec and enforces both paths.

## Target behaviour

- Verification steps run with the same exact-argv allowlist, shell guard,
  child env and OS sandbox as shell-agent commands.
- No command is ever built by string interpolation from a workspace path.
- Verification steps report a `blocked` check (not a silent success) when a
  command cannot be represented as allowlisted argv.

## Decisions that must not change during execution

- The agent-facing allowlist in `utils/commandAllowlist.ts` is not used as a
  general "allow any project script" switch. Verification hosts a fixed set of
  step commands (`typecheck`, `lint`, `test`, `build`), each keyed by the
  project's own `package.json` script name; adding those to the agent allowlist
  would widen it and is out of scope.
- The bwrap mode/resolution in `tools/osSandbox.ts` is unchanged. Verification
  must not silently rerun unconfined; a refusal is reported as a check, not
  retried without approval.
- No change to the approval model: verification is not an approval-gated user
  action, and this plan does not add one.
- No schema or migration change.

## Steps

### Step 1: replace the string-spawning verifier with an argv spawner

Change `runCommand` in `execution/verification.ts:468-537` to accept
`(command: string, args: string[], cwd, timeoutMs, signal)` and spawn with
`shell: false`, keeping the existing timeout, abort/killTree, bounded output
and redaction. `buildCommand` returns `{ command, args }` instead of a string:
- package scripts → `{ command: manager, args: ["run", name] }`;
- binary fallback → `{ command: binary, args: fallback.args }`, where `binary`
  is resolved through `resolveSandboxPathAsync` and checked with
  `isWithinWorkspace`, never interpolated into a shell line.

**Check**: `npx --workspace=@fhara/worker vitest run tests/verification.test.ts`
→ all pass.

### Step 2: add a verification-only command policy and wire the guards

Add a fixed verification argv policy (the five step commands above) next to
`utils/commandAllowlist.ts`. Before spawning, require the argv to be on that
policy and pass it through `shellGuardDecisionForArgv`. On rejection, record an
`inconclusive`/`blocked` check with the rule name; never fall back to a shell
string.

**Check**: `npm run --workspace=@fhara/worker typecheck` → pass.

### Step 3: regression tests for the two bypasses

- A `package.json` in a directory named with shell metacharacters must not run
  an injected command; assert the step is blocked and no side effect occurs.
- An `env` / `cat .env` style verification step must be refused by the shell
  guard and recorded as blocked.
- The normal typecheck/lint/test/build cases still run through the same argv
  path and produce the same check statuses.

**Check**: `npx --workspace=@fhara/worker vitest run tests/verification.test.ts`
→ all pass, including the new negative cases.

## Test plan

- Invariant: every verification process starts from an argv array with
  `shell: false`, after a policy check and a shell-guard check.
- Negative: metacharacter directory name, secret-reading command, command not
  on the verification policy.
- Positive: the four existing steps still produce `passed`/`failed`/`skipped`
  checks and honour cancellation.

## Completion criteria

- `execution/verification.ts` contains no `spawn(<string>, { shell: true })`.
- No command string is built from a workspace path.
- The regression tests in Step 3 pass.
- `npm run --workspace=@fhara/worker typecheck` passes.

## STOP conditions

- Adding verification commands to the agent-facing allowlist (a non-negotiable
  widening). Stop and ask.
- Changing `SANDBOX_MODE` or the bwrap profile to make verification pass.
- A schema change is needed.
