/**
 * GOAT G12a: the MCP JSON-RPC surface of the Fhara MCP server.
 *
 * `tools/list` returns the core listing only — `describe` and `call` — so a
 * connected agent's context carries two small schemas instead of every
 * tool's. `describe` with no path lists the registry (path, access,
 * summary); with a path it returns that tool's input schema. `call` runs a
 * registry tool by path with its arguments. Tool failures (unknown path,
 * bad arguments, a source error) come back as `isError` results, as MCP
 * asks, never as transport errors; protocol mistakes are JSON-RPC errors.
 *
 * The core-listing idea is a pattern from GOAT `apps/server/src/mcp/`
 * (`OrchestratorMcpService.ts`, `ToolDispatch.ts`; https://github.com/goat-si/goat,
 * commit 718f5b11), MIT License, Copyright (c) 2026 T3 Tools Inc.,
 * Copyright (c) 2026 goat-si contributors. No code is copied; written for
 * Fhara, 2026-11. See THIRD_PARTY_NOTICES.md (## GOAT).
 */
import { describeTool, findTool, registryIsReadOnly, toolIndex } from "./registry";
import type { McpReadSource } from "./types";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
export const SERVER_INFO = { name: "fhara", version: "0.1.0" } as const;

type JsonRpcId = string | number | null;
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

export const RPC = { PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602 } as const;

export function coreListing() {
  const readOnly = registryIsReadOnly();
  return [
    {
      name: "describe",
      description:
        "List Fhara's tools (no path), or get one tool's input schema (path, e.g. \"task.status\"). Call it before `call`.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "A tool path from the listing" } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "call",
      description: "Run one Fhara tool by path with its arguments, as `describe` lists them.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "A tool path, e.g. \"task.list\"" },
          args: { type: "object", description: "The tool's arguments" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: false },
    },
  ];
}

const ok = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
const fail = (id: JsonRpcId, code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

function toolResult(value: unknown) {
  const structured = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : { value };
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: structured, isError: false };
}
function toolError(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function callTool(source: McpReadSource, name: unknown, args: unknown) {
  const input = isObject(args) ? args : {};
  if (name === "describe") {
    if (input.path === undefined) return toolResult({ tools: toolIndex() });
    const t = typeof input.path === "string" ? findTool(input.path) : undefined;
    return t ? toolResult(describeTool(t)) : toolError(`Unknown tool path: ${String(input.path)}. Call describe with no path for the list.`);
  }
  if (name === "call") {
    const t = typeof input.path === "string" ? findTool(input.path) : undefined;
    if (!t) return toolError(`Unknown tool path: ${String(input.path)}. Call describe with no path for the list.`);
    const parsed = t.input.safeParse(input.args ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`).join("; ");
      return toolError(`Invalid arguments for ${t.path}: ${issues}`);
    }
    try {
      return toolResult(await t.run(source, parsed.data));
    } catch {
      // Never echo a stack or a backend message verbatim: it can carry ids or tokens.
      return toolError(`${t.path} failed: backend error`);
    }
  }
  return null;
}

/** One JSON-RPC message → its response, or null for a notification (no id). */
export async function handleRpc(message: unknown, source: McpReadSource): Promise<JsonRpcResponse | null> {
  if (Array.isArray(message)) return fail(null, RPC.INVALID_REQUEST, "Batch requests are not supported");
  if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return fail(null, RPC.INVALID_REQUEST, "Invalid JSON-RPC request");
  }
  const hasId = "id" in message && (typeof message.id === "string" || typeof message.id === "number");
  if (!hasId) return null; // notifications (notifications/initialized, cancelled, …): accepted, no reply
  const id = message.id as string | number;
  const params = isObject(message.params) ? message.params : {};
  switch (message.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : MCP_PROTOCOL_VERSION;
      return ok(id, {
        protocolVersion: SUPPORTED_VERSIONS.has(asked) ? asked : MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: "Fhara orchestrator. Call `describe` to list tools, then `call` with a path and args.",
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: coreListing() });
    case "tools/call": {
      const result = await callTool(source, params.name, params.arguments);
      return result ? ok(id, result) : fail(id, RPC.INVALID_PARAMS, `Unknown tool: ${String(params.name)}`);
    }
    default:
      return fail(id, RPC.METHOD_NOT_FOUND, `Method not found: ${message.method}`);
  }
}
