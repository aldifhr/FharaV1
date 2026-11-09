import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Plan 019: keep task PR status (draft/open/merged/closed) current. Each run
// refreshes a bounded batch (githubPush.listPrsToRefresh), oldest first.
crons.interval("refresh task pull requests", { minutes: 10 }, internal.githubPush.refreshOpenPrs, {});

// Context Snapshot retention: delete snapshots past each project's
// retention (default 14 days). Bounded batches; reschedules itself.
crons.daily("prune context snapshots", { hourUTC: 19, minuteUTC: 30 }, internal.contextSnapshots.prune, {});

// Task watchdog: recover lapsed leases without a live worker, and fail
// running tasks with no progress for TASK_WATCHDOG_STUCK_MS (30 min default)
// so nothing stays in planning/replanning limbo (taskWatchdog.ts).
crons.interval("task watchdog", { minutes: 5 }, internal.taskWatchdog.run, {});

export default crons;
