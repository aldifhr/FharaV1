/**
 * GOAT G12a: the Fhara MCP tool registry — one list of `resource.verb` tools.
 *
 * Every tool declares its access ("read", or "write" since G12b), a one-line
 * summary, a zod input schema (the JSON Schema `describe` returns is derived
 * from it) and a handler over `McpSource`. Every write tool takes a
 * `clientRequestId` (a repeat returns the first result) and is bound by the
 * permission modes in apps/api/convex/lib/mcpWritePolicy.ts. The MCP `tools/list` never lists these
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
import type { McpSource, McpToolAccess } from "./types";

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
  run(source: McpSource, args: unknown): Promise<unknown>;
}

function tool<S extends z.ZodType>(def: {
  path: string;
  access: McpToolAccess;
  summary: string;
  input: S;
  run(source: McpSource, args: z.infer<S>): Promise<unknown>;
}): McpTool {
  return def as unknown as McpTool;
}

const id = z.string().min(1).max(64);
const clientRequestId = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .describe("Your id for this call (e.g. a UUID); repeating it returns the first result instead of writing again");

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
  tool({
    path: "task.create",
    access: "write",
    summary:
      "Ask for a task. Saved as a draft the user starts, unless approved and the project is in full access; a request from a chat is always a draft.",
    input: z
      .object({
        clientRequestId,
        projectId: id.describe("The project the task belongs to"),
        command: z.string().min(1).max(4000).describe("What the task should do, self-contained"),
        title: z.string().min(1).max(200).optional().describe("Short title (default: start of the command)"),
        approved: z.boolean().optional().describe("Start it now; only honored under the project's full access mode"),
        permissionMode: z
          .enum(["supervised", "auto_edits", "full_access"])
          .optional()
          .describe("The task's mode: the project's or stricter, never looser"),
        conversationId: id.optional().describe("The chat this request came from (always a draft)"),
      })
      .strict(),
    run: (source, args) => source.taskCreate(args),
  }),
  tool({
    path: "thread.send",
    access: "write",
    summary: "Post a note into a task's thread (shown as a System line; never a prompt to an agent).",
    input: z
      .object({
        clientRequestId,
        taskId: id.describe("The task whose thread gets the note"),
        content: z.string().min(1).max(4000).describe("The note"),
      })
      .strict(),
    run: (source, args) => source.threadSend(args),
  }),
  tool({
    path: "run.report_result",
    access: "write",
    summary:
      "Record the outcome of work you ran for a live task (thread line + task event + completion webhook). It never settles the task.",
    input: z
      .object({
        clientRequestId,
        taskId: id.describe("The task the work was for"),
        status: z.enum(["succeeded", "failed"]).describe("How the work ended"),
        summary: z.string().min(1).max(4000).describe("What was done and how it was checked"),
        links: z.array(z.string().url().max(500)).max(10).optional().describe("http(s) links to evidence (PR, CI run)"),
      })
      .strict(),
    run: (source, args) => source.runReportResult(args),
  }),
  tool({
    path: "question.ask",
    access: "write",
    summary:
      "Park a task no worker is running on a question for the user (Needs you). Refused while a worker runs it, an approval or a question is open, or it has ended.",
    input: z
      .object({
        clientRequestId,
        taskId: id.describe("The task to ask about"),
        question: z.string().min(1).max(2000).describe("One clear question"),
        options: z.array(z.string().min(1).max(200)).min(2).max(6).optional().describe("2-6 answer choices"),
      })
      .strict(),
    run: (source, args) => source.questionAsk(args),
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

/** True when every registered tool only reads: `call` is then read-only too (false since G12b). */
export function registryIsReadOnly(): boolean {
  return MCP_TOOLS.every((t) => t.access === "read");
}
