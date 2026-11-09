import dotenv from "dotenv";
import os from "node:os";
import path from "node:path";
import { createConvexClient } from "./convexClient";
import { WorkerApi, type WorkerTask } from "./workerApi";
import { loadPolicy } from "./orchestrator/policy";
import { setWorkerLlmConcurrencyLimit } from "./effects/llmCall";
import { providerHealth } from "./llm/health";
import { getMcpRegistry } from "./mcp/registry";
import { processTask, resumeTask, type RunnerDeps } from "./services/taskRunner";
import { isLeaseLostOrShutdown } from "./services/runner/abort";
import { processNextPushRequest } from "./services/pushRequests";

dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

const POLL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 1500);
const HEARTBEAT_MS = Number(process.env.WORKER_HEARTBEAT_MS ?? 10_000);
const LEASE_MS = Number(process.env.WORKER_LEASE_MS ?? 60_000);
const CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 1));
const STALE_GRACE_MS = Number(process.env.WORKER_STALE_GRACE_MS ?? 30_000);
// Plan 019: how often an idle worker checks for approved push requests.
const PUSH_POLL_MS = Math.max(1000, Number(process.env.WORKER_PUSH_POLL_MS ?? 5000));

const workerId =
  process.env.WORKER_ID ??
  `${os.hostname()}-${process.pid}`;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(...args: unknown[]) {
  console.log(`[worker:${workerId}]`, ...args);
}

async function main() {
  const client = createConvexClient();
  const api = new WorkerApi(client, process.env.CONVEX_SERVICE_TOKEN!, workerId);
  const policy = loadPolicy();
  // Worker-wide LLM bound: configured ONCE here, from the worker's own
  // policy (WORKER_LLM_MAX_CONCURRENCY can override via env). Per-task
  // limits live on per-run gates inside the runner — no task ever
  // resizes this gate (Phase 4 hardening).
  setWorkerLlmConcurrencyLimit(policy.maxConcurrentLLMCalls);
  // Provider health mirror (Phase 5): every circuit outcome the shared
  // registry records is reported to the backend, so the Settings UI
  // can render per-connection circuit state. Connections without a
  // registered backend name (env-fallback pseudo-connections) have no
  // provider row to attach a snapshot to and are skipped. Reporting is
  // best-effort — a failed report never affects a provider call.
  providerHealth.setChangeListener((connectionId, snapshot) => {
    const providerName = providerHealth.connectionName(connectionId);
    if (!providerName) return;
    void api
      .reportProviderHealth({
        providerId: connectionId as Parameters<
          WorkerApi["reportProviderHealth"]
        >[0]["providerId"],
        providerName,
        consecutiveTransientFailures: snapshot.consecutiveTransientFailures,
        totalSuccesses: snapshot.totalSuccesses,
        totalTransientFailures: snapshot.totalTransientFailures,
        circuitOpenUntil: snapshot.circuitOpenUntil ?? undefined,
        lastSuccessAt: snapshot.lastSuccessAt,
        lastFailureAt: snapshot.lastFailureAt,
      })
      .catch(() => undefined);
  });
  // Apply fixed-team migrations (retired roles, new default capabilities)
  // to existing data. Best-effort: a failure never blocks task claiming.
  try {
    const synced = await api.syncFixedTeam();
    log(`fixed team synced: ${synced.total} roles, ${synced.retired} retired`);
  } catch (error) {
    log("fixed team sync failed:", error instanceof Error ? error.message : String(error));
  }
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? "./workspaces";
  const inFlight = new Map<string, Promise<void>>();

  let stopping = false;
  let lastRecovery = 0;
  // Fired on SIGINT/SIGTERM: every in-flight task aborts and is left for
  // lease-expiry recovery instead of running on without lease renewal/MCP.
  const shutdownController = new AbortController();

  const deps: RunnerDeps = {
    api,
    workerId,
    policy,
    workspaceRoot,
    log,
    shutdownSignal: shutdownController.signal,
  };

  log(
    `listening: convex=${process.env.NEXT_PUBLIC_CONVEX_URL} root=${workspaceRoot} concurrency=${CONCURRENCY}`
  );

  // Retry recover until Convex is reachable (cloud or local dev)
  let recovery: { recoveredTasks: number; recoveredExecutions: number } | null = null;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      recovery = await api.recover({ staleGraceMs: STALE_GRACE_MS });
      break;
    } catch (err) {
      lastErr = err;
      if (attempt === 1 || attempt === 5 || attempt === 10 || attempt === 15 || attempt === 20 || attempt === 25 || attempt === 30) {
        log(`Convex not ready yet, retrying (${attempt}/30)...`, err instanceof Error ? err.message : err);
      }
      await sleep(1000);
    }
  }
  if (!recovery) throw new Error(`Convex did not become ready in time: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  if (recovery.recoveredTasks > 0 || recovery.recoveredExecutions > 0) {
    log(
      `recovered ${recovery.recoveredTasks} stale task(s) and ${recovery.recoveredExecutions} execution(s)`
    );
  }

  const sendHeartbeat = () =>
    api
      .heartbeat({
        workerId,
        hostname: os.hostname(),
        capacity: CONCURRENCY,
        activeTasks: inFlight.size,
        leaseMs: LEASE_MS,
        // Renew ONLY the leases of tasks this process is actually running,
        // so an abandoned task (no approval row, crashed run) expires and
        // is recovered instead of staying "running" forever (core H2).
        activeTaskIds: Array.from(inFlight.keys()),
      })
      .catch((error) => log("heartbeat failed", error));
  // Register the worker row before claiming anything (core H7).
  await sendHeartbeat();
  const heartbeat = setInterval(() => {
    void sendHeartbeat();
    const now = Date.now();
    if (now - lastRecovery >= 30_000) {
      lastRecovery = now;
      api
        .recover({ staleGraceMs: STALE_GRACE_MS })
        .catch((error) => log("recovery failed", error));
    }
  }, HEARTBEAT_MS);

  const SHUTDOWN_DRAIN_MS = 5_000;
  const SHUTDOWN_HARD_CAP_MS = 10_000;
  /** Settles after `ms` at the latest; never rejects. */
  const withTimeout = (p: Promise<unknown>, ms: number) =>
    Promise.race([p.catch(() => undefined), sleep(ms)]);
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`received ${signal}, shutting down`);
    // Order (core M12): 1) stop claiming (stopping=true above); 2) abort
    // every in-flight task; 3) wait for them to drain while heartbeat and
    // MCP are still alive; 4) only then stop heartbeat, dispose MCP and
    // mark offline. Interrupted tasks are not failed: their leases lapse
    // and recovery hands them to another worker.
    // Hard cap: Ctrl+C must always end the worker, even when Convex is
    // already down (npm run dev stops api first) and markOffline or an MCP
    // dispose never settles. Leases lapse on their own anyway.
    setTimeout(() => {
      log("shutdown took too long, exiting");
      process.exit(0);
    }, SHUTDOWN_HARD_CAP_MS).unref();
    shutdownController.abort(new Error("Worker shutting down"));
    const deadline = Date.now() + SHUTDOWN_DRAIN_MS;
    while (inFlight.size > 0 && Date.now() < deadline) {
      await sleep(200);
    }
    if (inFlight.size > 0) log(`${inFlight.size} task(s) still draining at exit; leases will expire`);
    clearInterval(heartbeat);
    // Plan 009: kill every MCP child process before the worker exits.
    await withTimeout(getMcpRegistry().disposeAll(), 2_000);
    await withTimeout(api.markOffline({ workerId }), 2_000);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const startTask = (taskId: WorkerTask["_id"], runner: () => Promise<void>) => {
    if (inFlight.has(taskId)) return;
    const promise = runner()
      .catch(async (error) => {
        // A displaced worker (lease fencing) or a shutdown abort must not
        // fail the task: the new owner / recovery owns it now.
        if (isLeaseLostOrShutdown(error)) {
          log("task stopped (no longer owned by this worker)", taskId, error instanceof Error ? error.message : error);
          return;
        }
        log("task failed", taskId, error);
        try {
          await api.completeTask({
            taskId,
            status: "failed",
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        } catch (cleanupError) {
          log("could not mark task failed", taskId, cleanupError);
        }
      })
      .finally(() => {
        inFlight.delete(taskId);
      });
    inFlight.set(taskId, promise);
  };

  // Plan 019: approved pushes run one at a time beside task execution
  // (they are short git/HTTP calls and do not take a task slot).
  let pushInFlight: Promise<void> | null = null;
  let lastPushPoll = 0;
  const pollPushes = () => {
    const now = Date.now();
    if (pushInFlight || stopping || now - lastPushPoll < PUSH_POLL_MS) return;
    lastPushPoll = now;
    pushInFlight = processNextPushRequest({
      api,
      workerId,
      workspaceRoot,
      log,
      signal: shutdownController.signal,
    })
      .then((ran) => {
        // Drain a backlog without waiting a full poll interval.
        if (ran) lastPushPoll = 0;
      })
      .catch((error) => log("push poll error", error instanceof Error ? error.message : String(error)))
      .finally(() => {
        pushInFlight = null;
      });
  };

  while (!stopping) {
    pollPushes();
    try {
      if (inFlight.size >= CONCURRENCY) {
        await sleep(200);
        continue;
      }

      const resumable: Array<{
        task: WorkerTask;
        pendingCount: number;
        approvals: Array<{ kind: string; status: string }>;
      }> = await api.getResumable();
      const resumed = resumable.find(
        (entry) =>
          entry.pendingCount === 0 &&
          !inFlight.has(entry.task._id) &&
          entry.approvals.some(
            (approval) =>
              approval.kind === "apply_changes" &&
              (approval.status === "approved" || approval.status === "rejected")
          )
      );

      if (resumed) {
        const claimedResume = await api.claimResumable({
          taskId: resumed.task._id,
          workerId,
          leaseMs: LEASE_MS,
        });
        if (claimedResume) {
          log(`resuming task ${resumed.task._id} after approval`);
          startTask(resumed.task._id, () => resumeTask(resumed.task._id, deps));
          continue;
        }
      }

      const claimed = await api.claimTask({ workerId, leaseMs: LEASE_MS });
      if (claimed) {
        log(`picked task ${claimed._id}: ${claimed.title}`);
        startTask(claimed._id, () => processTask(claimed, deps));
        continue;
      }
    } catch (error) {
      log("poll error", error);
    }
    await sleep(POLL_MS);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
