# Filesystem MCP integration

Fhara treats MCP servers as **external tool providers**: the worker spawns
the server, discovers its tools over the MCP protocol, and lets agents use
those tools inside the project workspace. There is no Fhara-native
filesystem tool duplication — if a server already provides `read_file`, the
worker does not implement a second one.

Reference server: [`@modelcontextprotocol/server-filesystem`](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem).

## Configuration

Add a server on the `/integrations` page (formerly `/mcp`), or insert a row into the `mcpServers` table. Servers can be global or per project and limited to roles; see the README's Integrations section.
Only **local stdio** servers are launched by the worker today; remote HTTP
configs are stored and labelled but not started.

| Field | Meaning |
| --- | --- |
| `name` | Display name; also the server id in events. |
| `type` | `local` (spawned) or `remote` (stored only). |
| `command` | Executable to spawn, e.g. `npx`. |
| `args` | JSON-encoded string array. The token `{workspace}` is replaced with the task's workspace path at spawn time. |
| `enabled` | Disabled rows are not delivered to the worker at all. |
| `autoConnect` | Spawn at task start instead of lazily on first tool use. |
| `transport` | `stdio` (the only supported transport). |
| `allowedDirectories` | Extra absolute roots the server may touch, in addition to the workspace. |

Example (the reference filesystem server, workspace-scoped):

```json
{
  "name": "filesystem",
  "type": "local",
  "command": "npx",
  "args": "[\"-y\", \"@modelcontextprotocol/server-filesystem\", \"{workspace}\"]",
  "enabled": true,
  "autoConnect": false,
  "transport": "stdio"
}
```

The config crosses to the worker through `getRunContext` as config only —
never credentials. The worker spawns the child with a filtered environment
(`PATH`, `HOME`, …), so `CONVEX_SERVICE_TOKEN` and `PROVIDER_ENCRYPTION_KEY`
cannot leak into the MCP process.

## How agents use the tools

1. The runner seeds the shared registry for the task's workspace
   (`mcpForTask` in `services/taskRunner.ts`).
2. Read-only agents (`research`, `audit`, `analysis`) run a bounded MCP tool
   loop: the model replies `{"tool":…,"arguments":{…}}` or
   `{"answer":…}`, the worker executes the call and feeds the result back.
   `code_change` gets a read-only exploration pass whose findings are appended
   to the diff prompt.
3. Every call is re-authorized in the worker (`authorizeToolCall`) before the
   request reaches the server: absolute path only, inside the allowed roots,
   symlink-aware, and no protected names (`.env`, `.git`, `node_modules`,
   `.ssh`, `*.pem`, …).
4. Results are truncated (`ORCHESTRATOR_MCP_MAX_RESULT_CHARS`) and errors are
   masked before they are stored or logged.

## Permissions

`filterToolsForAgent` decides what the model sees; `authorizeToolCall` decides
what may execute. A tool that was filtered out is still refused at call time,
so a hallucinated tool name cannot bypass the matrix.

| Role | read / list | write / edit / mkdir | move | delete |
| --- | --- | --- | --- | --- |
| developer (`* Engineer`, `* Developer`) | yes | yes¹ | yes | never |
| qa (`QA`, `* Quality*`) | yes | no | no | no |
| researcher / audit | yes | no | no | no |
| orchestrator / lead / architect | yes | no | no | no |
| unknown / missing role | yes | no | no | no |

¹ Write-capable MCP tools are **filtered out for every role by default**
(`ORCHESTRATOR_MCP_WRITE_TOOLS=false`). `code_change` owns writes through the
approval-gated diff pipeline. Set the knob to `true` to expose
`write_file`/`edit_file`/`create_directory`/`move_file` to developers; `delete`
stays denied.

## Worker knobs

| Variable | Default | Meaning |
| --- | --- | --- |
| `ORCHESTRATOR_MCP_TOOL_LOOP` | `true` | Enable MCP tool use for read-only agents. |
| `ORCHESTRATOR_MCP_WRITE_TOOLS` | `false` | Expose write/move MCP tools to developers. |
| `ORCHESTRATOR_MCP_MAX_TOOL_ITERATIONS` | `6` | Bound on tool-loop rounds per subtask. |
| `ORCHESTRATOR_MCP_TIMEOUT_MS` | `30000` | Per-request timeout; a hung server is killed. |
| `ORCHESTRATOR_MCP_MAX_RESULT_CHARS` | `8000` | Cap on a tool result before it reaches the LLM. |

## Failure behaviour

A dead, slow, or misbehaving server never fails the task: the registry returns
an empty tool list (plus a `mcp.server_error` event) and the subtask runs on
its existing path. Events (`mcp.tool_call`, `mcp.tool_denied`,
`mcp.tool_error`, `mcp.server_error`) carry task/agent/server/tool/action/
duration/workspace and are written to `taskEvents`; no file content or secret
material is ever included.

## Tests

| Suite | Command |
| --- | --- |
| Permissions + path checks | `npx --workspace=@fhara/worker vitest run tests/mcpPermissions.test.ts` |
| Client + registry (real stdio, fake server) | `npx --workspace=@fhara/worker vitest run tests/mcpClientAndRegistry.test.ts` |
| Tool loop | `npx --workspace=@fhara/worker vitest run tests/mcpToolLoop.test.ts` |
| Backend config | `npx --workspace=@fhara/api vitest run convex/mcpServers.test.ts` |
| Scope, secrets, test connection | `npx --workspace=@fhara/api vitest run convex/mcpIntegrations.test.ts` and `npx --workspace=@fhara/worker vitest run tests/mcpIntegrations.test.ts` |
| End-to-end (official server, opt-in) | `RUN_MCP_E2E=1 npx --workspace=@fhara/worker vitest run tests/mcpFilesystem.e2e.test.ts` |
