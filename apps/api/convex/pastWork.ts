/**
 * D11 past-work search: full-text search over one project's task titles,
 * task results (taskBriefs.latestResult) and messages, for the
 * `search_past_work` tool (lib/pastWork.ts holds the contract and the
 * formatter).
 *
 * Every index is filtered on `projectId` and every row is re-checked against
 * it, so another project's task or message is never returned; a personal
 * chat message carries no projectId and so never matches either.
 */
import { v } from "convex/values";
import { action, internalQuery, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { assertServiceToken } from "./lib/authz";
import {
  clampPastWorkLimit,
  mergePastWorkHits,
  pastWorkSearchText,
  type PastWorkHit,
  type PastWorkSearchResult,
} from "./lib/pastWork";

const searchArgs = {
  projectId: v.id("projects"),
  query: v.string(),
  limit: v.optional(v.number()),
  /** The task asking (its own rows are not "past" work). */
  excludeTaskId: v.optional(v.id("tasks")),
};

export async function searchPastWork(
  ctx: QueryCtx,
  args: { projectId: Id<"projects">; query: string; limit?: number; excludeTaskId?: Id<"tasks"> }
): Promise<PastWorkSearchResult> {
  const query = pastWorkSearchText(args.query);
  const limit = clampPastWorkLimit(args.limit);
  if (!query) return { query, limit, hits: [], capped: false };
  const take = limit + 1;
  const projectId = args.projectId;
  const notExcluded = (taskId?: Id<"tasks">) => !args.excludeTaskId || taskId !== args.excludeTaskId;

  const [tasks, briefs, messages] = await Promise.all([
    ctx.db
      .query("tasks")
      .withSearchIndex("search_title", (q) => q.search("title", query).eq("projectId", projectId))
      .take(take),
    ctx.db
      .query("taskBriefs")
      .withSearchIndex("search_latest_result", (q) => q.search("latestResult", query).eq("projectId", projectId))
      .take(take),
    ctx.db
      .query("messages")
      .withSearchIndex("search_content", (q) => q.search("content", query).eq("projectId", projectId))
      .take(take * 2),
  ]);

  const taskHits: PastWorkHit[] = tasks
    .filter((task) => task.projectId === projectId && notExcluded(task._id))
    .map((task) => ({
      kind: "task",
      taskId: task._id,
      title: task.title,
      text: task.command || task.title,
      at: task.completedAt ?? task.updatedAt ?? task._creationTime,
    }));

  const resultHits: PastWorkHit[] = [];
  for (const brief of briefs) {
    if (brief.projectId !== projectId || !brief.latestResult || !notExcluded(brief.taskId)) continue;
    const task: Doc<"tasks"> | null = await ctx.db.get(brief.taskId);
    if (!task || task.projectId !== projectId) continue;
    resultHits.push({ kind: "result", taskId: brief.taskId, title: task.title, text: brief.latestResult, at: brief.updatedAt });
  }

  const messageHits: PastWorkHit[] = messages
    .filter(
      (m) =>
        m.projectId === projectId &&
        notExcluded(m.taskId) &&
        m.voice !== "system" &&
        m.streaming !== true &&
        m.content.trim().length > 0
    )
    .slice(0, take)
    .map((m) => ({
      kind: "message",
      ...(m.taskId ? { taskId: m.taskId } : {}),
      title: m.authorType === "user" ? "user" : "agent",
      text: m.content,
      at: m._creationTime,
    }));

  const { hits, capped } = mergePastWorkHits([taskHits, resultHits, messageHits], limit);
  return { query, limit, hits, capped };
}

export const search = internalQuery({
  args: searchArgs,
  handler: async (ctx, args): Promise<PastWorkSearchResult> => await searchPastWork(ctx, args),
});

/**
 * Worker entry (service token). Kept here rather than in worker.ts, which is
 * at its line budget; the shape is the same thin authenticated wrapper.
 */
export const forWorker = action({
  args: { workerToken: v.string(), ...searchArgs },
  handler: async (ctx, args): Promise<PastWorkSearchResult> => {
    const { workerToken, ...rest } = args;
    assertServiceToken(workerToken);
    return await ctx.runQuery(internal.pastWork.search, rest);
  },
});
