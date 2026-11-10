/**
 * Second Opinion + Shadow Agent (Reviewer as a read-only observer).
 *
 * - Second opinion: the user asks for one on a finished subtask (task
 *   thread, /runs) or on a chat agent reply. The Reviewer reads the
 *   subtask's contract, gates, output and diff (or the chat reply), may use
 *   the read-only repo tools, and returns a verdict (agree / concerns /
 *   disagree) with a short reason and file:line evidence.
 * - Shadow agent: per-task toggle (project default off). After each
 *   completed subtask the Reviewer writes up to a few notes (risk / missed
 *   requirement / suggestion), within its own note and token budget.
 *
 * Neither applies anything. The only writes are the reviewOpinions row, a
 * tokenUsage row and an audit row. "Replan with this note" is a separate,
 * explicit user action that reuses the existing replan / retry / steer
 * paths.
 */
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { assertProjectAccess, assertTaskAccess, getVisibleTask } from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";
import { loadProviderPool, type PoolConnectionPayload } from "./lib/llmResolver";
import {
  SHADOW_TOKEN_CAP_PER_TASK,
  SHADOW_MAX_NOTES_PER_TASK,
  buildMessageMaterial,
  buildSubtaskMaterial,
  replanNoteFromOpinion,
} from "./lib/reviewer/opinion";
import { findPendingPlanApproval, replanPendingPlan } from "./planReview";
import { requeueForRetry, steerWith } from "./tasks";
import { appendTaskEvent } from "./lib/taskEvents";

const FINISHED_SUBTASK = new Set(["completed", "failed", "blocked", "skipped"]);
const TERMINAL_TASK = new Set(["done", "rejected", "failed", "cancelled"]);
const REVIEWER_NAME = "Reviewer";

// ─── Public: request ───────────────────────────────────────────────────────

/** Second opinion on one finished subtask. Returns the opinion row id. */
export const requestSubtaskOpinion = mutation({
  args: { taskId: v.id("tasks"), subtaskKey: v.string() },
  handler: async (ctx, args) => {
    const task = await assertTaskAccess(ctx, args.taskId);
    const subtask = await ctx.db
      .query("subtasks")
      .withIndex("by_task_and_key", (q) => q.eq("taskId", task._id).eq("key", args.subtaskKey))
      .unique();
    if (!subtask) throw new Error("Subtask not found");
    if (!FINISHED_SUBTASK.has(subtask.status)) throw new Error("A second opinion needs a finished subtask");
    const rows = await ctx.db
      .query("reviewOpinions")
      .withIndex("by_task", (q) => q.eq("taskId", task._id))
      .collect();
    const running = rows.find((row) => row.mode === "second_opinion" && row.subtaskKey === args.subtaskKey && row.status === "running");
    if (running) return running._id;
    const opinionId = await ctx.db.insert("reviewOpinions", {
      projectId: task.projectId,
      taskId: task._id,
      subtaskKey: args.subtaskKey,
      mode: "second_opinion",
      target: "subtask",
      status: "running",
      createdAt: Date.now(),
    });
    await recordAudit(ctx, {
      tool: "reviewer",
      action: "review.second_opinion.request",
      target: subtask.title,
      projectId: task.projectId,
      taskId: task._id,
      details: { subtaskKey: args.subtaskKey },
    });
    await ctx.scheduler.runAfter(0, internal.reviewerNode.runReview, { opinionId });
    return opinionId;
  },
});

/** Second opinion on one chat agent reply. */
export const requestMessageOpinion = mutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) throw new Error("Message not found");
    // Second opinion is off for personal chat in v1 (plan 039 D8): a
    // personal reply has no project for the opinion row.
    if (!message.projectId) throw new Error("A second opinion is not available in a personal chat");
    const projectId = message.projectId;
    await assertProjectAccess(ctx, projectId);
    if (message.authorType !== "agent") throw new Error("A second opinion is for an agent reply");
    if (message.streaming) throw new Error("Wait for the reply to finish");
    if (!message.content.trim()) throw new Error("This reply has no text to review");
    const rows = await ctx.db
      .query("reviewOpinions")
      .withIndex("by_message", (q) => q.eq("messageId", message._id))
      .collect();
    const running = rows.find((row) => row.status === "running");
    if (running) return running._id;
    const opinionId = await ctx.db.insert("reviewOpinions", {
      projectId,
      ...(message.taskId ? { taskId: message.taskId } : {}),
      messageId: message._id,
      ...(message.conversationId ? { conversationId: message.conversationId } : {}),
      mode: "second_opinion",
      target: "chat",
      status: "running",
      createdAt: Date.now(),
    });
    await recordAudit(ctx, {
      tool: "reviewer",
      action: "review.second_opinion.request",
      target: message.content.slice(0, 120),
      projectId: message.projectId,
      ...(message.taskId ? { taskId: message.taskId } : {}),
      details: { messageId: message._id },
    });
    await ctx.scheduler.runAfter(0, internal.reviewerNode.runReview, { opinionId });
    return opinionId;
  },
});

// ─── Public: read ──────────────────────────────────────────────────────────

function project(row: Doc<"reviewOpinions">) {
  return {
    _id: row._id,
    taskId: row.taskId ?? null,
    subtaskKey: row.subtaskKey ?? null,
    messageId: row.messageId ?? null,
    mode: row.mode,
    target: row.target,
    status: row.status,
    verdict: row.verdict ?? null,
    reason: row.reason ?? null,
    evidence: row.evidence ?? [],
    notes: row.notes ?? [],
    error: row.error ?? null,
    tokens: (row.inputTokens ?? 0) + (row.outputTokens ?? 0),
    toolCalls: row.toolCalls ?? 0,
    replanRequestedAt: row.replanRequestedAt ?? null,
    replanOutcome: row.replanOutcome ?? null,
    createdAt: row.createdAt,
    completedAt: row.completedAt ?? null,
  };
}

/** Second opinions and shadow notes of one task, oldest first, plus the shadow state. */
export const listForTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return null;
    const rows = await ctx.db
      .query("reviewOpinions")
      .withIndex("by_task", (q) => q.eq("taskId", task._id))
      .collect();
    const shadowRows = rows.filter((row) => row.mode === "shadow");
    return {
      shadowAgent: Boolean(task.shadowAgent),
      shadowBudget: {
        maxNotes: SHADOW_MAX_NOTES_PER_TASK,
        tokenCap: SHADOW_TOKEN_CAP_PER_TASK,
        notes: shadowRows.reduce((sum, row) => sum + (row.notes?.length ?? 0), 0),
        tokens: shadowRows.reduce((sum, row) => sum + (row.inputTokens ?? 0) + (row.outputTokens ?? 0), 0),
      },
      opinions: rows
        .filter((row) => row.mode === "second_opinion" && row.target === "subtask")
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(project),
      shadow: shadowRows.sort((a, b) => a.createdAt - b.createdAt).map(project),
    };
  },
});

/** Chat second opinions of a project (latest per message), keyed by message id. */
export const listForChat = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    const rows = await ctx.db
      .query("reviewOpinions")
      .withIndex("by_project_and_target", (q) => q.eq("projectId", args.projectId).eq("target", "chat"))
      .order("desc")
      .take(200);
    const latest = new Map<string, ReturnType<typeof project>>();
    for (const row of rows) {
      if (!row.messageId || latest.has(row.messageId)) continue;
      latest.set(row.messageId, project(row));
    }
    return [...latest.values()];
  },
});

// ─── Public: act on an opinion ─────────────────────────────────────────────

/**
 * "Replan with this note": the user sends a concerns / disagree opinion to
 * the planner through the existing paths. Pending plan review → replan
 * with the note (planReview.replanPendingPlan). Finished task → manual
 * retry with the note as planner feedback (tasks.requeueForRetry; completed
 * subtasks are kept). Running / queued / paused task → a steer through the
 * single input guard (tasks.steerWith). Never automatic.
 */
export const replanWithOpinion = mutation({
  args: { opinionId: v.id("reviewOpinions") },
  handler: async (ctx, args) => {
    const opinion = await ctx.db.get(args.opinionId);
    if (!opinion || !opinion.taskId) throw new Error("Opinion not found");
    const task = await assertTaskAccess(ctx, opinion.taskId);
    if (opinion.mode !== "second_opinion" || opinion.status !== "done") throw new Error("This opinion is not finished");
    if (opinion.verdict !== "concerns" && opinion.verdict !== "disagree") {
      throw new Error("The Reviewer agreed; there is nothing to replan");
    }
    if (opinion.replanRequestedAt) return { ok: true as const, outcome: opinion.replanOutcome ?? "sent" };
    const subtask = opinion.subtaskKey
      ? await ctx.db
          .query("subtasks")
          .withIndex("by_task_and_key", (q) => q.eq("taskId", task._id).eq("key", opinion.subtaskKey!))
          .unique()
      : null;
    const note = replanNoteFromOpinion({
      verdict: opinion.verdict,
      reason: opinion.reason ?? "",
      evidence: opinion.evidence,
      subtaskTitle: subtask?.title,
    });
    let outcome: "replanned" | "requeued" | "steered";
    const pending = await findPendingPlanApproval(ctx, task._id);
    if (pending && !TERMINAL_TASK.has(task.status)) {
      const result = await replanPendingPlan(ctx, pending, task, note);
      if (!result.ok) throw new Error(result.errors.join("; "));
      outcome = "replanned";
    } else if (TERMINAL_TASK.has(task.status)) {
      await requeueForRetry(ctx, task, { planReviewNote: note });
      await appendTaskEvent(ctx, {
        taskId: task._id,
        projectId: task.projectId,
        type: "plan.replan_requested",
        payload: { source: "second_opinion", opinionId: opinion._id, note: note.slice(0, 500) },
        level: "info",
      });
      outcome = "requeued";
    } else {
      const result = await steerWith(ctx, task, note);
      if (!result.applied) {
        throw new Error(
          result.reason === "awaiting_approval"
            ? "The task is waiting on an approval; decide it first"
            : result.reason === "awaiting_plan_approval"
              ? "The plan is waiting for review; use Replan on the plan"
              : "The task cannot take a note right now"
        );
      }
      outcome = "steered";
    }
    const now = Date.now();
    await ctx.db.patch(opinion._id, { replanRequestedAt: now, replanOutcome: outcome });
    await recordAudit(ctx, {
      tool: "reviewer",
      action: "review.replan_with_note",
      target: subtask?.title ?? task.title,
      projectId: task.projectId,
      taskId: task._id,
      details: { opinionId: opinion._id, verdict: opinion.verdict, outcome },
    });
    return { ok: true as const, outcome };
  },
});

/** Shadow Agent toggle for one task. */
export const setTaskShadow = mutation({
  args: { taskId: v.id("tasks"), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const task = await assertTaskAccess(ctx, args.taskId);
    if (Boolean(task.shadowAgent) === args.enabled) return args.enabled;
    await ctx.db.patch(task._id, { shadowAgent: args.enabled ? true : undefined });
    await recordAudit(ctx, {
      action: "task.update",
      target: task.title,
      projectId: task.projectId,
      taskId: task._id,
      details: { changed: ["shadowAgent"], shadowAgent: args.enabled },
    });
    return args.enabled;
  },
});

/** Project default for the Shadow Agent on new tasks (off unless set). */
export const setProjectShadowDefault = mutation({
  args: { projectId: v.id("projects"), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const proj = await assertProjectAccess(ctx, args.projectId);
    if (Boolean(proj.shadowAgentDefault) === args.enabled) return args.enabled;
    await ctx.db.patch(args.projectId, { shadowAgentDefault: args.enabled ? true : undefined });
    await recordAudit(ctx, {
      action: "project.update",
      target: proj.name,
      projectId: args.projectId,
      details: { changed: ["shadowAgentDefault"], shadowAgentDefault: args.enabled },
    });
    return args.enabled;
  },
});

export const getProjectShadowDefault = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const proj = await assertProjectAccess(ctx, args.projectId);
    return Boolean(proj.shadowAgentDefault);
  },
});

// ─── Internal: the review run ──────────────────────────────────────────────

type AgentPrefs = {
  llmProviderId?: string;
  llmModelId?: string;
  llmFallbackProviderId?: string;
  llmFallbackModelId?: string;
  llmSelectionPolicy?: string;
};

/** The enabled Reviewer agent and the LLM preference it runs with (agent > reviewer tier > pool). */
export async function reviewerIdentity(
  ctx: QueryCtx,
  projectId: Id<"projects">
): Promise<{ agentId: Id<"agents"> | null; persona: string | undefined; prefs: AgentPrefs | undefined }> {
  const agents = await ctx.db.query("agents").collect();
  const reviewer = agents.find((a) => a.isEnabled !== false && a.role.trim().toLowerCase() === "reviewer") ?? null;
  let prefs: AgentPrefs | undefined;
  if (reviewer?.llmProviderId) {
    prefs = {
      llmProviderId: reviewer.llmProviderId,
      llmModelId: reviewer.llmModelId,
      llmFallbackProviderId: reviewer.llmFallbackProviderId,
      llmFallbackModelId: reviewer.llmFallbackModelId,
      llmSelectionPolicy: reviewer.llmSelectionPolicy,
    };
  } else {
    const proj = await ctx.db.get(projectId);
    const tierModelId = proj?.modelTiers?.reviewer;
    const tierModel = tierModelId ? await ctx.db.get(tierModelId) : null;
    if (tierModel) prefs = { llmProviderId: tierModel.providerId, llmModelId: tierModel._id };
  }
  return { agentId: reviewer?._id ?? null, persona: reviewer?.systemPrompt, prefs };
}

export const getReviewContext = internalQuery({
  args: { opinionId: v.id("reviewOpinions") },
  handler: async (ctx, args) => {
    const opinion = await ctx.db.get(args.opinionId);
    if (!opinion || opinion.status !== "running") return null;
    const identity = await reviewerIdentity(ctx, opinion.projectId);
    const providers: PoolConnectionPayload[] = await loadProviderPool(ctx);
    let material = "";
    let shadowTokensUsed = 0;
    let shadowNotesUsed = 0;
    if (opinion.target === "subtask") {
      if (!opinion.taskId || !opinion.subtaskKey) return null;
      const task = await ctx.db.get(opinion.taskId);
      const subtask = await ctx.db
        .query("subtasks")
        .withIndex("by_task_and_key", (q) => q.eq("taskId", opinion.taskId!).eq("key", opinion.subtaskKey!))
        .unique();
      if (!task || !subtask) return null;
      const changes = await ctx.db
        .query("fileChanges")
        .withIndex("by_task", (q) => q.eq("taskId", task._id))
        .collect();
      const agent = subtask.assignedAgentId ? await ctx.db.get(subtask.assignedAgentId) : null;
      material = buildSubtaskMaterial({
        taskTitle: task.title,
        taskCommand: task.command,
        subtask: {
          key: subtask.key,
          title: subtask.title,
          description: subtask.description,
          kind: subtask.kind,
          role: agent?.role,
          status: subtask.status,
          output: subtask.output,
          error: subtask.error,
          objective: subtask.objective,
          constraints: subtask.constraints,
          deliverable: subtask.deliverable,
          allowedPaths: subtask.allowedPaths,
          acceptance: subtask.acceptance,
          gateResults: subtask.gateResults?.map((g) => ({ gateId: g.gateId, status: g.status, summary: g.evidence.summary })),
          acceptanceStatus: subtask.acceptanceStatus,
        },
        diffs: changes
          .filter((change) => change.subtaskKey === subtask.key)
          .map((change) => ({ filePath: change.filePath, changeType: change.changeType, diff: change.diff })),
      });
      if (opinion.mode === "shadow") {
        const rows = await ctx.db
          .query("reviewOpinions")
          .withIndex("by_task", (q) => q.eq("taskId", task._id))
          .collect();
        for (const row of rows) {
          if (row.mode !== "shadow" || row._id === opinion._id) continue;
          shadowTokensUsed += (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
          shadowNotesUsed += row.notes?.length ?? 0;
        }
      }
    } else {
      if (!opinion.messageId) return null;
      const message = await ctx.db.get(opinion.messageId);
      // Personal chat replies have no project and get no opinion (D8).
      if (!message || !message.projectId) return null;
      const messageProjectId = message.projectId;
      let question = "";
      const asked = message.replyToMessageId ? await ctx.db.get(message.replyToMessageId) : null;
      if (asked) question = asked.content;
      else {
        const before = await ctx.db
          .query("messages")
          .withIndex("by_project", (q) => q.eq("projectId", messageProjectId))
          .order("desc")
          .take(60);
        question =
          before.find(
            (m) =>
              m.authorType === "user" &&
              m._creationTime < message._creationTime &&
              (m.conversationId ?? null) === (message.conversationId ?? null)
          )?.content ?? "";
      }
      const agent = message.agentId ? await ctx.db.get(message.agentId) : null;
      const proj = await ctx.db.get(messageProjectId);
      material = buildMessageMaterial({
        projectName: proj?.name ?? "Project",
        question,
        reply: message.content,
        replyRole: agent?.role,
        checkedFiles: message.checkedFiles,
      });
    }
    return {
      projectId: opinion.projectId,
      taskId: opinion.taskId ?? null,
      subtaskKey: opinion.subtaskKey ?? null,
      mode: opinion.mode,
      target: opinion.target,
      material,
      persona: identity.persona,
      agentId: identity.agentId,
      prefs: identity.prefs,
      providers,
      shadowTokensUsed,
      shadowNotesUsed,
    };
  },
});

const evidenceArg = v.object({ file: v.string(), line: v.optional(v.number()), note: v.optional(v.string()) });

/** Store a finished review: the opinion row, one tokenUsage row, one audit row. Nothing else. */
export const finishReview = internalMutation({
  args: {
    opinionId: v.id("reviewOpinions"),
    verdict: v.optional(v.union(v.literal("agree"), v.literal("concerns"), v.literal("disagree"))),
    reason: v.optional(v.string()),
    evidence: v.optional(v.array(evidenceArg)),
    notes: v.optional(
      v.array(
        v.object({
          kind: v.union(v.literal("risk"), v.literal("missed_requirement"), v.literal("suggestion")),
          text: v.string(),
          evidence: v.array(evidenceArg),
        })
      )
    ),
    error: v.optional(v.string()),
    model: v.optional(v.string()),
    agentId: v.optional(v.id("agents")),
    inputTokens: v.number(),
    outputTokens: v.number(),
    toolCalls: v.number(),
  },
  handler: async (ctx, args) => {
    const opinion = await ctx.db.get(args.opinionId);
    if (!opinion || opinion.status !== "running") return false;
    const now = Date.now();
    let notes = args.notes;
    if (opinion.mode === "shadow" && notes && opinion.taskId) {
      // Budget: never store more notes than the task's shadow limit.
      const rows = await ctx.db
        .query("reviewOpinions")
        .withIndex("by_task", (q) => q.eq("taskId", opinion.taskId!))
        .collect();
      const used = rows.filter((row) => row.mode === "shadow" && row._id !== opinion._id).reduce((sum, row) => sum + (row.notes?.length ?? 0), 0);
      notes = notes.slice(0, Math.max(0, SHADOW_MAX_NOTES_PER_TASK - used));
    }
    await ctx.db.patch(opinion._id, {
      status: args.error ? "error" : "done",
      ...(args.verdict ? { verdict: args.verdict } : {}),
      ...(args.reason ? { reason: args.reason.slice(0, 800) } : {}),
      ...(args.evidence ? { evidence: args.evidence.slice(0, 6) } : {}),
      ...(notes ? { notes } : {}),
      ...(args.error ? { error: args.error.slice(0, 500) } : {}),
      ...(args.model ? { model: args.model } : {}),
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      toolCalls: args.toolCalls,
      completedAt: now,
    });
    if (args.inputTokens + args.outputTokens > 0) {
      await ctx.db.insert("tokenUsage", {
        projectId: opinion.projectId,
        ...(opinion.taskId ? { taskId: opinion.taskId } : {}),
        ...(args.agentId ? { agentId: args.agentId } : {}),
        agentName: REVIEWER_NAME,
        model: args.model ?? "unknown",
        inputTokens: args.inputTokens,
        outputTokens: args.outputTokens,
        ...(opinion.subtaskKey ? { subtaskKey: opinion.subtaskKey } : {}),
        // completeWithAgent reports no usage: chars/4 like the worker's fallback.
        estimated: true,
        createdAt: now,
      });
    }
    await ctx.db.insert("audit", {
      actor: "reviewer",
      tool: "reviewer",
      action: opinion.mode === "shadow" ? "review.shadow" : "review.second_opinion",
      decision: "recorded",
      target: (opinion.subtaskKey ?? opinion.messageId ?? "").toString().slice(0, 200) || undefined,
      ...(opinion.projectId ? { projectId: opinion.projectId } : {}),
      ...(opinion.taskId ? { taskId: opinion.taskId } : {}),
      details: {
        opinionId: opinion._id,
        ...(args.verdict ? { verdict: args.verdict } : {}),
        ...(notes ? { notes: notes.length } : {}),
        ...(args.error ? { error: true } : {}),
        tokens: args.inputTokens + args.outputTokens,
        toolCalls: args.toolCalls,
      },
      createdAt: now,
    });
    return true;
  },
});

// The review run itself (`runReview`) lives in reviewerNode.ts: it calls the
// user's LLM endpoint, which needs the Node runtime ("use node"), and a
// "use node" module may only export actions.
