/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("queue claim (M1/M2)", () => {
  test("claimNextMessage orders by projectId and marks claimed; second claim gets the next", async () => {
    const t = convexTest(schema, modules);
    const { p1, p2 } = await t.run(async (ctx) => {
      const p1 = await ctx.db.insert("projects", { name: "P1", workspacePath: "/tmp/p1" });
      const p2 = await ctx.db.insert("projects", { name: "P2", workspacePath: "/tmp/p2" });
      await ctx.db.insert("messages", {
        projectId: p2,
        authorType: "user",
        content: "in p2",
        queueStatus: "pending",
        attempts: 0,
      });
      await ctx.db.insert("messages", {
        projectId: p1,
        authorType: "user",
        content: "in p1",
        queueStatus: "pending",
        attempts: 0,
      });
      return { p1, p2 };
    });

    const first = await t.mutation(internal.messages.claimNextMessage, { workerId: "w1" });
    expect(first).not.toBeNull();
    expect(first!.projectId).toBe(p1); // projectId order
    expect(first!.queueStatus).toBe("claimed");
    expect(first!.leasedBy).toBe("w1");

    const second = await t.mutation(internal.messages.claimNextMessage, { workerId: "w2" });
    expect(second).not.toBeNull();
    expect(second!.projectId).toBe(p2);

    const third = await t.mutation(internal.messages.claimNextMessage, { workerId: "w1" });
    expect(third).toBeNull(); // no double-claim: both claimed, none pending
  });

  test("retry / cancel / complete transitions", async () => {
    const t = convexTest(schema, modules);
    const { projectId, messageId } = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
      const messageId = await ctx.db.insert("messages", {
        projectId,
        authorType: "user",
        content: "hi",
        queueStatus: "pending",
        attempts: 0,
      });
      return { projectId, messageId };
    });

    const claimed = await t.mutation(internal.messages.claimNextMessage, { workerId: "w1" });
    expect(claimed?._id).toBe(messageId);
    const completed = await t.mutation(internal.messages.completeMessage, {
      messageId,
      workerId: "w1",
    });
    expect(completed.applied).toBe(true);

    // cancel via direct insert of pending
    const m2 = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        projectId,
        authorType: "user",
        content: "cancel me",
        queueStatus: "pending",
        attempts: 0,
      })
    );
    const cancelled = await t.mutation(internal.messages.cancelMessage, { messageId: m2 });
    expect(cancelled.applied).toBe(true);

    // fail → retry
    const m3 = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        projectId,
        authorType: "user",
        content: "fail me",
        queueStatus: "claimed",
        leasedBy: "w1",
        leaseExpiresAt: Date.now() + 60000,
        attempts: 3,
      })
    );
    const failed = await t.mutation(internal.messages.failMessage, {
      messageId: m3,
      workerId: "w1",
      error: "boom",
    });
    expect(failed.applied).toBe(true);
    expect((failed as any).next).toBe("failed");
    const retried = await t.mutation(internal.messages.retryMessage, { messageId: m3 });
    expect(retried.applied).toBe(true);
  });

  test("recoverStaleMessages requeues expired leases and fails after bound", async () => {
    const t = convexTest(schema, modules);
    const projectId = await t.run(async (ctx) =>
      ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" })
    );
    const m1 = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        projectId,
        authorType: "user",
        content: "stale",
        queueStatus: "claimed",
        leasedBy: "w1",
        leaseExpiresAt: 1, // expired
        attempts: 1,
      })
    );
    const m2 = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        projectId,
        authorType: "user",
        content: "stale bound",
        queueStatus: "claimed",
        leasedBy: "w1",
        leaseExpiresAt: 1,
        attempts: 3,
      })
    );
    const res = await t.mutation(internal.messages.recoverStaleMessages, { workerId: "w1" });
    expect(res.requeued).toBe(1);
    expect(res.failed).toBe(1);
    const after1 = await t.run(async (ctx) => ctx.db.get(m1));
    expect(after1?.queueStatus).toBe("pending");
    const after2 = await t.run(async (ctx) => ctx.db.get(m2));
    expect(after2?.queueStatus).toBe("failed");
  });
});
