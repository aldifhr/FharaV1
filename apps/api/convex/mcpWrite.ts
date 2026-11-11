/**
 * GOAT G12b: the write side of the Fhara MCP server (audit/goat-plan-2026-11-11.md, idea #9).
 *
 * The worker's localhost MCP server (packages/worker/src/mcpServer/) answers
 * `task.create`, `thread.send`, `run.report_result` and `question.ask`
 * through these mutations. Each is worker-facing, so each takes
 * `workerToken` and checks it first (AGENTS.md non-negotiable #2).
 *
 * - Idempotent: every call carries a `clientRequestId`; an accepted write is
 *   remembered in `mcpWrites` and a repeat returns the same result with
 *   `deduped: true`, writing nothing. A refusal is not remembered, so a
 *   corrected retry can reuse the id.
 * - Permission modes (lib/mcpWritePolicy.ts): MCP never approves anything
 *   and never raises a mode; task.create saves a draft unless approved under
 *   full access, and a chat-sourced request is always a draft.
 * - Terminal tasks are immutable: question.ask and run.report_result refuse
 *   a settled task; neither ever completes or fails a task (the
 *   orchestrator owns that).
 *
 * Pattern from GOAT `apps/server/src/mcp/` (https://github.com/goat-si/goat,
 * commit 718f5b11), MIT License, Copyright (c) 2026 T3 Tools Inc.,
 * Copyright (c) 2026 goat-si contributors. No code is copied. See
 * THIRD_PARTY_NOTICES.md (## GOAT).
 */
import { mutation, type MutationCtx } from "./_generated/server";
import { v, type Infer } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { assertServiceToken } from "./lib/authz";
import { normalizeClientId } from "./messages";
import { permissionModeValidator, projectDefaultPermissionMode } from "./lib/permissionModes";
import { mcpTaskStartDecision } from "./lib/mcpWritePolicy";
import type { mcpWriteToolValidator } from "./lib/mcpWriteSchema";
import { appendTaskEvent } from "./lib/taskEvents";
import { patchTask } from "./lib/threadIndex";
import { touchBriefQuestion } from "./briefs";
import { insertQueuedTask } from "./taskDrafts";

export const MCP_TEXT_MAX = 4000;
export const MCP_QUESTION_MAX = 2000;
const TERMINAL = new Set<Doc<"tasks">["status"]>(["done", "failed", "rejected", "cancelled"]);

type Tool = Infer<typeof mcpWriteToolValidator>;
const refused = v.object({ kind: v.literal("refused"), reason: v.string(), message: v.optional(v.string()) });
const deduped = { deduped: v.boolean() };

function requestId(raw: string): string {
  const id = normalizeClientId(raw);
  if (!id) throw new Error("clientRequestId is required");
  return id;
}

/** The stored result of an earlier accepted call with this id, or null. A reuse across tools throws. */
async function replay(ctx: MutationCtx, tool: Tool, clientRequestId: string): Promise<Record<string, unknown> | null> {
  const row = await ctx.db
    .query("mcpWrites")
    .withIndex("by_client_request_id", (q) => q.eq("clientRequestId", clientRequestId))
    .first();
  if (!row) return null;
  if (row.tool !== tool) throw new Error(`clientRequestId was already used by ${row.tool}`);
  return { ...(row.result as Record<string, unknown>), deduped: true };
}

async function remember<T extends Record<string, unknown>>(ctx: MutationCtx, tool: Tool, clientRequestId: string, result: T) {
  await ctx.db.insert("mcpWrites", { clientRequestId, tool, result, createdAt: Date.now() });
  return { ...result, deduped: false };
}

function cleanText(raw: string, max: number, what: string): string {
  const text = raw.trim();
  if (!text) throw new Error(`${what} is required`);
  if (text.length > max) throw new Error(`${what} is too long (max ${max} characters)`);
  return text;
}

async function loadTask(ctx: MutationCtx, taskId: string) {
  const id = ctx.db.normalizeId("tasks", taskId);
  return id ? await ctx.db.get(id) : null;
}

/** `task.create`: a draft, or a queued task when approved under full access (never from chat). */
export const taskCreate = mutation({
  args: {
    workerToken: v.string(),
    clientRequestId: v.string(),
    projectId: v.string(),
    command: v.string(),
    title: v.optional(v.string()),
    approved: v.optional(v.boolean()),
    permissionMode: v.optional(permissionModeValidator),
    /** The chat the request came from: always a draft (chat never auto-starts a task). */
    conversationId: v.optional(v.string()),
  },
  returns: v.union(
    v.object({ kind: v.literal("task"), taskId: v.string(), projectId: v.string(), permissionMode: permissionModeValidator, ...deduped }),
    v.object({ kind: v.literal("draft"), draftId: v.string(), projectId: v.string(), reason: v.string(), ...deduped }),
    refused
  ),
  handler: async (ctx, args) => {
    assertServiceToken(args.workerToken);
    const clientRequestId = requestId(args.clientRequestId);
    const earlier = await replay(ctx, "task.create", clientRequestId);
    if (earlier) return earlier as never;
    const projectId = ctx.db.normalizeId("projects", args.projectId);
    const project = projectId ? await ctx.db.get(projectId) : null;
    if (!project) return { kind: "refused" as const, reason: "project_not_found" };
    const command = cleanText(args.command, MCP_TEXT_MAX, "command");
    const title = (args.title?.trim() || (command.length > 80 ? `${command.slice(0, 80)}...` : command)).slice(0, 200);
    let conversationId: Doc<"conversations">["_id"] | undefined;
    if (args.conversationId !== undefined) {
      const id = ctx.db.normalizeId("conversations", args.conversationId);
      const conversation = id ? await ctx.db.get(id) : null;
      if (!conversation || conversation.projectId !== project._id) {
        return { kind: "refused" as const, reason: "conversation_not_in_project" };
      }
      conversationId = conversation._id;
    }
    const decision = mcpTaskStartDecision({
      projectMode: projectDefaultPermissionMode(project),
      ...(args.permissionMode ? { requestedMode: args.permissionMode } : {}),
      approved: args.approved === true,
      fromChat: conversationId !== undefined,
    });
    if (decision.kind === "refused") return { kind: "refused" as const, reason: decision.reason, message: decision.message };
    if (decision.kind === "start") {
      const taskId = await insertQueuedTask(ctx, { project, title, command, permissionMode: decision.mode, source: "mcp" });
      return await remember(ctx, "task.create", clientRequestId, {
        kind: "task" as const,
        taskId: taskId as string,
        projectId: project._id as string,
        permissionMode: decision.mode,
      });
    }
    const now = Date.now();
    const draftId = await ctx.db.insert("taskDrafts", {
      projectId: project._id,
      title,
      command,
      permissionMode: decision.mode,
      source: "mcp",
      reason: decision.reason,
      ...(conversationId ? { conversationId } : {}),
      status: "draft",
      createdAt: now,
      updatedAt: now,
    });
    return await remember(ctx, "task.create", clientRequestId, {
      kind: "draft" as const,
      draftId: draftId as string,
      projectId: project._id as string,
      reason: decision.reason,
    });
  },
});

/** `thread.send`: a System line in the task's thread (never an LLM prompt, never a chat command). */
export const threadSend = mutation({
  args: { workerToken: v.string(), clientRequestId: v.string(), taskId: v.string(), content: v.string() },
  returns: v.union(v.object({ kind: v.literal("sent"), messageId: v.string(), taskId: v.string(), ...deduped }), refused),
  handler: async (ctx, args) => {
    assertServiceToken(args.workerToken);
    const clientRequestId = requestId(args.clientRequestId);
    const earlier = await replay(ctx, "thread.send", clientRequestId);
    if (earlier) return earlier as never;
    const task = await loadTask(ctx, args.taskId);
    if (!task) return { kind: "refused" as const, reason: "task_not_found" };
    const content = cleanText(args.content, MCP_TEXT_MAX, "content");
    const messageId = await ctx.db.insert("messages", {
      projectId: task.projectId,
      taskId: task._id,
      authorType: "agent",
      voice: "system",
      content: `MCP: ${content}`,
    });
    return await remember(ctx, "thread.send", clientRequestId, {
      kind: "sent" as const,
      messageId: messageId as string,
      taskId: task._id as string,
    });
  },
});

const resultStatus = v.union(v.literal("succeeded"), v.literal("failed"));

/** `run.report_result`: record an outside run's outcome on a live task. The task's own status is left to the orchestrator. */
export const runReportResult = mutation({
  args: {
    workerToken: v.string(),
    clientRequestId: v.string(),
    taskId: v.string(),
    status: resultStatus,
    summary: v.string(),
    links: v.optional(v.array(v.string())),
  },
  returns: v.union(
    v.object({
      kind: v.literal("recorded"),
      taskId: v.string(),
      projectId: v.string(),
      status: resultStatus,
      summary: v.string(),
      reportedAt: v.number(),
      ...deduped,
    }),
    refused
  ),
  handler: async (ctx, args) => {
    assertServiceToken(args.workerToken);
    const clientRequestId = requestId(args.clientRequestId);
    const earlier = await replay(ctx, "run.report_result", clientRequestId);
    if (earlier) return earlier as never;
    const task = await loadTask(ctx, args.taskId);
    if (!task) return { kind: "refused" as const, reason: "task_not_found" };
    if (TERMINAL.has(task.status)) return { kind: "refused" as const, reason: "task_already_terminal", message: task.status };
    const summary = cleanText(args.summary, MCP_TEXT_MAX, "summary");
    const links = (args.links ?? []).map((l) => l.trim()).filter((l) => /^https?:\/\//i.test(l)).slice(0, 10);
    const reportedAt = Date.now();
    await appendTaskEvent(ctx, {
      taskId: task._id,
      projectId: task.projectId,
      type: "mcp.result_reported",
      payload: { status: args.status, summary: summary.slice(0, 500), links },
      level: args.status === "failed" ? "warn" : "info",
      eventKey: `mcp:${clientRequestId}`,
    });
    await ctx.db.insert("messages", {
      projectId: task.projectId,
      taskId: task._id,
      authorType: "agent",
      voice: "system",
      content: [`MCP run result (${args.status}): ${summary}`, ...links].join("\n"),
    });
    return await remember(ctx, "run.report_result", clientRequestId, {
      kind: "recorded" as const,
      taskId: task._id as string,
      projectId: task.projectId as string,
      status: args.status,
      summary: summary.slice(0, 500),
      reportedAt,
    });
  },
});

/**
 * `question.ask`: park a task the worker does not hold on a question to the
 * user (Needs you). A task a worker is running asks through its own agent
 * tool, so a live lease refuses; so do a settled task, a pending approval
 * and an open question.
 */
export const questionAsk = mutation({
  args: {
    workerToken: v.string(),
    clientRequestId: v.string(),
    taskId: v.string(),
    question: v.string(),
    options: v.optional(v.array(v.string())),
  },
  returns: v.union(v.object({ kind: v.literal("asked"), taskId: v.string(), question: v.string(), ...deduped }), refused),
  handler: async (ctx, args) => {
    assertServiceToken(args.workerToken);
    const clientRequestId = requestId(args.clientRequestId);
    const earlier = await replay(ctx, "question.ask", clientRequestId);
    if (earlier) return earlier as never;
    const task = await loadTask(ctx, args.taskId);
    if (!task) return { kind: "refused" as const, reason: "task_not_found" };
    if (TERMINAL.has(task.status)) return { kind: "refused" as const, reason: "task_already_terminal", message: task.status };
    if (task.status === "needs_approval") return { kind: "refused" as const, reason: "approval_pending" };
    if (task.status === "waiting_input" && task.pendingQuestion) return { kind: "refused" as const, reason: "question_open" };
    if (task.workerId && (task.leaseExpiresAt ?? 0) > Date.now()) return { kind: "refused" as const, reason: "task_owned_by_worker" };
    const question = cleanText(args.question, MCP_QUESTION_MAX, "question");
    const options = [...new Set((args.options ?? []).map((o) => o.trim()).filter(Boolean))].slice(0, 6);
    await patchTask(ctx, task._id, {
      status: "waiting_input",
      pendingQuestion: question,
      pendingOptions: options.length >= 2 ? options : undefined,
      updatedAt: Date.now(),
    });
    await touchBriefQuestion(ctx, task, { add: question });
    await appendTaskEvent(ctx, {
      taskId: task._id,
      projectId: task.projectId,
      type: "task.input_asked",
      payload: { question: question.slice(0, 500), source: "mcp" },
      level: "info",
    });
    return await remember(ctx, "question.ask", clientRequestId, {
      kind: "asked" as const,
      taskId: task._id as string,
      question,
    });
  },
});
