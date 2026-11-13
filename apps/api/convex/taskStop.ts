import { action, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { assertServiceToken } from "./lib/authz";

/**
 * Task Stop, worker side: the running task's status alone, polled by the
 * worker's per-task abort (packages/worker/src/services/runner/abort.ts) so a
 * user Stop (tasks.cancel) aborts planning, the DAG and every in-flight LLM
 * call within a couple of seconds. getContext would load the whole task
 * context on every poll.
 */
export const statusForWorker = action({
  args: { workerToken: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, args): Promise<string | null> => {
    assertServiceToken(args.workerToken);
    return await ctx.runQuery(internal.taskStop.statusOf, { taskId: args.taskId });
  },
});

export const statusOf = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args): Promise<string | null> => (await ctx.db.get(args.taskId))?.status ?? null,
});
