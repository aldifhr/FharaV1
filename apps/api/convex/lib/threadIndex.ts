/**
 * The one writer of `threadIndex` (Paradev B1 / threadbear T7): the
 * per-project thread list the sidebar reads, sorted by last activity.
 *
 * `syncTaskThread` / `syncConversationThread` derive a row from its source
 * document and write it only when a shown field changed (title, status,
 * needsYou, branch, worktree, owner, archived). A preview-only or lease-only
 * change writes nothing. Callers: task status / title / branch writes
 * (`patchTask`), task inserts, conversation create / attach / rename and
 * throttled `lastMessageAt` bumps.
 */
import { isLegacyDirect } from "./legacyDirect";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

type ThreadRow = Doc<"threadIndex">;
type Shown = Pick<
  ThreadRow,
  "projectId" | "kind" | "title" | "status" | "needsYou" | "branchName" | "worktreeKey" | "ownerTaskId" | "archivedAt"
>;

/** A conversation's lastMessageAt moves the row at most this often. */
export const CONVERSATION_ACTIVITY_THROTTLE_MS = 60_000;
const TITLE_MAX = 200;

/** Fields a task patch may carry that the thread row shows. */
const TASK_SHOWN_FIELDS = ["status", "title", "branchName", "worktreePath", "pausedBy", "mode", "parentTaskId", "projectId"];

export function normaliseTitle(raw: string): string | null {
  const title = raw.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
  return title.length ? title : null;
}

/** Worktree path with trailing slashes dropped; falls back to the branch. */
export function worktreeKeyOf(worktreePath?: string, branchName?: string): string | undefined {
  const path = worktreePath?.replace(/\/+$/u, "");
  return path || branchName || undefined;
}

/** The row's status word and whether it waits on the user. */
export function taskThreadStatus(task: Pick<Doc<"tasks">, "status" | "mode" | "pausedBy">): { status: string; needsYou: boolean } {
  switch (task.status) {
    case "needs_approval":
      return { status: "needs you", needsYou: true };
    case "waiting_input":
      // A legacy direct thread (removed 2026-11-12) parked here: read-only, not a question.
      return isLegacyDirect(task) ? { status: "idle", needsYou: false } : { status: "needs you", needsYou: true };
    case "paused":
      return { status: task.pausedBy === "held" ? "held" : "paused", needsYou: false };
    default:
      return { status: task.status, needsYou: false };
  }
}

export function taskShown(task: Doc<"tasks">): Shown {
  const { status, needsYou } = taskThreadStatus(task);
  return {
    projectId: task.projectId,
    kind: "task",
    title: task.title,
    status,
    needsYou,
    branchName: task.branchName,
    worktreeKey: worktreeKeyOf(task.worktreePath, task.branchName),
    ownerTaskId: task.reviewFix?.ownerTaskId ?? task.parentTaskId,
    archivedAt: undefined,
  };
}

/** Project conversations not bound to a task; a task's chat is its task row. */
export function conversationShown(conversation: Doc<"conversations">): Shown | null {
  if (!conversation.projectId || conversation.taskId) return null;
  const closed = conversation.status === "closed";
  return {
    projectId: conversation.projectId,
    kind: "conversation",
    title: conversation.title?.trim() || "Chat",
    status: closed ? "closed" : "idle",
    needsYou: false,
    branchName: undefined,
    worktreeKey: undefined,
    ownerTaskId: undefined,
    archivedAt: closed ? (conversation.updatedAt ?? conversation.createdAt) : undefined,
  };
}

function sameShown(row: ThreadRow, next: Shown): boolean {
  return (Object.keys(next) as Array<keyof Shown>).every((key) => row[key] === next[key]);
}

type SyncResult = "inserted" | "patched" | "deleted" | "unchanged";

/** Insert, patch or delete one row; returns what it did. */
async function upsert(
  ctx: MutationCtx,
  existing: ThreadRow | null,
  next: Shown | null,
  refs: { taskId?: Id<"tasks">; conversationId?: Id<"conversations"> },
  activityAt: number,
  opts: { seen?: boolean; touch?: boolean } = {},
): Promise<SyncResult> {
  const now = Date.now();
  if (!next) {
    if (!existing) return "unchanged";
    await ctx.db.delete(existing._id);
    return "deleted";
  }
  if (!existing) {
    await ctx.db.insert("threadIndex", {
      ...next,
      ...refs,
      lastActivityAt: activityAt,
      ...(opts.seen ? { seenAt: activityAt } : {}),
      updatedMs: now,
    });
    return "inserted";
  }
  const touched = opts.touch === true && activityAt > existing.lastActivityAt;
  if (sameShown(existing, next) && !touched) return "unchanged";
  await ctx.db.patch(existing._id, {
    ...next,
    lastActivityAt: Math.max(existing.lastActivityAt, activityAt),
    updatedMs: now,
  });
  return "patched";
}

export async function syncTaskThread(ctx: MutationCtx, taskId: Id<"tasks">, opts: { seen?: boolean } = {}): Promise<SyncResult> {
  const task = await ctx.db.get(taskId);
  const existing = await ctx.db
    .query("threadIndex")
    .withIndex("by_task", (q) => q.eq("taskId", taskId))
    .unique();
  // A new row starts at the task's own last activity; a change moves it to now.
  const activityAt = existing ? Date.now() : (task?.updatedAt ?? task?._creationTime ?? Date.now());
  return upsert(ctx, existing, task ? taskShown(task) : null, { taskId }, activityAt, opts);
}

export async function syncConversationThread(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
  opts: { seen?: boolean } = {},
): Promise<SyncResult> {
  const conversation = await ctx.db.get(conversationId);
  const existing = await ctx.db
    .query("threadIndex")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
    .unique();
  const activityAt = conversation?.lastMessageAt ?? conversation?.updatedAt ?? conversation?.createdAt ?? Date.now();
  // Throttle: a message bump moves the row only once per window.
  const touch = !!existing && activityAt - existing.lastActivityAt >= CONVERSATION_ACTIVITY_THROTTLE_MS;
  return upsert(ctx, existing, conversation ? conversationShown(conversation) : null, { conversationId }, activityAt, {
    ...opts,
    touch,
  });
}

/**
 * `ctx.db.patch` on a task, then a thread-row sync when the patch touched a
 * shown field. Drop-in for task status / title / branch writes. A title from
 * the system never replaces a user rename (`titleSetBy: "user"`).
 */
export async function patchTask(ctx: MutationCtx, taskId: Id<"tasks">, fields: Partial<Doc<"tasks">>): Promise<void> {
  if ("title" in fields && (await ctx.db.get(taskId))?.titleSetBy === "user") {
    const { title: _userRenameStands, ...rest } = fields;
    fields = rest;
  }
  await ctx.db.patch(taskId, fields);
  if (Object.keys(fields).some((key) => TASK_SHOWN_FIELDS.includes(key))) await syncTaskThread(ctx, taskId);
}
