/**
 * Cron wrappers (Settings → Scheduled tasks / Maintenance).
 *
 * Every cron in crons.ts points at a wrapper here instead of the job
 * itself. The wrapper runs the job unchanged and records its last run in
 * `cronRuns` (start, finish, ok/failed, a short result), so Settings can
 * show when each job last ran. Mutation jobs run in a sub-transaction
 * (ctx.runMutation): a failing job rolls back its own writes and the
 * failure is still recorded. "Run now" schedules the same wrapper.
 *
 * G3: while automation is held (lib/automationHold.ts), the jobs in
 * HELD_CRON_JOBS skip their work and record "held"; "Run now" is a
 * person's request and still runs.
 */
import { internalAction, internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { assertRegistryWriteAccess } from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";
import { cronHeld, HELD_CRON_JOBS, loadAutomationHold } from "./lib/automationHold";

export const CRON_JOBS = [
  {
    name: "refresh task pull requests",
    schedule: "Every 10 minutes",
    description: "Keeps task pull request status (draft, open, merged, closed) current.",
    kind: "action",
  },
  {
    name: "prune context snapshots",
    schedule: "Daily at 19:30 UTC",
    description: "Deletes context snapshots past each project's retention.",
    kind: "mutation",
  },
  {
    name: "task watchdog",
    schedule: "Every 5 minutes",
    description: "Recovers lapsed leases and fails tasks with no progress.",
    kind: "mutation",
  },
  {
    name: "sweep stale task worktrees",
    schedule: "Every 6 hours",
    description: "Removes worktrees of finished tasks past the retention window.",
    kind: "action",
  },
  {
    name: "recover expired task leases",
    schedule: "Every 30 seconds",
    description: "Requeues tasks whose lease expired and marks silent workers offline.",
    kind: "mutation",
  },
  {
    name: "sweep stale chat replies",
    schedule: "Every 2 minutes",
    description: "Settles chat replies whose run died as interrupted or failed.",
    kind: "mutation",
  },
  {
    name: "run scheduled tasks",
    schedule: "Every minute",
    description: "Fires your scheduled tasks that are due; while automation is held each one records held.",
    kind: "mutation",
  },
] as const;

export type CronJobName = (typeof CRON_JOBS)[number]["name"];

const triggerArg = { trigger: v.optional(v.string()) };

function summarize(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  try {
    return JSON.stringify(result).slice(0, 300);
  } catch {
    return undefined;
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

async function writeRun(
  ctx: MutationCtx,
  name: string,
  patch: {
    lastStartedAt?: number;
    lastFinishedAt?: number;
    lastStatus: "running" | "ok" | "failed" | "held";
    lastError?: string;
    lastResult?: string;
    trigger?: string;
  },
  countRun: boolean
) {
  const row = await ctx.db
    .query("cronRuns")
    .withIndex("by_name", (q) => q.eq("name", name))
    .first();
  if (row) {
    await ctx.db.patch(row._id, {
      ...patch,
      // A new run clears the previous outcome.
      ...(patch.lastStatus === "running" ? { lastError: undefined, lastResult: undefined, lastFinishedAt: undefined } : {}),
      ...(countRun ? { runCount: (row.runCount ?? 0) + 1 } : {}),
    });
  } else {
    await ctx.db.insert("cronRuns", {
      name,
      lastStartedAt: patch.lastStartedAt ?? Date.now(),
      lastStatus: patch.lastStatus,
      ...(patch.lastFinishedAt !== undefined ? { lastFinishedAt: patch.lastFinishedAt } : {}),
      ...(patch.lastError ? { lastError: patch.lastError } : {}),
      ...(patch.lastResult ? { lastResult: patch.lastResult } : {}),
      ...(patch.trigger ? { trigger: patch.trigger } : {}),
      runCount: countRun ? 1 : 0,
    });
  }
}

/** Used by the action wrappers (actions can not write directly). */
export const recordRun = internalMutation({
  args: {
    name: v.string(),
    lastStatus: v.union(v.literal("running"), v.literal("ok"), v.literal("failed"), v.literal("held")),
    lastStartedAt: v.optional(v.number()),
    lastFinishedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    lastResult: v.optional(v.string()),
    trigger: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { name, ...patch } = args;
    await writeRun(ctx, name, patch, patch.lastStatus === "running");
  },
});

/** Record a skipped run: the job did nothing because automation is held. */
async function writeHeld(ctx: MutationCtx, name: CronJobName, trigger: string | undefined) {
  const now = Date.now();
  await writeRun(ctx, name, { lastStartedAt: now, lastFinishedAt: now, lastStatus: "held", trigger: trigger ?? "cron", lastError: undefined, lastResult: undefined }, false);
}

/** For the action wrappers: true (and the "held" row written) when this run must skip. */
export const holdRun = internalMutation({
  args: { name: v.string(), trigger: v.optional(v.string()) },
  handler: async (ctx, args): Promise<boolean> => {
    if (!cronHeld(args.name, args.trigger, await loadAutomationHold(ctx))) return false;
    await writeHeld(ctx, args.name as CronJobName, args.trigger);
    return true;
  },
});

/** Run one mutation job in a sub-transaction and record the outcome. */
async function runMutationJob(
  ctx: MutationCtx,
  name: CronJobName,
  trigger: string | undefined,
  job: () => Promise<unknown>
) {
  if (cronHeld(name, trigger, await loadAutomationHold(ctx))) return await writeHeld(ctx, name, trigger);
  const startedAt = Date.now();
  try {
    const result = await job();
    await writeRun(ctx, name, {
      lastStartedAt: startedAt,
      lastFinishedAt: Date.now(),
      lastStatus: "ok",
      lastResult: summarize(result),
      trigger: trigger ?? "cron",
      lastError: undefined,
    }, true);
  } catch (error) {
    await writeRun(ctx, name, {
      lastStartedAt: startedAt,
      lastFinishedAt: Date.now(),
      lastStatus: "failed",
      lastError: errorText(error),
      trigger: trigger ?? "cron",
      lastResult: undefined,
    }, true);
  }
}

export const pruneContextSnapshots = internalMutation({
  args: triggerArg,
  handler: async (ctx, args) => {
    await runMutationJob(ctx, "prune context snapshots", args.trigger, () =>
      ctx.runMutation(internal.contextSnapshots.prune, {})
    );
  },
});

export const taskWatchdog = internalMutation({
  args: triggerArg,
  handler: async (ctx, args) => {
    await runMutationJob(ctx, "task watchdog", args.trigger, () => ctx.runMutation(internal.taskWatchdog.run, {}));
  },
});

export const recoverExpiredLeases = internalMutation({
  args: triggerArg,
  handler: async (ctx, args) => {
    await runMutationJob(ctx, "recover expired task leases", args.trigger, () =>
      ctx.runMutation(internal.orchestration.recoverStale, {})
    );
  },
});

export const sweepStaleChatReplies = internalMutation({
  args: triggerArg,
  handler: async (ctx, args) => {
    await runMutationJob(ctx, "sweep stale chat replies", args.trigger, () =>
      ctx.runMutation(internal.chatReplies.sweepStale, {})
    );
  },
});

// G7: the tick checks the hold per scheduled task (a "held" run row each),
// so it is not in HELD_CRON_JOBS and always runs.
export const runScheduledTasks = internalMutation({
  args: triggerArg,
  handler: async (ctx, args) => {
    await runMutationJob(ctx, "run scheduled tasks", args.trigger, () => ctx.runMutation(internal.scheduledTasks.tick, {}));
  },
});

export const refreshTaskPullRequests = internalAction({
  args: triggerArg,
  handler: async (ctx, args) => {
    const name: CronJobName = "refresh task pull requests";
    if (await ctx.runMutation(internal.cronJobs.holdRun, { name, trigger: args.trigger })) return;
    const startedAt = Date.now();
    const trigger = args.trigger ?? "cron";
    await ctx.runMutation(internal.cronJobs.recordRun, { name, lastStatus: "running", lastStartedAt: startedAt, trigger });
    try {
      const result = await ctx.runAction(internal.githubPush.refreshOpenPrs, {});
      await ctx.runMutation(internal.cronJobs.recordRun, {
        name,
        lastStatus: "ok",
        lastFinishedAt: Date.now(),
        lastResult: summarize(result),
      });
    } catch (error) {
      await ctx.runMutation(internal.cronJobs.recordRun, {
        name,
        lastStatus: "failed",
        lastFinishedAt: Date.now(),
        lastError: errorText(error),
      });
    }
  },
});

export const sweepStaleWorktrees = internalAction({
  args: triggerArg,
  handler: async (ctx, args) => {
    const name: CronJobName = "sweep stale task worktrees";
    if (await ctx.runMutation(internal.cronJobs.holdRun, { name, trigger: args.trigger })) return;
    const startedAt = Date.now();
    const trigger = args.trigger ?? "cron";
    await ctx.runMutation(internal.cronJobs.recordRun, { name, lastStatus: "running", lastStartedAt: startedAt, trigger });
    try {
      const result = await ctx.runAction(internal.worktreeNode.sweepStaleWorktrees, {});
      await ctx.runMutation(internal.cronJobs.recordRun, {
        name,
        lastStatus: "ok",
        lastFinishedAt: Date.now(),
        lastResult: summarize(result),
      });
    } catch (error) {
      await ctx.runMutation(internal.cronJobs.recordRun, {
        name,
        lastStatus: "failed",
        lastFinishedAt: Date.now(),
        lastError: errorText(error),
      });
    }
  },
});

/** Every cron with its schedule and last recorded run. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    await assertRegistryWriteAccess(ctx);
    const rows = await ctx.db.query("cronRuns").take(50);
    const byName = new Map(rows.map((row) => [row.name, row]));
    return CRON_JOBS.map((job) => {
      const run = byName.get(job.name);
      return {
        name: job.name,
        schedule: job.schedule,
        description: job.description,
        lastStartedAt: run?.lastStartedAt ?? null,
        lastFinishedAt: run?.lastFinishedAt ?? null,
        lastStatus: run?.lastStatus ?? null,
        lastError: run?.lastError ?? null,
        lastResult: run?.lastResult ?? null,
        trigger: run?.trigger ?? null,
        runCount: run?.runCount ?? 0,
        heldByAutomationHold: HELD_CRON_JOBS.has(job.name) || job.name === "run scheduled tasks",
      };
    });
  },
});

/** "Run now" (Scheduled tasks, Maintenance): schedules the wrapper at once. */
export const runNow = mutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    await assertRegistryWriteAccess(ctx);
    const trigger = { trigger: "manual" };
    switch (args.name as CronJobName) {
      case "refresh task pull requests":
        await ctx.scheduler.runAfter(0, internal.cronJobs.refreshTaskPullRequests, trigger);
        break;
      case "prune context snapshots":
        await ctx.scheduler.runAfter(0, internal.cronJobs.pruneContextSnapshots, trigger);
        break;
      case "task watchdog":
        await ctx.scheduler.runAfter(0, internal.cronJobs.taskWatchdog, trigger);
        break;
      case "sweep stale task worktrees":
        await ctx.scheduler.runAfter(0, internal.cronJobs.sweepStaleWorktrees, trigger);
        break;
      case "recover expired task leases":
        await ctx.scheduler.runAfter(0, internal.cronJobs.recoverExpiredLeases, trigger);
        break;
      case "sweep stale chat replies":
        await ctx.scheduler.runAfter(0, internal.cronJobs.sweepStaleChatReplies, trigger);
        break;
      case "run scheduled tasks":
        await ctx.scheduler.runAfter(0, internal.cronJobs.runScheduledTasks, trigger);
        break;
      default:
        throw new Error(`Unknown scheduled task: ${args.name}`);
    }
    await recordAudit(ctx, { action: "settings.run_job", target: args.name });
    return { scheduled: true };
  },
});
