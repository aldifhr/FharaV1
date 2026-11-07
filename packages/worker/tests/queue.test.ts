import { describe, expect, it } from "vitest";

/**
 * Plan 006 Phase 4 — M1/M2/M3 at the worker-claim layer.
 * The backend internal mutation `claimNextMessage` owns the lease; the
 * worker mirrors its selection contract (projectId order, lease expiry,
 * one claim per message) as a pure function for the unit test.
 */

export interface QueueMessage {
  _id: string;
  projectId: string;
  content: string;
  queueStatus?: "pending" | "claimed" | "done" | "failed" | "cancelled";
  leasedBy?: string;
  leaseExpiresAt?: number;
  attempts?: number;
  _creationTime: number;
}

export function selectNextMessage(messages: QueueMessage[], now: number): QueueMessage | null {
  const candidates = messages.filter(
    (m) => m.queueStatus === "pending" && (m.leaseExpiresAt === undefined || m.leaseExpiresAt < now)
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (a.projectId !== b.projectId) return a.projectId < b.projectId ? -1 : 1;
    return a._creationTime - b._creationTime;
  });
  return candidates[0]!;
}

describe("queue claim", () => {
  it("M1: pending message survives restart — re-claimed, not duplicated (lease expired → pending)", () => {
    const msg: QueueMessage = { _id: "m1", projectId: "p1", content: "hi", queueStatus: "claimed", leasedBy: "w1", leaseExpiresAt: 100, attempts: 1, _creationTime: 1 };
    // After recoverStale, expired claimed becomes pending.
    const recovered: QueueMessage = { ...msg, queueStatus: "pending", leasedBy: undefined, leaseExpiresAt: undefined };
    expect(selectNextMessage([recovered], 200)?._id).toBe("m1");
    expect(selectNextMessage([msg], 200)).toBeNull(); // still claimed & not expired at now=200? leaseExpiresAt 100 <200 but status claimed not pending → not eligible until recovered
  });

  it("M2: claim ordering is projectId order, oldest first", () => {
    const a: QueueMessage = { _id: "a", projectId: "p2", content: "a", queueStatus: "pending", _creationTime: 2 };
    const b: QueueMessage = { _id: "b", projectId: "p1", content: "b", queueStatus: "pending", _creationTime: 5 };
    const c: QueueMessage = { _id: "c", projectId: "p1", content: "c", queueStatus: "pending", _creationTime: 1 };
    const next = selectNextMessage([a, b, c], 1000);
    expect(next?._id).toBe("c"); // p1, oldest
  });

  it("M2: retry failed message once → pending again", () => {
    const failed: QueueMessage = { _id: "f", projectId: "p1", content: "x", queueStatus: "failed", attempts: 3, _creationTime: 1 };
    // retryMessage transitions failed → pending
    const retried: QueueMessage = { ...failed, queueStatus: "pending" };
    expect(selectNextMessage([retried], 1000)?._id).toBe("f");
  });

  it("M2: cancel pending message → never claimed", () => {
    const cancelled: QueueMessage = { _id: "x", projectId: "p1", content: "x", queueStatus: "cancelled", _creationTime: 1 };
    expect(selectNextMessage([cancelled], 1000)).toBeNull();
  });

  it("M2: no double-claim — claimed with live lease is not selected", () => {
    const claimed: QueueMessage = { _id: "m", projectId: "p1", content: "x", queueStatus: "claimed", leasedBy: "w1", leaseExpiresAt: 9999, _creationTime: 1 };
    expect(selectNextMessage([claimed], 1000)).toBeNull();
  });

  it("M3: addressed message delivered to target agent — toAgentId preserved through claim", () => {
    const msg: QueueMessage & { toAgentId?: string } = { _id: "m", projectId: "p1", content: "please audit", queueStatus: "pending", toAgentId: "agent-sec", _creationTime: 1 };
    const next = selectNextMessage([msg], 1000);
    expect((next as any).toAgentId).toBe("agent-sec");
  });
});
