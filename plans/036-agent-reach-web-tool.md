# Plan 036: Agent Reach web tool for read-only agents

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

- Priority: P2
- Size: M
- Risk: MEDIUM
- Dependencies: —
- Planned at: worktree `main`, 2026-11-10

## Why this is needed

Fhara's read-only agents (research / audit) can only answer from the
repository context. The runner fetches URLs that appear in a request
(`packages/worker/src/execution/agentExecutor.ts:1866`), but the agent has no
tool it can call to search the public web or read a platform that blocks
plain HTTP (YouTube subtitles, V2EX, GitHub issues, Bilibili).

Agent Reach (`https://github.com/Panniantong/Agent-Reach`) is a read-only CLI
that already solves that: one command per platform, JSON output, no API fees.
The user asked for exactly this capability in Fhara, with public channels
only (no logged-in platforms, so no browser session or cookie on the worker
machine).

The decision (recorded with the developer): implement it as a **native
governed worker tool** (`web_reach`), not as an MCP server.

## Target behaviour

- A read-only agent whose `supportedTools` contain `web_reach` can search the
  public web and read public platform content during a research or audit
  subtask, through a bounded tool loop.
- Only these channels are reachable, each with an explicit action list:
  `web`, `v2ex`, `youtube`, `github`, `bilibili`.
- No write, post, comment, like or login action exists in the allowlist, so
  the tool is read-only by construction.
- Every call is audited, redacted, time-boxed and aborted with the task.

## Current state

- `packages/worker/src/tools/webClient.ts:105` — `assertUrlAllowed` is the
  only outbound-URL guard; it lives next to the Stagehand import.
- `packages/worker/src/mcp/toolLoop.ts:68` — `runMcpToolLoop` is the only
  bounded tool loop; it is MCP-shaped but the loop itself is generic.
- `packages/worker/src/execution/agentExecutor.ts:1533` — `executeReadOnly`
  lists governed tools in the prompt, but no host tool is executable there.
- `packages/worker/src/orchestrator/policy.ts` — the only place execution
  limits are read (`loadPolicy`).
- `packages/worker/src/services/runner/setup.ts:285` — `mcpForTask` is the
  pattern for turning policy into executor input.

## Decisions that must not change during execution

- The tool stays read-only. No channel/action that writes, posts, comments,
  likes, messages or logs in is added.
- Only public channels. A channel that needs a login session stays out of
  the allowlist even if Agent Reach supports it.
- The argv is built from a fixed enum list plus validated values. No shell,
  no prefix matching, no user-supplied flags.
- Provider keys never cross to the worker in plaintext; Agent Reach needs no
  key for the public channels.
- The tool is opt-in per agent (`supportedTools`), like every other governed
  tool.

## Steps

### Step 1: URL guard in its own module

Move `isBlockedHost` / `extractDomain` / `assertUrlAllowed` to
`packages/worker/src/tools/urlGuard.ts` and re-export them from
`webClient.ts`, so the Agent Reach tool can use the guard without importing
Stagehand.

**Check**: `npm run --workspace=@fhara/worker typecheck` + the existing
`webClient.test.ts`.

### Step 2: The Agent Reach tool implementation

`packages/worker/src/tools/agentReach.ts`:

- `AGENT_REACH_CHANNELS`: channel → allowed actions, whether the action
  takes an argument, whether it takes `--limit`.
- `buildAgentReachArgs({channel, action, query, limit})`: validates the
  channel/action against the enum, the argument (length, control chars, no
  leading `-`), URL arguments through `assertUrlAllowed`, and the limit
  range; returns the exact argv.
- `runAgentReach(request, options)`: runs the binary with
  `execFile` (no shell, scrubbed child env, timeout, abort signal) and
  parses the JSON envelope into `{ok, items, error}`.

**Check**: `packages/worker/tests/agentReach.test.ts`.

### Step 3: A generic bounded tool loop

Extract the loop body of `mcp/toolLoop.ts` into
`packages/worker/src/tools/toolLoop.ts` with an injectable prompt set;
`mcp/toolLoop.ts` keeps its API and delegates. Prompt wording lives in
`packages/worker/src/prompts/`.

**Check**: the existing MCP tests + `npm run --workspace=@fhara/worker typecheck`.

### Step 4: Wire the tool into the read-only path

`packages/worker/src/execution/webReachTools.ts` exposes the tool definition
and the audited call; `executeReadOnly` runs the loop when the agent declares
`web_reach`, the policy enables it, and the mode is research or audit.

**Check**: `packages/worker/tests/webReachTool.test.ts`.

### Step 5: Policy knobs and plumbing

`loadPolicy` gains `agentReachEnabled`, `agentReachTimeoutMs`,
`agentReachMaxItems`, `agentReachMaxToolIterations`,
`agentReachCommand`. `webReachForTask` (services/runner/setup.ts) turns the
policy into the executor input; `taskRunner.ts`, `resume.ts`, `runNodes.ts`
pass it through.

**Check**: `npm run --workspace=@fhara/worker typecheck` + `npm test`.

### Step 6: Make the tool reachable

The agent's `supportedTools` is the gate, and the agent editor had no way to
set it. `apps/api/convex/lib/toolNames.ts` lists the governed tools, the
agent form gains a "Tool permissions" fieldset, and the researcher role
default includes `web_reach` (`apps/api/convex/lib/roles.ts`).

**Check**: `npm run --workspace=@fhara/web typecheck` + `npm run --workspace=@fhara/api test`.

### Step 7: Docs

`packages/worker/AGENTS.md` (tool + env table), `README.md` (install and
use), `.env.example` (the knobs).

**Check**: read the files.

## Test plan

- The invariant each test protects.
  - Only allowlisted channels/actions produce an argv.
  - A private / loopback / metadata URL argument is refused.
  - A query with control characters or a leading `-` is refused.
  - The limit is clamped to the allowed range.
  - The CLI envelope is parsed; `ok:false` becomes an error result, not a
    crash.
  - A missing binary becomes an error result, not a task failure.
  - The loop is bounded and a tool call the model hallucinates is refused.
- Negative cases: unknown channel, unknown action, write-ish action, private
  URL, oversized query, non-numeric limit.

## Completion criteria

- `npm run --workspace=@fhara/worker typecheck` passes.
- `npm test` (worker suite) passes.
- `npm run knip` reports no new unused file/export.
- `plans/README.md` lists plan 036 as `DONE`.

## STOP conditions

- A non-negotiable rule in `AGENTS.md` must change.
- A schema change needs a destructive operation.
- A check fails twice after a reasonable fix.
- The change needs work outside this repository (installing Agent Reach on
  the worker machine is operator work, not repo work — it is documented, not
  required for the checks above).
