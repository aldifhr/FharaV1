/**
 * GOAT G12a: shapes shared by the Fhara MCP server modules.
 *
 * `McpReadSource` is the only door from the MCP server to Fhara's data: the
 * worker wires it to token-gated Convex queries (convexSource.ts), tests
 * wire it to an in-memory fake. Results are the typed rows of
 * apps/api/convex/mcpRead.ts.
 */
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/api/convex/_generated/api";

export type McpTaskStatusResult = FunctionReturnType<typeof api.mcpRead.taskStatus>;
export type McpTaskListResult = FunctionReturnType<typeof api.mcpRead.taskList>;
export type McpMemorySearchResult = FunctionReturnType<typeof api.mcpRead.memorySearch>;
export type McpTaskStatusValue = NonNullable<McpTaskStatusResult>["task"]["status"];

export interface McpReadSource {
  taskStatus(input: { taskId: string }): Promise<McpTaskStatusResult>;
  taskList(input: { projectId?: string; status?: McpTaskStatusValue; limit?: number }): Promise<McpTaskListResult>;
  memorySearch(input: { text: string; projectId?: string; limit?: number }): Promise<McpMemorySearchResult>;
}

/** "read" tools never change state; G12b adds "write". Drives the MCP readOnly/destructive hints. */
export type McpToolAccess = "read" | "write";
