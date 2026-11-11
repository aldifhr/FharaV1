/**
 * Options review (show_options) backend. See lib/optionsReview.ts for the
 * primitive and its threadbear origin.
 *
 * Flow: the worker validates + sanitizes each option, renders html options
 * to PNGs, uploads images (worker.optionReviewUploadUrl) and calls
 * worker.createOptionReview. `create` stores the row, posts one "options"
 * card in the task thread and, when the project skips reviews for the
 * agent's role, answers it at once with the recommended option. The
 * subtask waits in-process (it keeps its lease) and polls `getForWorker`
 * until the user submits. The user's draft is saved separately (`saveDraft`)
 * from the answer (`submit`); only submit reaches the agent. The answer
 * also lands in the task brief as a decision so later nodes build to it.
 */
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { assertProjectAccess, getVisibleTask } from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";
import { appendTaskEvent } from "./lib/taskEvents";
import { taskCardConversationId } from "./lib/conversationScope";
import { holdsTaskLease } from "./orchestration";
import { reviewDraftValidator } from "./schema";
import { writeBrief } from "./briefs";
import { addDecision } from "./lib/brief";
import { roleLabel } from "./lib/roles";
import {
  autoPickDraft,
  htmlLooksActive,
  normalizeDraft,
  OPTIONS_REVIEW_PURPOSES,
  reviewReplyText,
  sameDraft,
  skipsOptionsReview,
  validateReviewShape,
  type ReviewDraft,
} from "./lib/optionsReview";

const TERMINAL = new Set(["done", "failed", "rejected", "cancelled"]);

export const purposeValidator = v.union(...OPTIONS_REVIEW_PURPOSES.map((p) => v.literal(p)));

export const optionInputValidator = v.object({
  id: v.string(),
  title: v.string(),
  note: v.optional(v.string()),
  reference: v.optional(v.boolean()),
  kind: v.union(v.literal("html"), v.literal("image"), v.literal("markdown")),
  html: v.optional(v.string()),
  markdown: v.optional(v.string()),
  imageStorageId: v.optional(v.id("_storage")),
  findings: v.optional(v.array(v.string())),
});

export const createArgs = {
  taskId: v.id("tasks"),
  projectId: v.id("projects"),
  subtaskKey: v.optional(v.string()),
  executionId: v.optional(v.id("executions")),
  agentId: v.optional(v.id("agents")),
  role: v.string(),
  purpose: purposeValidator,
  title: v.string(),
  note: v.optional(v.string()),
  route: v.optional(v.string()),
  recommended: v.optional(v.string()),
  options: v.array(optionInputValidator),
  workerId: v.optional(v.string()),
};

/** One decision line for the task brief. */
function decisionLine(review: Pick<Doc<"optionReviews">, "role" | "purpose" | "title" | "options">, draft: ReviewDraft, auto: boolean): string {
  const who = roleLabel(review.role);
  const titleOf = (id: string) => review.options.find((o) => o.id === id)?.title ?? id;
  const picked = draft.none ? "none of the options" : draft.pickedIds.map((id) => `${id} (${titleOf(id)})`).join(" + ");
  const notes = draft.notes.map((n) => `${n.optionId}: ${n.note}`).join("; ");
  return [
    `${who} ${review.purpose} review "${review.title}": ${auto ? "auto-picked" : "user picked"} ${picked || "nothing"}.`,
    draft.reply ? `Reply: ${draft.reply}` : "",
    notes ? `Notes: ${notes}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

async function recordAnswer(ctx: MutationCtx, review: Doc<"optionReviews">, draft: ReviewDraft, by: "user" | "auto") {
  const now = Date.now();
  const auto = by === "auto";
  const replyText = reviewReplyText(review, draft, { auto });
  await ctx.db.patch(review._id, {
    status: auto ? "auto" : "answered",
    response: draft,
    draft,
    replyText,
    decidedBy: by,
    answeredAt: now,
    updatedAt: now,
    revision: review.revision + 1,
  });
  const task = await ctx.db.get(review.taskId);
  if (task) {
    const row = await ctx.db
      .query("taskBriefs")
      .withIndex("by_task", (q) => q.eq("taskId", review.taskId))
      .first();
    await writeBrief(ctx, task, { decisions: addDecision(row?.decisions, decisionLine(review, draft, auto)) }, "worker");
  }
  await appendTaskEvent(ctx, {
    taskId: review.taskId,
    projectId: review.projectId,
    type: "options_review.answered",
    payload: {
      reviewId: review._id,
      purpose: review.purpose,
      role: review.role,
      pickedIds: draft.pickedIds,
      none: draft.none ?? false,
      decidedBy: by,
    },
    ...(review.subtaskKey ? { subtaskKey: review.subtaskKey } : {}),
    level: "info",
  });
  await recordAudit(ctx, {
    actor: by === "auto" ? "options-review-skip" : undefined,
    action: "options_review.answer",
    target: review.title,
    projectId: review.projectId,
    taskId: review.taskId,
    details: { reviewId: review._id, pickedIds: draft.pickedIds, none: draft.none ?? false, decidedBy: by },
  });
  return replyText;
}

// ─── Worker side (token-gated through worker.ts) ──────────────────────────

export const create = internalMutation({
  args: createArgs,
  handler: async (ctx, args): Promise<{ reviewId: Id<"optionReviews">; status: "pending" | "auto"; replyText: string | null }> => {
    const task = await ctx.db.get(args.taskId);
    if (!task || task.projectId !== args.projectId) throw new Error("Task not found");
    if (TERMINAL.has(task.status)) throw new Error(`Task is already ${task.status}`);
    if (!(await holdsTaskLease(ctx, args.taskId, args.workerId))) throw new Error("Lease lost: this task is no longer owned by this worker");
    const shape = validateReviewShape(args);
    for (const option of args.options) {
      if (option.kind !== "html") continue;
      const active = htmlLooksActive(option.html ?? "");
      if (active) throw new Error(`Option ${option.id} still contains ${active}; sanitize it before storing`);
    }
    const now = Date.now();
    const reviewId = await ctx.db.insert("optionReviews", {
      taskId: args.taskId,
      projectId: args.projectId,
      ...(args.subtaskKey ? { subtaskKey: args.subtaskKey } : {}),
      ...(args.executionId ? { executionId: args.executionId } : {}),
      ...(args.agentId ? { agentId: args.agentId } : {}),
      role: args.role.trim().toLowerCase(),
      purpose: shape.purpose,
      title: shape.title,
      ...(shape.note ? { note: shape.note } : {}),
      ...(shape.route ? { route: shape.route } : {}),
      ...(shape.recommended ? { recommended: shape.recommended } : {}),
      options: args.options.map((o) => ({
        id: o.id.trim(),
        title: o.title.trim(),
        ...(o.note?.trim() ? { note: o.note.trim() } : {}),
        ...(o.reference ? { reference: true } : {}),
        kind: o.kind,
        ...(o.kind === "html" ? { html: o.html } : {}),
        ...(o.kind === "markdown" ? { markdown: o.markdown?.trim() } : {}),
        ...(o.imageStorageId ? { imageStorageId: o.imageStorageId } : {}),
        ...(o.findings?.length ? { findings: o.findings.slice(0, 20) } : {}),
      })),
      status: "pending",
      revision: 0,
      createdAt: now,
      updatedAt: now,
    });
    await appendTaskEvent(ctx, {
      taskId: args.taskId,
      projectId: args.projectId,
      type: "options_review.requested",
      payload: { reviewId, purpose: shape.purpose, role: args.role, title: shape.title, options: args.options.length },
      ...(args.subtaskKey ? { subtaskKey: args.subtaskKey } : {}),
      level: "warn",
    });
    await ctx.db.insert("messages", {
      projectId: args.projectId,
      taskId: args.taskId,
      conversationId: await taskCardConversationId(ctx, task.conversationId),
      authorType: "agent",
      ...(args.agentId ? { agentId: args.agentId } : {}),
      content: "",
      card: { kind: "options", data: { taskId: String(args.taskId), reviewId: String(reviewId) } },
    });
    const project = await ctx.db.get(args.projectId);
    if (skipsOptionsReview(project, args.role)) {
      const row = (await ctx.db.get(reviewId))!;
      const replyText = await recordAnswer(ctx, row, autoPickDraft(row), "auto");
      return { reviewId, status: "auto", replyText };
    }
    return { reviewId, status: "pending", replyText: null };
  },
});

export const getForWorker = internalQuery({
  args: { reviewId: v.id("optionReviews") },
  handler: async (ctx, args) => {
    const review = await ctx.db.get(args.reviewId);
    if (!review) return null;
    const task = await ctx.db.get(review.taskId);
    return {
      status: review.status,
      replyText: review.replyText ?? null,
      response: review.response ?? null,
      cancelReason: review.cancelReason ?? null,
      taskStatus: task?.status ?? null,
    };
  },
});

export const cancel = internalMutation({
  args: { reviewId: v.id("optionReviews"), reason: v.string() },
  handler: async (ctx, args): Promise<{ applied: boolean }> => {
    const review = await ctx.db.get(args.reviewId);
    if (!review || review.status !== "pending") return { applied: false };
    await ctx.db.patch(args.reviewId, {
      status: "cancelled",
      cancelReason: args.reason.slice(0, 300),
      updatedAt: Date.now(),
      revision: review.revision + 1,
    });
    await appendTaskEvent(ctx, {
      taskId: review.taskId,
      projectId: review.projectId,
      type: "options_review.cancelled",
      payload: { reviewId: review._id, reason: args.reason.slice(0, 300) },
      ...(review.subtaskKey ? { subtaskKey: review.subtaskKey } : {}),
      level: "info",
    });
    return { applied: true };
  },
});

export const generateUploadUrl = internalMutation({
  args: {},
  handler: async (ctx): Promise<string> => await ctx.storage.generateUploadUrl(),
});

/** The answered design review QA compares the build with (newest first). */
export const pickedForBuildCheck = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("optionReviews")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .order("desc")
      .take(10);
    const review = rows.find((r) => (r.status === "answered" || r.status === "auto") && r.purpose === "design" && r.route && r.response?.pickedIds.length);
    if (!review) return null;
    const picked = review.options.filter((o) => review.response!.pickedIds.includes(o.id));
    return {
      reviewId: review._id,
      route: review.route!,
      title: review.title,
      picked: picked.map((o) => ({ id: o.id, title: o.title, note: o.note ?? null, html: o.html ?? null, markdown: o.markdown ?? null })),
      notes: review.response!.notes,
      reply: review.response!.reply ?? null,
    };
  },
});

export const attachBuildCheck = internalMutation({
  args: {
    reviewId: v.id("optionReviews"),
    route: v.string(),
    imageStorageId: v.optional(v.id("_storage")),
    verdict: v.union(v.literal("matches"), v.literal("differs"), v.literal("unknown")),
    note: v.string(),
  },
  handler: async (ctx, args): Promise<{ applied: boolean }> => {
    const review = await ctx.db.get(args.reviewId);
    if (!review) return { applied: false };
    await ctx.db.patch(args.reviewId, {
      buildCheck: {
        route: args.route.slice(0, 300),
        ...(args.imageStorageId ? { imageStorageId: args.imageStorageId } : {}),
        verdict: args.verdict,
        note: args.note.slice(0, 2000),
        checkedAt: Date.now(),
      },
      updatedAt: Date.now(),
    });
    await appendTaskEvent(ctx, {
      taskId: review.taskId,
      projectId: review.projectId,
      type: "options_review.build_check",
      payload: { reviewId: review._id, verdict: args.verdict, route: args.route },
      level: args.verdict === "differs" ? "warn" : "info",
    });
    return { applied: true };
  },
});

// ─── User side ─────────────────────────────────────────────────────────────

async function viewOf(ctx: QueryCtx, review: Doc<"optionReviews">) {
  const url = async (id: Id<"_storage"> | undefined) => (id ? await ctx.storage.getUrl(id) : null);
  const task = await ctx.db.get(review.taskId);
  return {
    _id: review._id,
    taskId: review.taskId,
    projectId: review.projectId,
    taskTitle: task?.title ?? null,
    taskStatus: task?.status ?? null,
    role: review.role,
    purpose: review.purpose,
    title: review.title,
    note: review.note ?? null,
    route: review.route ?? null,
    recommended: review.recommended ?? null,
    status: review.status,
    decidedBy: review.decidedBy ?? null,
    revision: review.revision,
    draft: review.draft ?? null,
    response: review.response ?? null,
    cancelReason: review.cancelReason ?? null,
    createdAt: review.createdAt,
    answeredAt: review.answeredAt ?? null,
    options: await Promise.all(
      review.options.map(async (o) => ({
        id: o.id,
        title: o.title,
        note: o.note ?? null,
        reference: o.reference ?? false,
        kind: o.kind,
        html: o.html ?? null,
        markdown: o.markdown ?? null,
        imageUrl: await url(o.imageStorageId),
        findings: o.findings ?? [],
      }))
    ),
    buildCheck: review.buildCheck
      ? { ...review.buildCheck, imageUrl: await url(review.buildCheck.imageStorageId) }
      : null,
  };
}

export type OptionReviewView = Awaited<ReturnType<typeof viewOf>>;

export const get = query({
  args: { reviewId: v.id("optionReviews") },
  handler: async (ctx, args) => {
    const review = await ctx.db.get(args.reviewId);
    if (!review) return null;
    const task = await getVisibleTask(ctx, review.taskId);
    if (!task) return null;
    return await viewOf(ctx, review);
  },
});

export const forTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return [];
    const rows = await ctx.db
      .query("optionReviews")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .order("desc")
      .take(20);
    return await Promise.all(rows.map((r) => viewOf(ctx, r)));
  },
});

async function loadForUser(ctx: MutationCtx, reviewId: Id<"optionReviews">) {
  const review = await ctx.db.get(reviewId);
  if (!review) throw new Error("Review not found");
  await assertProjectAccess(ctx, review.projectId);
  return review;
}

/** Save the draft only. Never answers the agent; closing the card is safe. */
export const saveDraft = mutation({
  args: { reviewId: v.id("optionReviews"), revision: v.number(), draft: reviewDraftValidator },
  handler: async (ctx, args): Promise<{ revision: number }> => {
    const review = await loadForUser(ctx, args.reviewId);
    if (review.status !== "pending") throw new Error("This review was already answered");
    if (args.revision !== review.revision) throw new Error("The review changed; reload it before saving");
    const draft = normalizeDraft(review, args.draft);
    if (sameDraft(review.draft, draft)) return { revision: review.revision };
    await ctx.db.patch(review._id, { draft, revision: review.revision + 1, updatedAt: Date.now() });
    return { revision: review.revision + 1 };
  },
});

/** Send the answer to the agent (picks, notes, reply). Idempotent for a repeated identical submit. */
export const submit = mutation({
  args: { reviewId: v.id("optionReviews"), revision: v.number(), draft: reviewDraftValidator },
  handler: async (ctx, args): Promise<{ status: "answered"; repeated: boolean }> => {
    const review = await loadForUser(ctx, args.reviewId);
    const draft = normalizeDraft(review, args.draft, true);
    // A retried request after a dropped response must not answer twice.
    if (review.status === "answered" && sameDraft(review.response, draft)) return { status: "answered", repeated: true };
    if (review.status !== "pending") throw new Error(review.status === "cancelled" ? "This review was cancelled" : "This review was already answered");
    if (args.revision !== review.revision) throw new Error("The review changed; reload it before sending");
    const task = await ctx.db.get(review.taskId);
    if (task && TERMINAL.has(task.status)) throw new Error(`Task is already ${task.status}`);
    await recordAnswer(ctx, review, draft, "user");
    return { status: "answered", repeated: false };
  },
});

/** Per-project roles whose reviews are auto-picked (off by default). */
export const setSkipRoles = mutation({
  args: { projectId: v.id("projects"), roles: v.array(v.string()) },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    const roles = Array.from(new Set(args.roles.map((r) => r.trim().toLowerCase()).filter(Boolean))).slice(0, 20);
    await ctx.db.patch(args.projectId, { optionsReviewSkipRoles: roles.length ? roles : undefined });
    await recordAudit(ctx, {
      action: "project.options_review_skip",
      projectId: args.projectId,
      details: { roles },
    });
    return { roles };
  },
});
