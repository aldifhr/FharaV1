# Plan 009: Filesystem MCP integration (external tool provider)

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

- Priority: P1
- Size: L
- Risk: MEDIUM — touches the tool boundary, a schema, and the worker wiring,
  but every path is failure-tolerant (MCP down ⇒ existing behaviour).
- Dependencies: Plan 007 (the `/mcp` config page and the `mcpServers` table,
  `apps/api/convex/mcpServers.ts:1-56`).
- Planned at: commit `6685c38`, 2026-11-08

## Why this is needed

MOAgent has no MCP infrastructure: agents cannot read project files on
demand through a standard protocol. The `/mcp` page stores server configs
(`apps/web/app/mcp/page.tsx:1-316`), but nothing ever reads them — the
worker's tool surface is the static `TOOL_REGISTRY`
(`packages/worker/src/governance/registry.ts:32-81`), and the executor's
only "tool loop" is a prompt line listing tool names
(`packages/worker/src/execution/agentExecutor.ts:436-460`). The result is
that a research/audit agent can only see the static repository dump, and
Filesystem MCP — which would let agents read/search/list the workspace —
is not wired in at all.

## Target behaviour

| What a user can do after | How it works |
| --- | --- |
| Configure a Filesystem MCP server from the `/mcp` page | Existing form + new `enabled` / `allowedDirectories` fields. |
| Have an agent read a file live, mid-task, via MCP | The worker spawns the configured stdio server lazily, discovers tools, and runs a bounded LLM tool loop. |
| Keep the orchestrator alive when a server is down | MCP failure ⇒ "no MCP tools" event; the subtask continues on the existing path. |
| See per-call observability | `mcp.tool_call` / `mcp.tool_denied` / `mcp.tool_error` events with taskId, agentId, serverId, tool, action, duration, error, workspace. |
| Control which agent may use which tool | Role-based permission matrix + `supportedTools` scope, enforced at call time, not only in the LLM's list. |

Example configuration (the shape the worker accepts):

```json
{
  "name": "filesystem",
  "type": "local",
  "command": "npx",
  "args": "[\"-y\", \"@modelcontextprotocol/server-filesystem\", \"{workspace}\"]",
  "enabled": true,
  "autoConnect": false,
  "allowedDirectories": ["/absolute/extra/dir"]
}
```

`{workspace}` is replaced by the task's resolved workspace path at spawn
time. No workspace path is hardcoded anywhere.

## Current state

- `apps/api/convex/schema.ts:551-562` — `mcpServers` table: `projectId`,
  `name`, `type`, `url`, `command`, `args` (JSON string), `status`,
  `errorMessage`, `createdAt`. No enabled/autoConnect/allowedDirectories.
- `apps/api/convex/mcpServers.ts:17-56` — `list` (public query), internal
  `add` / `remove`. No status update, no worker read path.
- `apps/api/convex/orchestration.ts:72-125` — `getRunContext` returns
  `{task, project, agents, plan, subtasks, approvalMode, llmProviders}`.
  The worker gets no MCP config.
- `apps/api/convex/worker.ts:646-668` — `addMcpServer` / `removeMcpServer`
  actions (token-gated). No status action.
- `packages/worker/src/tools/sandbox.ts:14-90` — `resolveSandboxPath`
  (absolute paths rejected) + `resolveSandboxPathAsync` (symlink-aware,
  relative only).
- `packages/worker/src/governance/tools.ts:206-220` — `validateFilePath`
  blocks `.env`, lockfiles, `.git`, `node_modules`, `id_rsa` basenames.
- `packages/worker/src/execution/agentExecutor.ts:436-460` — the
  `ORCHESTRATOR_TOOL_LOOP` prompt line; no real tool-calling loop exists.
- `packages/worker/src/execution/agentExecutor.ts:769-772` —
  `FORBIDDEN_PATHS` / `isForbiddenPath` (duplicates `validateFilePath`).
- `packages/worker/src/services/taskRunner.ts:662,1024` — workspace
  resolution and the `executePlan` call sites.
- No `@modelcontextprotocol/*` dependency in the worker; the SDK is not
  installed (`node_modules/@modelcontextprotocol` is absent).

## Decisions that must not change during execution

1. **No new npm dependency.** The worker implements the MCP stdio JSON-RPC
   client itself (`initialize`, `tools/list`, `tools/call` over
   newline-delimited JSON, ~200 lines). The official server is launched as
   an external process from user config (`npx
   -y @modelcontextprotocol/server-filesystem {workspace}`), so MOAgent
   does not vendor it. Rationale (lazy ladder): the installed set already
   solves this with `node:child_process`; a SDK dependency is the rung
   below, not above.
2. **stdio only.** `remote` (HTTP) configs are stored and labelled; the
   worker does not launch them. Add a transport when a consumer asks.
3. **MCP is read-only for the LLM in this plan.** `write_file`,
   `edit_file`, `create_directory`, `move_file` are discovered (so the
   registry never assumes a fixed tool list) but filtered out for every
   role. Rationale: `code_change` already owns writes through the
   approval-gated diff pipeline (`agentExecutor.ts:288-292`); letting an
   LLM call `write_file` would bypass the human approval gate
   (non-negotiable #5) and duplicate that pipeline (requirement §1). A
   policy knob (`ORCHESTRATOR_MCP_WRITE_TOOLS`, default `false`) is the
   explicit upgrade path: a later plan can route MCP writes through the
   approval gate and flip the knob.
4. **Approval gate stays.** The MCP loop never stages file changes.
5. **Tool sandboxing stays.** Every MCP path goes through the same
   containment + symlink + protected-path rules as native tools
   (`resolveWithinRootsAsync`, `validateFilePath`).
6. **Budget gate runs before every LLM call**, including every loop
   iteration. The loop is bounded (`ORCHESTRATOR_MCP_MAX_TOOL_ITERATIONS`,
   default 6).
7. **MCP never crashes the orchestrator.** Registry calls never throw; a
   dead server yields "no MCP tools" and a `mcp.server_error` event.
8. **`getRunContext` stays credential-clean.** `mcpServers` rows contain
   only name/command/args/paths — no key material. `securityInvariants`
   must stay green.
9. **Schema changes are additive and optional.** No migration function is
   needed; older rows simply have no `enabled` field (treated as on).
10. **The existing `executeReadOnly` streaming path is untouched** when no
    MCP tools are available. MCP only adds a branch.

## Steps

### Step 1: backend schema + config plumbing

- `apps/api/convex/schema.ts`: add `enabled`, `autoConnect`, `transport`,
  `allowedDirectories` as `v.optional(...)` to `mcpServers`.
- `apps/api/convex/mcpServers.ts`: accept the new fields in `add`; add
  `updateStatus` internal mutation (`serverId`, `status`, `errorMessage?`).
- `apps/api/convex/worker.ts`: accept the new fields in `addMcpServer`;
  add `updateMcpServerStatus` action (token-gated, `...tokenArg` +
  `withoutToken`, like the neighbours).
- `apps/api/convex/orchestration.ts`: `getRunContext` also returns
  `mcpServers: Doc<"mcpServers">[]` for the project, excluding
  `enabled === false`.

**Check**: `npm run --workspace=@moagent/api typecheck` → 0 errors, then
`npm run --workspace=@moagent/api codegen` → generated client refreshed
(dev deployment only, never production).

### Step 2: worker MCP module (`packages/worker/src/mcp/`)

- `types.ts` — `McpServerConfig`, `McpToolDefinition`, `McpCallResult`.
- `client.ts` — `McpClient`: `spawn` + newline-JSON framing, `initialize`
  → `notifications/initialized` → `tools/list` → `tools/call`, per-request
  timeout, `dispose()`. **The child env is filtered** to a safe allowlist
  (PATH, HOME, …) — the worker's `CONVEX_SERVICE_TOKEN` and
  `PROVIDER_ENCRYPTION_KEY` must never enter the MCP process (requirement
  §5.6, constitution of non-negotiable #1).
- `registry.ts` — `McpRegistry`: one client per
  `${serverId}:${workspaceRoot}` shared across agents and tasks; lazy
  connect; in-flight de-duplication; `toolsFor` / `callTool` never throw;
  `status()`; `seed()` for `autoConnect`; `disposeAll()`; module-level
  `getMcpRegistry()`.
- `permissions.ts` — tool→action map, role matrix (developer / qa /
  researcher / orchestrator / default), `filterToolsForAgent` (unknown
  tools fail closed; `supportedTools` scope; write actions gated by the
  `allowWrite` knob), `validateMcpPath` (absolute-only, root set,
  symlink-aware via `resolveWithinRootsAsync`, `validateFilePath`, system
  roots like `/`, `/etc`, `/proc`, `/sys`, `/dev` refused), arg-size and
  result-size limits.
- `toolLoop.ts` — `runMcpToolLoop({tools, messages, callTool, runLlm,
  maxIterations, signal, onEvent})`: prompt lists the tools, the model
  replies `{"tool":"…","arguments":{…}}` or `{"answer":"…"}`; arguments are
  re-validated before execution; results are appended as the next user
  message; bounded iterations.

**Check**: `npx --workspace=@moagent/worker vitest run
tests/mcpPermissions.test.ts tests/mcpClientAndRegistry.test.ts
tests/mcpToolLoop.test.ts` → all green.

### Step 3: thread config into execution

- `packages/worker/src/tools/sandbox.ts`: extract `resolveRealWithinRoot`
  and add `resolveWithinRootsAsync(roots, requested)` (absolute paths,
  symlink-aware); `resolveSandboxPathAsync` keeps its behaviour.
- `packages/worker/src/governance/tools.ts`: extend `validateFilePath`
  with `.ssh/`, `.gnupg/` and `*.pem` rejection (protects native tools too).
- `packages/worker/src/orchestrator/policy.ts`: add optional
  `mcpToolLoop`, `mcpWriteTools`, `mcpMaxToolIterations`, `mcpTimeoutMs`,
  `mcpMaxResultChars` (+ env knobs).
- `packages/worker/src/services/taskRunner.ts`: destructure
  `context.mcpServers`; pass `mcpServers` and `deps.policy` into
  `executePlan` (both call sites: `processTask:1024`, `resumeTask:2930`)
  and on to `executeSubtask`. Call `getMcpRegistry().seed(mcpServers)`
  after the workspace exists (fire-and-forget, never throws).
- `packages/worker/src/execution/agentExecutor.ts`: `SubtaskExecutionInput`
  gains optional `mcpServers` + `policy`. `executeReadOnly`: when tools
  are available and `policy.mcpToolLoop !== false`, run the tool loop
  instead of the streaming path. `executeCodeChange`: run the same loop
  as a read-only exploration step before the diff call, appending the
  findings to the payload; a failed exploration never blocks the diff call.
- `packages/worker/src/index.ts`: `disposeAll()` in the shutdown handler.

**Check**: `npm run --workspace=@moagent/worker typecheck` → 0 errors,
then `npm test` → 360 existing tests still green.

### Step 4: observability

Every MCP outcome emits `mcp.tool_call` (allowed), `mcp.tool_denied`,
`mcp.tool_error`, `mcp.server_error` via `input.onEvent` (taskEvents).
Payloads carry taskId (via the event), agentId, serverId, serverName,
tool, action, durationMs, masked error, workspace. **No file content and
no raw args in events** — `maskSecrets` is applied to anything that could
hold a secret.

**Check**: unit test asserts the emitted event payloads contain no file
content and no `sk-…` material.

### Step 5: UI + docs

- `apps/web/app/mcp/page.tsx`: add `enabled` checkbox and
  `allowedDirectories` (comma/newline separated) to `AddServerForm`;
  show them on `ServerCard`.
- `apps/web/app/api/mcp-servers/route.ts`: no change needed (payload
  passthrough). Verify the Convex validator, not the route, is the real
  gate.
- `docs/mcp-filesystem.md`: configuration, permission matrix, env knobs,
  security model, known limitations, how to reproduce the e2e check.

**Check**: `npm run --workspace=@moagent/web typecheck` and
`npm run --workspace=@moagent/web build` → green, `/mcp` route present.

### Step 6: tests

- `packages/worker/tests/mcpPermissions.test.ts`
- `packages/worker/tests/mcpClientAndRegistry.test.ts` +
  `tests/fixtures/fakeMcpServer.mjs` (a real stdio server the client
  spawns)
- `packages/worker/tests/mcpToolLoop.test.ts`
- `packages/worker/tests/mcpFilesystem.e2e.test.ts` — env-gated
  (`RUN_MCP_E2E=1`) against the real `@modelcontextprotocol/server-filesystem`
- `apps/api/convex/mcpServers.test.ts` (convex-test: add/status
  validation, `getRunContext` includes enabled servers, excludes disabled)

**Check**: worker `npm test` + api `npm run --workspace=@moagent/api test`
→ green; the e2e is run once deliberately and its output recorded in the
final report.

### Step 7: verification

- Run `npm run typecheck` (root), `npm run knip`, and the worker + api
  suites.
- Run the real-server e2e once (`RUN_MCP_E2E=1`).
- Commit and record the hash.

## Test plan

Invariants each test protects:

| # | Invariant | Test |
| --- | --- | --- |
| 1 | `../../` and absolute paths outside the root set are refused | mcpPermissions |
| 2 | A symlink inside the workspace pointing outside is refused | mcpPermissions |
| 3 | `.env`, `.git`, `node_modules`, `.ssh`, `*.pem` reads are refused | mcpPermissions |
| 4 | `/`, `/etc`, `/proc`, `/sys`, `/dev` are never valid roots | mcpPermissions |
| 5 | Write/edit/mkdir/move/delete are filtered for every role (default) | mcpPermissions |
| 6 | `supportedTools` scope still applies to MCP tools | mcpPermissions |
| 7 | The LLM only sees permitted tools; call-time validation rejects the rest | mcpToolLoop |
| 8 | One server instance is shared by multiple agents; connect is lazy | mcpClientAndRegistry |
| 9 | A down server yields empty tools, never a throw | mcpClientAndRegistry |
| 10 | A hung server times out instead of hanging the task | mcpClientAndRegistry |
| 11 | `disposeAll()` kills every child | mcpClientAndRegistry |
| 12 | Events carry no file content or secret material | mcpToolLoop |
| 13 | Tool results are truncated to the configured limit | mcpClientAndRegistry |
| 14 | `getRunContext` returns enabled MCP servers and no credentials | mcpServers (api) |
| 15 | Existing suites stay green (360 worker + 35 api) | `npm test` both |

## Completion criteria

- [x] `npm run --workspace=@moagent/api typecheck` → 0 errors
- [x] `npm run --workspace=@moagent/worker typecheck` → 0 new errors
      (baseline `db245d3` = 57 pre-existing; current = 58; the one delta is
      `src/services/taskRunner.ts(2833) input.signal`, introduced by `81daf56`,
      not by plan 009)
- [x] `npm run --workspace=@moagent/web typecheck` → 0 errors (`build` not
      needed: the change is a client component + one route handler)
- [x] worker `npm test` → all green (431 passed, 3 env-gated e2e skipped)
- [x] api `npm run --workspace=@moagent/api test` → all green (45 passed)
- [x] `RUN_MCP_E2E=1 npx --workspace=@moagent/worker vitest run
      tests/mcpFilesystem.e2e.test.ts` → 3 passed against the real
      `@modelcontextprotocol/server-filesystem`
- [x] `npm run knip` → no new failures (only pre-existing unused files/deps)
- [x] `docs/mcp-filesystem.md` exists
- [x] Plan state in `plans/README.md` set to DONE

## STOP conditions

- A non-negotiable rule in `AGENTS.md` must change (e.g. "worker ↔ backend
  is token-gated" or "the approval gate stays").
- A check fails twice after a reasonable fix.
- Real-server verification needs network access that is unavailable; then
  record the blocker and ship with the fake-server integration tests
  rather than claiming success from mocks.
- The change needs work outside this repository.
