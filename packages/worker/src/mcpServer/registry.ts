/**
 * GOAT G12a: the Fhara MCP tool registry — one list of `resource.verb` tools.
 *
 * Every tool declares its access ("read" for now), a one-line summary, a zod
 * input schema (the JSON Schema `describe` returns is derived from it) and
 * a handler over `McpReadSource`. The MCP `tools/list` never lists these
 * directly: it shows the two-tool core listing (`describe`, `call`, see
 * protocol.ts), so an agent pays for a tool's schema only when it asks.
 *
 * Pattern from GOAT `packages/contracts/src/agentSurface/registry.ts` and
 * `apps/server/src/mcp/McpToolAccess.ts` (https://github.com/goat-si/goat,
 * commit 718f5b11), MIT License, Copyright (c) 2026 T3 Tools Inc.,
 * Copyright (c) 2026 goat-si contributors. No code is copied; written for
 * Fhara, 2026-11. See THIRD_PARTY_NOTICES.md (## GOAT).
 */
import { z } from "zod";
import type { McpReadSource, McpToolAccess } from "./types";

export const TASK_STATUSES = [
  "queued",
  "running",
  "needs_approval",
  "waiting_input",
  "paused",
  "done",
  "rejected",
  "failed",
  "cancelled",
] as const;

export interface McpTool {
  path: string;
  access: McpToolAccess;
  summary: string;
  input: z.ZodType;
  run(source: McpReadSource, args: unknown): Promise<unknown>;
}

function tool<S extends z.ZodType>(def: {
  path: string;
  access: McpToolAccess;
  summary: string;
  input: S;
  run(source: McpReadSource, args: z.infer<S>): Promise<unknown>;
}): McpTool {
  return def as unknown as McpTool;
}

const id = z.string().min(1).max(64);

export const MCP_TOOLS: readonly McpTool[] = [
  tool({
    path: "task.status",
    access: "read",
    summary: "One task: title, status, mode, pending question, error, and its subtask counts by status.",
    input: z.object({ taskId: id.describe("The task id") }).strict(),
    run: async (source, args) => (await source.taskStatus(args)) ?? { found: false, taskId: args.taskId },
  }),
  tool({
    path: "task.list",
    access: "read",
    summary: "Newest tasks first, optionally for one project and/or one status (at most 50).",
    input: z
      .object({
        projectId: id.optional().describe("Only tasks of this project"),
        status: z.enum(TASK_STATUSES).optional().describe("Only tasks in this status"),
        limit: z.number().int().min(1).max(50).optional().describe("How many (default 20)"),
      })
      .strict(),
    run: (source, args) => source.taskList(args),
  }),
  tool({
    path: "memory.search",
    access: "read",
    summary: "Full-text search of shared memories, plus one project's memories when projectId is given (at most 10).",
    input: z
      .object({
        text: z.string().min(1).max(500).describe("What to look for"),
        projectId: id.optional().describe("Also search this project's memories"),
        limit: z.number().int().min(1).max(10).optional().describe("How many (default 10)"),
      })
      .strict(),
    run: (source, args) => source.memorySearch(args),
  }),
];

const BY_PATH = new Map(MCP_TOOLS.map((t) => [t.path, t]));

export function findTool(path: string): McpTool | undefined {
  return BY_PATH.get(path);
}

/** The listing `describe` returns with no path: every tool's path, access and summary. */
export function toolIndex(): Array<{ path: string; access: McpToolAccess; summary: string }> {
  return MCP_TOOLS.map(({ path, access, summary }) => ({ path, access, summary }));
}

/** One tool in full: its index entry plus the JSON Schema of its input. */
export function describeTool(t: McpTool): { path: string; access: McpToolAccess; summary: string; inputSchema: unknown } {
  const { $schema: _drop, ...inputSchema } = z.toJSONSchema(t.input) as Record<string, unknown>;
  return { path: t.path, access: t.access, summary: t.summary, inputSchema };
}

/** True when every registered tool only reads (G12a): `call` is then read-only too. */
export function registryIsReadOnly(): boolean {
  return MCP_TOOLS.every((t) => t.access === "read");
}
