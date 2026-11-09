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

// Stale worktrees: finished tasks past FHARA_WORKTREE_RETENTION_HOURS
// (default 72) lose their worktree unless a PR is still open; the branch
// is kept. Bounded batch per run.
crons.interval("sweep stale task worktrees", { hours: 6 }, internal.worktreeNode.sweepStaleWorktrees, {});

// Lease recovery that does not depend on a live worker: requeue (or fail)
// running tasks whose lease expired, release dead approval-resume claims,
// and mark silent workers offline. The worker still calls `recover` every
// 30 s as a backup; recoverStale is idempotent, so running both is safe.
crons.interval("recover expired task leases", { seconds: 30 }, internal.orchestration.recoverStale, {});

export default crons;
