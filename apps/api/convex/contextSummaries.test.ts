/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

/**
 * Plan 006 Phase 3 — C3: scoped retrieval cursor.
 *
 * - `by_conversation` cursor pagination: latest first, stable ordering,
 *   `beforeCreationTime` semantics via `lastCompactAt` cursor.
 * - `by_project` index serves admin listing (covered indirectly).
 */

const modules = import.meta.glob("./**/*.ts");

describe("contextSummaries cursor retrieval (C3)", () => {
  test("paginates latest-first with cursor; ordering stable", async () => {
    const t = convexTest(schema, modules);
    const { projectId, conversationId } = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", {
        name: "P",
        workspacePath: "/tmp/p",
      });
      const conversationId = await ctx.db.insert("conversations", {
        projectId,
        status: "active",
        createdAt: 1,
      });
      const base = Date.now();
      for (let i = 0; i < 5; i++) {
        await ctx.db.insert("contextSummaries", {
          conversationId,
          projectId,
          summary: `summary-${i}`,
          lastCompactAt: base + i,
          summaryCharCount: 10 + i,
          messageCountBefore: 10 + i,
        });
      }
      return { projectId, conversationId };
    });

    const page1 = await t.query(internal.messages.getContextSummaries, {
      projectId,
      conversationId,
      limit: 2,
    });
    expect(page1).toHaveLength(2);
    expect(page1[0]!.summary).toBe("summary-4");
    expect(page1[1]!.summary).toBe("summary-3");

    const page2 = await t.query(internal.messages.getContextSummaries, {
      projectId,
      conversationId,
      limit: 2,
      cursor: page1[1]!.lastCompactAt,
    });
    expect(page2).toHaveLength(2);
    expect(page2[0]!.summary).toBe("summary-2");

    const all = await t.query(internal.messages.getContextSummaries, {
      projectId,
      conversationId,
      limit: 10,
    });
    expect(all.map((r) => r.summary)).toEqual([
      "summary-4",
      "summary-3",
      "summary-2",
      "summary-1",
      "summary-0",
    ]);
  });

  test("getLatestContextSummary returns the newest row or null", async () => {
    const t = convexTest(schema, modules);
    const { projectId, conversationId } = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", {
        name: "P",
        workspacePath: "/tmp/p",
      });
      const conversationId = await ctx.db.insert("conversations", {
        projectId,
        status: "active",
        createdAt: 1,
      });
      const now = Date.now();
      await ctx.db.insert("contextSummaries", {
        conversationId,
        projectId,
        summary: "old",
        lastCompactAt: now - 1000,
        summaryCharCount: 3,
        messageCountBefore: 5,
      });
      await ctx.db.insert("contextSummaries", {
        conversationId,
        projectId,
        summary: "new",
        lastCompactAt: now,
        summaryCharCount: 3,
        messageCountBefore: 6,
      });
      return { projectId, conversationId };
    });

    const latest = await t.query(internal.messages.getLatestContextSummary, {
      projectId,
      conversationId,
    });
    expect(latest?.summary).toBe("new");
  });

  test("insert + getConversationHistoryForCompaction returns only conversation messages", async () => {
    const t = convexTest(schema, modules);
    const { projectId, conversationId } = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", {
        name: "P",
        workspacePath: "/tmp/p",
      });
      const conversationId = await ctx.db.insert("conversations", {
        projectId,
        status: "active",
        createdAt: 1,
      });
      await ctx.db.insert("messages", {
        projectId,
        conversationId,
        authorType: "user",
        content: "hello",
      });
      await ctx.db.insert("messages", {
        projectId,
        authorType: "user",
        content: "no conversation",
      });
      return { projectId, conversationId };
    });

    const history = await t.query(internal.messages.getConversationHistoryForCompaction, {
      projectId,
      conversationId,
    });
    expect(history).toHaveLength(1);
    expect(history[0]!.content).toBe("hello");
  });
});
