/**
 * Plan 009: Filesystem MCP integration — shared types.
 *
 * The worker treats MCP servers as an external tool provider. The wire
 * shape comes from the MCP protocol (stdio, newline-delimited JSON-RPC);
 * MOAgent does not vendor the protocol SDK — the client in `client.ts`
 * implements the three calls the worker needs (`initialize`, `tools/list`,
 * `tools/call`) with `node:child_process` only.
 */

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  ok: boolean;
  /** Flattened text content, already truncated to the configured limit. */
  text: string;
  isError: boolean;
  /** Tool-level error text from the server (isError), masked. */
  error?: string;
}

/**
 * One MCP server config row as delivered by `getRunContext`
 * (`Doc<"mcpServers">`, fields widened for the worker).
 */
export interface McpServerConfig {
  _id: string;
  name: string;
  type: string;
  url?: string;
  command?: string;
  /** JSON-encoded string[] for local servers. */
  args?: string;
  enabled?: boolean;
  autoConnect?: boolean;
  transport?: string;
  allowedDirectories?: string[];
}

export type McpToolAction = "read" | "write" | "delete" | "move" | "list" | "unknown";

export interface McpEventPayload {
  agentId: string;
  serverId: string;
  serverName: string;
  tool: string;
  action: string;
  durationMs: number;
  error?: string;
  workspace: string;
}

export type McpEventFn = (type: string, payload: McpEventPayload) => Promise<void> | void;
