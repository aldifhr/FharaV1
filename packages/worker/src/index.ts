// Must stay the first import: loads the root .env before any other module is evaluated.
import "./utils/loadEnv";
import { wenv } from "@fhara/config/worker";
import { sweepSpill } from "@/context/toolOutputSpill";
import { sandboxCapability, sandboxStatus } from "@/tools/osSandbox";
import os from "node:os";
import { createConvexClient, createConvexSubscriber } from "./convexClient";
import { WorkerApi, type WorkerTask } from "./workerApi";
import { loadPolicy } from "./orchestrator/policy";
import { setWorkerLlmConcurrencyLimit } from "./effects/llmCall";
import { setSnapshotSink } from "./llm/snapshots";
import { providerHealth } from "./llm/health";
import { getMcpRegistry } from "./mcp/registry";
import { processTask, resumeTask, type RunnerDeps } from "./services/taskRunner";
import { combineSignals, isLeaseLostOrShutdown, LEASE_LOST_PREFIX } from "./services/runner/abort";
import { commandAuditRow, processNextPushRequest } from "./services/pushRequests";
import { setCommandSink } from "./utils/accessLog";
import { processNextMcpTest } from "./services/mcpTests";
import { processNextRepoToolCall } from "./services/repoTools";
import { pollOpencodeCatalog } from "./services/opencodeCatalog";
import { effectiveWorkspaceRoot, reportKnobEnv, syncAppSettings } from "./services/appSettings";
import { REPO_TOOLS_CAPABILITY } from "@/api/convex/lib/chat/repoTools";
import { DirectThreads } from "./direct";
import { installConsoleRedaction, registerEnvSecrets } from "./utils/redact";

// L2: the worker's own logs (stdout/stderr) never print a known secret.
registerEnvSecrets();
installConsoleRedaction();

// Read once at startup, after dotenv. Parse rules: env schema (B3: a value
// that is not a number falls back to the default with a warning, then clamps).
const POLL_MS = wenv("WORKER_POLL_INTERVAL_MS");
// With the pendingWork subscription live, the poll is only the correctness
// fallback (a missed push, timers the subscription cannot see).
const FALLBACK_POLL_MS = Math.max(POLL_MS, wenv("WORKER_FALLBACK_POLL_MS"));
const HEARTBEAT_MS = wenv("WORKER_HEARTBEAT_MS");
const LEASE_MS = wenv("WORKER_LEASE_MS");
const CONCURRENCY = wenv("WORKER_CONCURRENCY"); // ≥ 1
const STALE_GRACE_MS = wenv("WORKER_STALE_GRACE_MS");
// Plan 019: how often an idle worker checks for approved push requests.
const PUSH_POLL_MS = wenv("WORKER_PUSH_POLL_MS"); // ≥ 1000
// Integrations: how often an idle worker checks for MCP "Test connection" requests.
const MCP_TEST_POLL_MS = wenv("WORKER_MCP_TEST_POLL_MS"); // ≥ 1000
// Grounded chat repo tools: a chat reply waits on these, so the poll is
// fast while a reply is using tools and slower when idle.
const REPO_TOOL_IDLE_POLL_MS = wenv("WORKER_REPO_TOOL_POLL_MS"); // ≥ 250
const REPO_TOOL_HOT_POLL_MS = 200;
const REPO_TOOL_HOT_WINDOW_MS = 30_000;
// Plan 033: how often the worker checks whether the OpenCode model catalog
// needs a refresh (the UI can request one at any time).
const OPENCODE_CATALOG_POLL_MS = wenv("WORKER_OPENCODE_CATALOG_POLL_MS"); // ≥ 5000

const workerId =
  wenv("WORKER_ID") ??
  `${os.hostname()}-${process.pid}`;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(...args: unknown[]) {
  console.log(`[worker:${workerId}]`, ...args);
}

async function main() {
  const client = createConvexClient();
  // D6: probe the command sandbox once. A non-off mode without bwrap is
  // reported loudly (SANDBOX_UNAVAILABLE); commands then ask before running
  // unconfined instead of running unconfined silently.
  const sandbox = sandboxStatus();
  (sandbox.code ? console.warn : console.log)(`[worker:${workerId}] ${sandbox.note}`);
  const sandboxTag = sandboxCapability(sandbox);
  const api = new WorkerApi(client, wenv("CONVEX_SERVICE_TOKEN")!, workerId);
  // O5: git/gh commands without their own recorder (network git from
  // safeGit) still leave one sanitized `cmd` audit row.
  setCommandSink(async (entry) => {
    await api.recordAudit(commandAuditRow(entry, { workerId }));
  });
  const policy = loadPolicy();
  // Worker-wide LLM bound: configured ONCE here, from the worker's own
  // policy (WORKER_LLM_MAX_CONCURRENCY can override via env). Per-task
  // limits live on per-run gates inside the runner — no task ever
  // resizes this gate (Phase 4 hardening).
  setWorkerLlmConcurrencyLimit(policy.maxConcurrentLLMCalls);
  // Context Snapshots: every task LLM call → contextSnapshots (best effort;
  // CONTEXT_SNAPSHOTS=0 disables).
  setSnapshotSink((record) => api.recordContextSnapshot(record));
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
  // Settings → Workspace can override WORKSPACE_ROOT; deps.workspaceRoot
  // follows it (applied on each heartbeat by syncAppSettings).
  const workspaceRoot = effectiveWorkspaceRoot();
  const inFlight = new Map<string, Promise<void>>();
  // Per-task lease guard: aborted when a heartbeat reports the task lost.
  const leaseGuards = new Map<string, AbortController>();

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

  // Direct threads (threadbear T2): their own claim loop and live sessions,
  // beside the orchestrated task loop; their leases ride the heartbeat.
  const direct = new DirectThreads({
    api,
    workerId,
    workspaceRoot,
    policy,
    leaseMs: LEASE_MS,
    log,
    shutdownSignal: shutdownController.signal,
  });
  // Agent process groups a crashed worker left behind (Nuphos N2); the
  // first direct claim waits for this.
  void direct.sweepLeftovers();
  // D3: spill files of large tool output, past their retention (default 72 h).
  const sweepSpills = () => {
    try {
      const removed = sweepSpill();
      if (removed) log(`spill sweep: removed ${removed} task dir(s)`);
    } catch (error) {
      log("spill sweep failed", error);
    }
  };
  sweepSpills();
  setInterval(sweepSpills, 3_600_000).unref();

  log(
    `listening: convex=${wenv("NEXT_PUBLIC_CONVEX_URL")} root=${workspaceRoot} concurrency=${CONCURRENCY}`
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
        activeTasks: inFlight.size + direct.size,
        leaseMs: LEASE_MS,
        // Renew ONLY the leases of tasks this process is actually running,
        // so an abandoned task (no approval row, crashed run) expires and
        // is recovered instead of staying "running" forever (core H2).
        // Live direct threads keep theirs while a turn runs or a card waits.
        activeTaskIds: [...Array.from(inFlight.keys()), ...direct.activeTaskIds()],
        // Grounded chat only queues repo tool calls when an online worker
        // advertises that it polls for them (an older build does not).
        capabilities: [REPO_TOOLS_CAPABILITY, sandboxTag],
      })
      .then((result) => {
        // Stop runs this worker no longer owns (recovery requeued them or
        // another worker claimed them): every write would be refused
        // anyway, and side effects (commands, pushes) must not continue.
        for (const taskId of result?.lostTaskIds ?? []) {
          direct.lost(taskId);
          const guard = leaseGuards.get(taskId);
          if (!guard || guard.signal.aborted) continue;
          log("lease lost, stopping task", taskId);
          guard.abort(new Error(`${LEASE_LOST_PREFIX}: heartbeat could not renew the lease for task ${taskId}`));
        }
      })
      .catch((error) => log("heartbeat failed", error));
  // Settings modal overrides (knobs, child env, workspace root) before the
  // first claim, then on every heartbeat.
  await syncAppSettings(api, deps, log);
  // Register the worker row before claiming anything (core H7).
  await sendHeartbeat();
  // Settings shows this worker's env as the default for worker knobs.
  void reportKnobEnv(api, workerId, log);
  const heartbeat = setInterval(() => {
    void sendHeartbeat();
    void syncAppSettings(api, deps, log);
    const now = Date.now();
    if (now - lastRecovery >= 30_000) {
      lastRecovery = now;
      api
        .recover({ staleGraceMs: STALE_GRACE_MS })
        .catch((error) => log("recovery failed", error));
    }
  }, HEARTBEAT_MS);

  // Wake-up subscription (convex-orchestrator pattern, re-implemented):
  // a new queued task or approval signal wakes the loop at once; the poll
  // below drops to FALLBACK_POLL_MS while the subscription is live.
  let wake: (() => void) | null = null;
  let woken = true;
  let subscribed = false;
  const subscriber = (() => {
    try {
      return createConvexSubscriber();
    } catch (error) {
      log("subscription unavailable, polling only:", error instanceof Error ? error.message : String(error));
      return null;
    }
  })();
  if (subscriber) {
    api.subscribePendingWork(
      subscriber,
      () => {
        subscribed = true;
        woken = true;
        wake?.();
      },
      (error) => {
        subscribed = false;
        log("pendingWork subscription error, polling:", error.message);
      }
    );
  }
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
    // Live direct threads: end their sessions and hand them back.
    await withTimeout(direct.shutdown(), 3_000);
    clearInterval(heartbeat);
    await withTimeout(subscriber?.close() ?? Promise.resolve(), 1_000);
    // Plan 009: kill every MCP child process before the worker exits.
    await withTimeout(getMcpRegistry().disposeAll(), 2_000);
    await withTimeout(api.markOffline({ workerId }), 2_000);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const startTask = (taskId: WorkerTask["_id"], runner: (taskDeps: RunnerDeps) => Promise<void>) => {
    if (inFlight.has(taskId)) return;
    const guard = new AbortController();
    leaseGuards.set(taskId, guard);
    const taskDeps: RunnerDeps = { ...deps, shutdownSignal: combineSignals(shutdownController.signal, guard.signal) };
    const promise = runner(taskDeps)
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
        leaseGuards.delete(taskId);
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
      workspaceRoot: deps.workspaceRoot,
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

  // Integrations: MCP "Test connection" requests, one at a time beside tasks.
  let mcpTestInFlight: Promise<void> | null = null;
  let lastMcpTestPoll = 0;
  const pollMcpTests = () => {
    const now = Date.now();
    if (mcpTestInFlight || stopping || now - lastMcpTestPoll < MCP_TEST_POLL_MS) return;
    lastMcpTestPoll = now;
    mcpTestInFlight = processNextMcpTest({ api, workerId, workspaceRoot: deps.workspaceRoot, log })
      .then((ran) => {
        if (ran) lastMcpTestPoll = 0;
      })
      .catch((error) => log("mcp test poll error", error instanceof Error ? error.message : String(error)))
      .finally(() => {
        mcpTestInFlight = null;
      });
  };

  // Grounded chat: read-only repo tool calls, on their own timer so a busy
  // task loop never delays a chat reply that is waiting on one.
  let lastRepoToolAt = 0;
  const pollRepoTools = async (): Promise<void> => {
    if (stopping) return;
    try {
      while (!stopping && (await processNextRepoToolCall({ api, workerId, workspaceRoot: deps.workspaceRoot, log }))) {
        lastRepoToolAt = Date.now();
      }
    } catch (error) {
      log("repo tool poll error", error instanceof Error ? error.message : String(error));
    }
    if (stopping) return;
    const hot = Date.now() - lastRepoToolAt < REPO_TOOL_HOT_WINDOW_MS;
    setTimeout(() => void pollRepoTools(), hot ? REPO_TOOL_HOT_POLL_MS : REPO_TOOL_IDLE_POLL_MS).unref();
  };
  void pollRepoTools();

  // Plan 033: the OpenCode model catalog. Reported once at boot (so the
  // agent editor has a list right away) and refreshed on request after that.
  let lastOpencodeCatalogPoll = 0;
  const pollOpencodeCatalogs = () => {
    const now = Date.now();
    if (stopping || now - lastOpencodeCatalogPoll < OPENCODE_CATALOG_POLL_MS) return;
    lastOpencodeCatalogPoll = now;
    void pollOpencodeCatalog({ api, workerId, hostname: os.hostname(), log });
  };

  let lastClaimPoll = 0;
  const idle = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        wake = null;
        resolve();
      }
      wake = done;
    });

  let directInFlight: Promise<unknown> | null = null;
  const pollDirect = () => {
    if (directInFlight || stopping) return;
    directInFlight = direct
      .tick()
      .catch((error) => log("direct claim error", error instanceof Error ? error.message : String(error)))
      .finally(() => {
        directInFlight = null;
      });
  };

  while (!stopping) {
    pollPushes();
    pollDirect();
    pollMcpTests();
    pollOpencodeCatalogs();
    try {
      if (inFlight.size >= CONCURRENCY) {
        await sleep(200);
        continue;
      }
      // Claim scans run when the subscription woke us, or on the fallback
      // period; without a live subscription, on every POLL_MS tick.
      const now = Date.now();
      const claimDue = !subscribed || woken || now - lastClaimPoll >= FALLBACK_POLL_MS;
      if (claimDue) {
        woken = false;
        lastClaimPoll = now;

        const resumable: Array<{
          task: WorkerTask;
          pendingCount: number;
          approvals: Array<{ kind: string; status: string }>;
        }> = await api.getResumable();
        // The backend only returns tasks an approval SIGNAL woke (and not
        // paused); the apply_changes check stays as a guard on what the
        // resume path knows how to continue.
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
            startTask(resumed.task._id, (taskDeps) => resumeTask(resumed.task._id, taskDeps));
            woken = true; // drain a backlog without waiting for the next push
            continue;
          }
        }

        const claimed = await api.claimTask({ workerId, leaseMs: LEASE_MS });
        if (claimed) {
          log(`picked task ${claimed._id}: ${claimed.title}`);
          startTask(claimed._id, (taskDeps) => processTask(claimed, taskDeps));
          woken = true;
          continue;
        }
      }
    } catch (error) {
      log("poll error", error);
    }
    // The push / MCP-test pollers ride this loop, so a subscribed worker
    // still ticks at their period; only the claim scans are skipped.
    await idle(subscribed ? Math.min(PUSH_POLL_MS, MCP_TEST_POLL_MS) : POLL_MS);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
