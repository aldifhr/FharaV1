/**
 * Bug repro: a user pause (or a long approval wait) while a shell subtask
 * waits for its run_command approval failed the subtask. Three paths did
 * it: the waiter turned "task paused" into a `paused` denial that the shell
 * executor maps to status "failed"; the scheduler's subtask timeout (5 min
 * default) fired under a 10 min approval wait and aborted the node; and the
 * abort then surfaced as a `cancelled` denial, also "failed".
 */
import { describe, expect, it, vi } from "vitest";
import { waitForCommandApproval, type CommandApprovalApi } from "@/services/runner/commandApproval";
import { runScheduler, type NodeOutcome } from "@/scheduler/dagScheduler";

const request = { taskId: "t1", projectId: "p1", subtaskKey: "shell", command: "npm", args: ["test"] };
const pending = { status: "pending", decision: null, note: null, taskStatus: "running" };

function mockApi(rows: Array<Record<string, unknown>>) {
  let i = 0;
  const api = {
    requestCommandApproval: vi.fn(async () => ({ status: "pending", approvalId: "a1", reason: "ask", offerAlways: true })),
    getCommandApproval: vi.fn(async () => rows[Math.min(i++, rows.length - 1)]),
    cancelCommandApproval: vi.fn(async () => ({ applied: true })),
    ackCommandApproval: vi.fn(async () => ({ consumed: 1 })),
  };
  return api as unknown as CommandApprovalApi & typeof api;
}

describe("pause during a run_command approval wait", () => {
  it("keeps waiting through a pause and runs on the user's allow (no cancel, no failure)", async () => {
    const api = mockApi([
      pending,
      { ...pending, taskStatus: "paused" },
      { ...pending, taskStatus: "paused" },
      { ...pending, status: "approved", decision: "allow", taskStatus: "paused" },
    ]);
    const out = await waitForCommandApproval(api, request, { sleep: async () => undefined });
    expect(out).toMatchObject({ allowed: true, via: "allow" });
    expect(api.cancelCommandApproval).not.toHaveBeenCalled();
    expect(api.ackCommandApproval).toHaveBeenCalledWith(expect.objectContaining({ approvalId: "a1" }));
  });

  it("holds the subtask clock while waiting and releases it after", async () => {
    const api = mockApi([pending, { ...pending, status: "rejected", decision: "deny" }]);
    const release = vi.fn();
    const holdClock = vi.fn(() => release);
    const out = await waitForCommandApproval(api, request, { sleep: async () => undefined, holdClock });
    expect(out.via).toBe("deny");
    expect(holdClock).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("an approval wait longer than the subtask timeout does not time the node out", async () => {
    const result = await runScheduler(
      [{ id: "shell", dependencies: [] }],
      async (_node, signal, info): Promise<NodeOutcome> => {
        const release = info.holdClock?.();
        await new Promise((resolve) => setTimeout(resolve, 250)); // the human wait
        release?.();
        if (signal.aborted) return { status: "failed", error: "aborted" };
        return { status: "completed", output: "ran" };
      },
      {
        maxConcurrency: 1,
        timeoutMs: 80,
        stallMs: 60,
        retries: 0,
        onStart: async () => undefined,
        onOutcome: async () => undefined,
      }
    );
    expect(result.status).toBe("completed");
  });

  it("the subtask timeout still applies to work outside the wait", async () => {
    const result = await runScheduler(
      [{ id: "shell", dependencies: [] }],
      async (): Promise<NodeOutcome> => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return { status: "completed" };
      },
      { maxConcurrency: 1, timeoutMs: 80, retries: 0, onStart: async () => undefined, onOutcome: async () => undefined }
    );
    expect(result.status).not.toBe("completed");
  });
});
