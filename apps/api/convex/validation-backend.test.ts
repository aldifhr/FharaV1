/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("validation-backend: security invariants", () => {
  test("checkAlreadyReplied prevents duplicate reply (duplicate command guard)", async () => {
    const t = convexTest(schema, modules);
    const { projectId, conversationId, userMessageId } = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
      const conversationId = await ctx.db.insert("conversations", { projectId, status: "active", createdAt: 1 });
      const userMessageId = await ctx.db.insert("messages", { projectId, conversationId, authorType: "user", content: "hello", queueStatus: "pending" });
      return { projectId, conversationId, userMessageId };
    });
    const before = await t.query(internal.chatContext.checkAlreadyReplied, { userMessageId });
    expect(before).toBe(false);
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", { projectId, conversationId, authorType: "agent", content: "reply", replyToMessageId: userMessageId });
    });
    const after = await t.query(internal.chatContext.checkAlreadyReplied, { userMessageId });
    expect(after).toBe(true);
  });

  test("search.global / inbox.list must not leak plaintext keys", async () => {
    // We assert the *shape* contract: after fix, raw agents must be projected.
    // This test documents the intended invariant; it will fail until the fix lands.
    const t = convexTest(schema, modules);
    const { projectId } = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
      await ctx.db.insert("agents", { name: "A", role: "x", status: "idle", llmApiKey: "sk-plaintext-leak" });
      return { projectId };
    });
    const search = await t.query(api.search.global, { q: "" });
    const serialized = JSON.stringify(search);
    expect(serialized).not.toContain("sk-plaintext-leak");
    const inbox = await t.query(api.inbox.list, {});
    expect(JSON.stringify(inbox)).not.toContain("sk-plaintext-leak");
  });

  test("integrations.get must not leak refreshToken / webhookSecret / config", async () => {
    const t = convexTest(schema, modules);
    const { projectId, integrationId } = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
      const integrationId = await ctx.db.insert("integrations", {
        projectId, type: "github", name: "GH", status: "active",
        createdAt: Date.now(),
        accessToken: "ghp_1234567890", refreshToken: "refresh-123", webhookSecret: "whsec-123", config: "enc-config",
      });
      return { projectId, integrationId };
    });
    const got = await t.query(api.integrations.get, { integrationId });
    const serialized = JSON.stringify(got);
    expect(serialized).not.toContain("refresh-123");
    expect(serialized).not.toContain("whsec-123");
    expect(serialized).not.toContain("enc-config");
  });
});
