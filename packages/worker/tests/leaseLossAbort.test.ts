import { describe, expect, it } from "vitest";
import { armTaskAbort, combineSignals, isLeaseLostOrShutdown, LEASE_LOST_PREFIX } from "@/services/runner/abort";
import type { ExecutionPolicy } from "@/orchestrator/policy";

const policy = { taskTimeoutMs: 60_000, idleTimeoutMs: 0 } as unknown as ExecutionPolicy;

describe("lease loss stops the task run", () => {
  it("a lease-guard abort reaches the run signal with its Lease lost reason", () => {
    const shutdown = new AbortController();
    const guard = new AbortController();
    const run = armTaskAbort(policy, combineSignals(shutdown.signal, guard.signal));
    expect(run.controller.signal.aborted).toBe(false);
    guard.abort(new Error(`${LEASE_LOST_PREFIX}: heartbeat could not renew the lease for task t1`));
    expect(run.controller.signal.aborted).toBe(true);
    const reason = run.controller.signal.reason as Error;
    expect(reason.message.startsWith(LEASE_LOST_PREFIX)).toBe(true);
    // The worker's startTask treats it as "no longer owned", never as a failure.
    expect(isLeaseLostOrShutdown(reason)).toBe(true);
    run.dispose();
  });

  it("a worker shutdown still aborts with the shutdown reason", () => {
    const shutdown = new AbortController();
    const run = armTaskAbort(policy, shutdown.signal);
    shutdown.abort(new Error("anything"));
    expect((run.controller.signal.reason as Error).message).toBe("Worker shutting down");
    run.dispose();
  });
});
