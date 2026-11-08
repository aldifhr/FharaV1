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

dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

const POLL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 1500);
const HEARTBEAT_MS = Number(process.env.WORKER_HEARTBEAT_MS ?? 10_000);
const LEASE_MS = Number(process.env.WORKER_LEASE_MS ?? 60_000);
const CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 2));
const STALE_GRACE_MS = Number(process.env.WORKER_STALE_GRACE_MS ?? 30_000);

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
  const api = new WorkerApi(client, process.env.CONVEX_SERVICE_TOKEN!);
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
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? "./workspaces";
  const inFlight = new Map<string, Promise<void>>();

  let stopping = false;
  let lastRecovery = 0;

  const deps: RunnerDeps = {
    api,
    workerId,
    policy,
    workspaceRoot,
    log,
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

  const heartbeat = setInterval(() => {
    api
      .heartbeat({
        workerId,
        hostname: os.hostname(),
        capacity: CONCURRENCY,
        activeTasks: inFlight.size,
        leaseMs: LEASE_MS,
      })
      .catch((error) => log("heartbeat failed", error));
    const now = Date.now();
    if (now - lastRecovery >= 30_000) {
      lastRecovery = now;
      api
        .recover({ staleGraceMs: STALE_GRACE_MS })
        .catch((error) => log("recovery failed", error));
    }
  }, HEARTBEAT_MS);

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`received ${signal}, shutting down`);
    clearInterval(heartbeat);
    // Plan 009: kill every MCP child process before the worker exits.
    await getMcpRegistry().disposeAll().catch(() => undefined);
    await api.markOffline({ workerId }).catch(() => undefined);
    const deadline = Date.now() + 15_000;
    while (inFlight.size > 0 && Date.now() < deadline) {
      await sleep(200);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const startTask = (taskId: WorkerTask["_id"], runner: () => Promise<void>) => {
    if (inFlight.has(taskId)) return;
    const promise = runner()
      .catch(async (error) => {
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

  while (!stopping) {
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
