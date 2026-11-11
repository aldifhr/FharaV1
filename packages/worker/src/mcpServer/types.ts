/**
 * GOAT G12a/G12b: shapes shared by the Fhara MCP server modules.
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
export type McpTaskCreateResult = FunctionReturnType<typeof api.mcpWrite.taskCreate>;
export type McpThreadSendResult = FunctionReturnType<typeof api.mcpWrite.threadSend>;
export type McpRunReportResult = FunctionReturnType<typeof api.mcpWrite.runReportResult>;
export type McpQuestionAskResult = FunctionReturnType<typeof api.mcpWrite.questionAsk>;
export type McpPermissionMode = "supervised" | "auto_edits" | "full_access";

export interface McpReadSource {
  taskStatus(input: { taskId: string }): Promise<McpTaskStatusResult>;
  taskList(input: { projectId?: string; status?: McpTaskStatusValue; limit?: number }): Promise<McpTaskListResult>;
  memorySearch(input: { text: string; projectId?: string; limit?: number }): Promise<McpMemorySearchResult>;
}

/**
 * GOAT G12b: the write door, wired to the token-gated mutations in
 * apps/api/convex/mcpWrite.ts. Every call carries the caller's
 * `clientRequestId`; a repeat returns the first result with `deduped: true`.
 */
export interface McpWriteSource {
  taskCreate(input: {
    clientRequestId: string;
    projectId: string;
    command: string;
    title?: string;
    approved?: boolean;
    permissionMode?: McpPermissionMode;
    conversationId?: string;
  }): Promise<McpTaskCreateResult>;
  threadSend(input: { clientRequestId: string; taskId: string; content: string }): Promise<McpThreadSendResult>;
  runReportResult(input: {
    clientRequestId: string;
    taskId: string;
    status: "succeeded" | "failed";
    summary: string;
    links?: string[];
  }): Promise<McpRunReportResult>;
  questionAsk(input: { clientRequestId: string; taskId: string; question: string; options?: string[] }): Promise<McpQuestionAskResult>;
}

/** Everything the registry's tools reach. */
export type McpSource = McpReadSource & McpWriteSource;

/** "read" tools never change state; "write" tools (G12b) do. Drives the MCP readOnly/destructive hints. */
export type McpToolAccess = "read" | "write";
