import { describe, expect, it, vi } from "vitest";
import { commandDeniedOutput, waitForCommandApproval, type CommandApprovalApi } from "@/services/runner/commandApproval";

const request = { taskId: "t1", projectId: "p1", subtaskKey: "s1", command: "npm", args: ["run", "test"] };

function mockApi(rows: Array<Record<string, unknown> | null>, start: Record<string, unknown> = { status: "pending", approvalId: "a1", reason: "ask", offerAlways: true }) {
  let i = 0;
  const api = {
    requestCommandApproval: vi.fn(async () => start),
    getCommandApproval: vi.fn(async () => rows[Math.min(i++, rows.length - 1)]),
    cancelCommandApproval: vi.fn(async () => ({ applied: true })),
  };
  return api as unknown as CommandApprovalApi & typeof api;
}

const noSleep = async () => undefined;
const pending = { status: "pending", decision: null, note: null, taskStatus: "running" };

describe("waitForCommandApproval", () => {
  it("returns at once when the backend auto-approves (rule / full access)", async () => {
    const api = mockApi([], { status: "auto", approvalId: "a1", reason: "Full access", offerAlways: true });
    const out = await waitForCommandApproval(api, request, { sleep: noSleep });
    expect(out).toMatchObject({ allowed: true, via: "auto" });
    expect(api.getCommandApproval).not.toHaveBeenCalled();
  });

  it("waits in-process until the user allows, beating the watchdog", async () => {
    const api = mockApi([pending, pending, { ...pending, status: "approved", decision: "always" }]);
    const onWaiting = vi.fn();
    const onPending = vi.fn();
    const out = await waitForCommandApproval(api, request, { sleep: noSleep, onWaiting, onPending });
    expect(out).toMatchObject({ allowed: true, via: "always" });
    expect(onPending).toHaveBeenCalledWith("a1");
    expect(onWaiting).toHaveBeenCalledTimes(2);
    expect(api.cancelCommandApproval).not.toHaveBeenCalled();
  });

  it("a denial carries the user's note (e.g. a chat reply)", async () => {
    const api = mockApi([{ ...pending, status: "rejected", decision: "deny", note: "user replied instead: pakai vitest" }]);
    const out = await waitForCommandApproval(api, request, { sleep: noSleep });
    expect(out).toMatchObject({ allowed: false, via: "deny", note: "user replied instead: pakai vitest" });
    expect(commandDeniedOutput("$ npm run test", out)).toContain("User note: user replied instead: pakai vitest");
  });

  it("stop (abort) cancels the row and ends the wait", async () => {
    const controller = new AbortController();
    const api = mockApi([pending]);
    const sleep = async () => controller.abort();
    const out = await waitForCommandApproval(api, request, { sleep, signal: controller.signal });
    expect(out).toMatchObject({ allowed: false, via: "cancelled" });
    expect(api.cancelCommandApproval).toHaveBeenCalledWith(expect.objectContaining({ approvalId: "a1" }));
  });

  it("pause cancels the row", async () => {
    const api = mockApi([{ ...pending, taskStatus: "paused" }]);
    const out = await waitForCommandApproval(api, request, { sleep: noSleep });
    expect(out.via).toBe("paused");
    expect(api.cancelCommandApproval).toHaveBeenCalled();
  });

  it("times out as a denial", async () => {
    let t = 0;
    const api = mockApi([pending]);
    const out = await waitForCommandApproval(api, request, { sleep: noSleep, now: () => (t += 60_000), timeoutMs: 120_000 });
    expect(out).toMatchObject({ allowed: false, via: "timeout" });
    expect(api.cancelCommandApproval).toHaveBeenCalled();
  });

  it("fails closed when the approval cannot be recorded", async () => {
    const api = mockApi([]);
    api.requestCommandApproval.mockRejectedValueOnce(new Error("Lease lost: x"));
    const out = await waitForCommandApproval(api, request, { sleep: noSleep });
    expect(out).toMatchObject({ allowed: false, via: "error" });
  });
});
