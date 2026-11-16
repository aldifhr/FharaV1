/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { CHAT_LLM_PAYLOAD_MAX_CHARS, fitChatLlmPayload } from "./repoTools";

const modules = import.meta.glob("./**/*.ts");

describe("fitChatLlmPayload: the row payload stays valid JSON under the cap", () => {
  test("a small payload passes through verbatim", () => {
    const payload = fitChatLlmPayload("m1", "sys", [{ role: "user", content: "hi" }]);
    expect(payload.length).toBeLessThanOrEqual(CHAT_LLM_PAYLOAD_MAX_CHARS);
    const parsed = JSON.parse(payload) as { model: string; system: string; messages: unknown[] };
    expect(parsed).toMatchObject({ model: "m1", system: "sys" });
    expect(parsed.messages).toHaveLength(1);
  });

  test("an oversized payload is shrunk, never sliced mid-string", () => {
    const system = "s".repeat(60_000);
    const messages = [
      { role: "user", content: "old ".repeat(6_000) },
      { role: "assistant", content: "a".repeat(30_000) },
      { role: "user", content: "new ".repeat(6_000) },
    ];
    const payload = fitChatLlmPayload("m1", system, messages);
    expect(payload.length).toBeLessThanOrEqual(CHAT_LLM_PAYLOAD_MAX_CHARS);
    // Must parse, and keep the newest turn.
    const parsed = JSON.parse(payload) as { system: string; messages: Array<{ content: string }> };
    expect(parsed.system.length).toBeLessThanOrEqual(60_000);
    expect(parsed.messages[parsed.messages.length - 1].content).toContain("new");
  });

  test("a single huge turn is truncated to fit", () => {
    const payload = fitChatLlmPayload("m1", "sys", [{ role: "user", content: "x".repeat(500_000) }]);
    expect(payload.length).toBeLessThanOrEqual(CHAT_LLM_PAYLOAD_MAX_CHARS);
    const parsed = JSON.parse(payload) as { messages: Array<{ content: string }> };
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0].content.length).toBeGreaterThan(0);
    expect(parsed.messages[0].content.length).toBeLessThan(500_000);
  });
});

describe("repoToolCalls queue: the chat lease outlives one completion", () => {
  test("claimNext gives opencode_chat the long lease and other tools the short one", async () => {
    const t = convexTest(schema, modules);
    const projectId = await t.run(async (ctx) => {
      return await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
    });
    const chatCallId = await t.mutation(internal.repoTools.enqueueChatLlm, {
      projectId,
      model: "m",
      system: "s",
      messages: "[]",
    });
    const toolCallId = await t.run(async (ctx) => {
      return await ctx.db.insert("repoToolCalls", {
        projectId,
        tool: "list_files",
        args: "{}",
        status: "pending",
        createdAt: Date.now() + 1,
      });
    });
    const before = Date.now();
    await t.mutation(internal.repoTools.claimNext, { workerId: "w1" });
    // The chat row is the oldest pending one; claim it and check its lease.
    const chatRow = await t.run(async (ctx) => await ctx.db.get(chatCallId));
    expect(chatRow?.leaseExpiresAt).toBeGreaterThan(before + 150_000);
    await t.mutation(internal.repoTools.claimNext, { workerId: "w1" });
    const toolRow = await t.run(async (ctx) => await ctx.db.get(toolCallId));
    expect(toolRow?.leaseExpiresAt).toBeLessThanOrEqual(before + 30_000);
  });
});
