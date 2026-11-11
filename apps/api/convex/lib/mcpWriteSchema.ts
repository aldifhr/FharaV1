/**
 * GOAT G12b: tables behind the Fhara MCP server's write tools (additive).
 *
 * - `mcpWrites`: one row per accepted write, keyed by the caller's
 *   `clientRequestId`. A retried call with the same id returns the stored
 *   result instead of writing again.
 * - `taskDrafts`: a task an MCP caller asked for that nobody approved yet.
 *   Nothing runs until the user starts it (taskDrafts.start), the same rule
 *   as a chat Create task offer: chat and MCP never auto-start a task.
 */
import { defineTable } from "convex/server";
import { v } from "convex/values";
import { permissionModeValidator } from "./permissionModes";

export const mcpWriteToolValidator = v.union(
  v.literal("task.create"),
  v.literal("thread.send"),
  v.literal("run.report_result"),
  v.literal("question.ask")
);

export const taskDraftStatusValidator = v.union(v.literal("draft"), v.literal("started"), v.literal("dismissed"));

export const mcpWriteTables = {
  mcpWrites: defineTable({
    clientRequestId: v.string(),
    tool: mcpWriteToolValidator,
    // The tool's result as first returned (without `deduped`).
    result: v.any(),
    createdAt: v.number(),
  }).index("by_client_request_id", ["clientRequestId"]),

  taskDrafts: defineTable({
    projectId: v.id("projects"),
    title: v.string(),
    command: v.string(),
    permissionMode: permissionModeValidator,
    source: v.literal("mcp"),
    // Why it is a draft and not a started task (lib/mcpWritePolicy.ts).
    reason: v.string(),
    conversationId: v.optional(v.id("conversations")),
    status: taskDraftStatusValidator,
    taskId: v.optional(v.id("tasks")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project_and_status", ["projectId", "status"])
    .index("by_status_and_updated", ["status", "updatedAt"]),
};
