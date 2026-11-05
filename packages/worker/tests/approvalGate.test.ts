import { describe, it, expect, vi } from "vitest";
import { waitForApproval } from "../src/approvalGate";

describe("approval gate", () => {
  it("returns immediately when already approved", async () => {
    const getDecision = vi.fn().mockResolvedValue({ status: "approved" });
    const result = await waitForApproval(getDecision, { pollMs: 10, timeoutMs: 1000 });
    expect(result.status).toBe("approved");
    expect(getDecision).toHaveBeenCalledTimes(1);
  });

  it("polls until approved", async () => {
    let calls = 0;
    const getDecision = vi.fn().mockImplementation(async () => {
      calls++;
      return { status: calls < 3 ? "pending" : "approved" };
    });
    const result = await waitForApproval(getDecision, { pollMs: 5, timeoutMs: 1000 });
    expect(result.status).toBe("approved");
    expect(calls).toBe(3);
  });

  it("returns rejected", async () => {
    const getDecision = vi.fn().mockResolvedValue({ status: "rejected" });
    const result = await waitForApproval(getDecision, { pollMs: 5 });
    expect(result.status).toBe("rejected");
  });

  it("throws on timeout", async () => {
    const getDecision = vi.fn().mockResolvedValue({ status: "pending" });
    await expect(
      waitForApproval(getDecision, { pollMs: 5, timeoutMs: 30 })
    ).rejects.toThrow("timed out");
  });
});
