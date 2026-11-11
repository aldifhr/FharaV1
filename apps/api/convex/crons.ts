import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Every job runs through its wrapper in cronJobs.ts, which runs the job
// unchanged and records its last run (Settings → Scheduled tasks).

// Plan 019: keep task PR status (draft/open/merged/closed) current. Each run
// refreshes a bounded batch (githubPush.listPrsToRefresh), oldest first.
crons.interval("refresh task pull requests", { minutes: 10 }, internal.cronJobs.refreshTaskPullRequests, {});

// Context Snapshot retention: delete snapshots past each project's
// retention (default 14 days). Bounded batches; reschedules itself.
crons.daily("prune context snapshots", { hourUTC: 19, minuteUTC: 30 }, internal.cronJobs.pruneContextSnapshots, {});

// Task watchdog: recover lapsed leases without a live worker, and fail
// running tasks with no progress for TASK_WATCHDOG_STUCK_MS (30 min default)
// so nothing stays in planning/replanning limbo (taskWatchdog.ts).
crons.interval("task watchdog", { minutes: 5 }, internal.cronJobs.taskWatchdog, {});

// Stale worktrees: finished tasks past FHARA_WORKTREE_RETENTION_HOURS
// (default 72, Settings → Worktrees overrides it) lose their worktree
// unless a PR is still open; the branch is kept. Bounded batch per run.
crons.interval("sweep stale task worktrees", { hours: 6 }, internal.cronJobs.sweepStaleWorktrees, {});

// Lease recovery that does not depend on a live worker: requeue (or fail)
// running tasks whose lease expired, release dead approval-resume claims,
// and mark silent workers offline. The worker still calls `recover` every
// 30 s as a backup; recoverStale is idempotent, so running both is safe.
crons.interval("recover expired task leases", { seconds: 30 }, internal.cronJobs.recoverExpiredLeases, {});

// Durable chat replies: settle replies whose action died (10-minute Node cap,
// deploy, OOM) as interrupted/failed after CHAT_REPLY_STALE_MS (default
// 15 min, Settings → Threads overrides it), and move legacy chat rows out of
// the worker queue.
crons.interval("sweep stale chat replies", { minutes: 2 }, internal.cronJobs.sweepStaleChatReplies, {});

// GOAT G7: fire the user's scheduled tasks that are due, once per occurrence
// (scheduledTasks.ts). Honours the G3 automation hold per task.
crons.interval("run scheduled tasks", { minutes: 1 }, internal.cronJobs.runScheduledTasks, {});

// GOAT G13: expire CTO decision turns past their deadline (never auto-picking)
// and retry answers committed to the outbox but not yet delivered.
crons.interval("sweep decision turns", { minutes: 1 }, internal.cronJobs.sweepDecisionTurns, {});

export default crons;
