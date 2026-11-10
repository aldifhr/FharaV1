/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

/**
 * Plan 039 PC2: the personal chat API (QA scenarios 1, 3, 4, 5 at the API
 * level; the reply itself is covered by personalReply.test.ts).
 */

const modules = import.meta.glob("./**/*.ts");
const makeT = () => convexTest(schema, modules);
type T = ReturnType<typeof makeT>;

async function seed(t: T) {
  return t.run(async (ctx) => {
    const ctoId = await ctx.db.insert("agents", { name: "Ada", role: "CTO", status: "idle", isEnabled: true });
    const qaId = await ctx.db.insert("agents", { name: "Quinn", role: "QA", status: "idle", isEnabled: true });
    const offId = await ctx.db.insert("agents", { name: "Off", role: "Backend", status: "idle", isEnabled: false });
    const retiredId = await ctx.db.insert("agents", { name: "Old", role: "Designer", status: "idle", isEnabled: true, retiredAt: Date.now() });
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p", agentIds: [ctoId, qaId] });
    return { ctoId, qaId, offId, retiredId, projectId };
  });
}

describe("getOrCreatePersonal", () => {
  test("QA 1: CTO personal chat has no project and kind personal", async () => {
    const t = makeT();
    const ids = await seed(t);
    const id = await t.mutation(api.conversations.getOrCreatePersonal, { agentId: ids.ctoId });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row).toMatchObject({ kind: "personal", agentId: ids.ctoId, status: "active" });
    expect(row?.projectId).toBeUndefined();
    const parts = await t.query(api.conversations.getParticipants, { conversationId: id });
    expect(parts.map((p) => p.agentId)).toEqual([ids.ctoId]);
    const header = await t.query(api.conversations.get, { conversationId: id });
    expect(header).toMatchObject({ kind: "personal", project: null, projectAttachedAt: null });
    expect(header?.agent?.name).toBe("Ada");
  });

  test("QA 4: idempotent (refresh returns the same id), also when called twice at once", async () => {
    const t = makeT();
    const ids = await seed(t);
    const [a, b] = await Promise.all([
      t.mutation(api.conversations.getOrCreatePersonal, { agentId: ids.ctoId }),
      t.mutation(api.conversations.getOrCreatePersonal, { agentId: ids.ctoId }),
    ]);
    const c = await t.mutation(api.conversations.getOrCreatePersonal, { agentId: ids.ctoId });
    expect(a).toBe(b);
    expect(c).toBe(a);
    const rows = await t.run((ctx) => ctx.db.query("conversations").collect());
    expect(rows.filter((r) => r.kind === "personal")).toHaveLength(1);
  });

  test("disabled, retired and missing agents are refused", async () => {
    const t = makeT();
    const ids = await seed(t);
    await expect(t.mutation(api.conversations.getOrCreatePersonal, { agentId: ids.offId })).rejects.toThrow(/disabled/);
    await expect(t.mutation(api.conversations.getOrCreatePersonal, { agentId: ids.retiredId })).rejects.toThrow(/retired/);
    const gone = await t.run(async (ctx) => {
      const id = await ctx.db.insert("agents", { name: "Gone", role: "X", status: "idle" });
      await ctx.db.delete(id);
      return id;
    });
    await expect(t.mutation(api.conversations.getOrCreatePersonal, { agentId: gone })).rejects.toThrow(/not found/);
  });

  test("QA 5: one conversation per agent; switching keeps each history", async () => {
    const t = makeT();
    const ids = await seed(t);
    const cto = await t.mutation(api.conversations.getOrCreatePersonal, { agentId: ids.ctoId });
    const qa = await t.mutation(api.conversations.getOrCreatePersonal, { agentId: ids.qaId });
    expect(cto).not.toBe(qa);
    await t.mutation(api.messages.sendInConversation, { conversationId: cto, content: "cto one" });
    await t.mutation(api.messages.sendInConversation, { conversationId: qa, content: "qa one" });
    await t.mutation(api.messages.sendInConversation, { conversationId: cto, content: "cto two" });
    expect((await t.query(api.messages.listByConversation, { conversationId: cto })).map((m) => m.content)).toEqual(["cto one", "cto two"]);
    expect((await t.query(api.messages.listByConversation, { conversationId: qa })).map((m) => m.content)).toEqual(["qa one"]);
    // Back to the CTO: same conversation, same history.
    expect(await t.mutation(api.conversations.getOrCreatePersonal, { agentId: ids.ctoId })).toBe(cto);
  });

  test("startNewPersonal closes the active one and opens a fresh one", async () => {
    const t = makeT();
    const ids = await seed(t);
    const first = await t.mutation(api.conversations.getOrCreatePersonal, { agentId: ids.ctoId });
    const second = await t.mutation(api.conversations.startNewPersonal, { agentId: ids.ctoId });
    expect(second).not.toBe(first);
    expect((await t.run((ctx) => ctx.db.get(first)))?.status).toBe("closed");
    expect(await t.mutation(api.conversations.getOrCreatePersonal, { agentId: ids.ctoId })).toBe(second);
    await expect(t.mutation(api.messages.sendInConversation, { conversationId: first, content: "late" })).rejects.toThrow(/closed/);
  });
});

describe("sendInConversation", () => {
  test("QA 2 (API): writes no projectId, schedules a reply, bumps lastMessageAt", async () => {
    const t = makeT();
    const ids = await seed(t);
    const id = await t.mutation(api.conversations.getOrCreatePersonal, { agentId: ids.ctoId });
    const res = await t.mutation(api.messages.sendInConversation, { conversationId: id, content: "  hi there  " });
    expect(res.deduped).toBe(false);
    const msg = await t.run((ctx) => ctx.db.get(res.messageId as Id<"messages">));
    expect(msg).toMatchObject({ content: "hi there", conversationId: id, replyStatus: "pending", authorType: "user" });
    expect(msg?.projectId).toBeUndefined();
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const reply = scheduled.find((s) => s.name.includes("replyToChat"));
    expect(reply?.args[0]).toEqual({ conversationId: id, userMessageId: res.messageId });
    expect((await t.run((ctx) => ctx.db.get(id)))?.lastMessageAt).toBeGreaterThan(0);
    // Never shows up in a project timeline.
    expect(await t.query(api.messages.listByProject, { projectId: ids.projectId })).toHaveLength(0);
  });

  test("clientId dedupe works without a project", async () => {
    const t = makeT();
    const ids = await seed(t);
    const id = await t.mutation(api.conversations.getOrCreatePersonal, { agentId: ids.ctoId });
    const a = await t.mutation(api.messages.sendInConversation, { conversationId: id, content: "once", clientId: "c-1" });
    const b = await t.mutation(api.messages.sendInConversation, { conversationId: id, content: "once", clientId: "c-1" });
    expect(b).toEqual({ ...a, deduped: true });
    expect(await t.query(api.messages.listByConversation, { conversationId: id })).toHaveLength(1);
    // The same clientId in another conversation is a different message.
    const qa = await t.mutation(api.conversations.getOrCreatePersonal, { agentId: ids.qaId });
    const c = await t.mutation(api.messages.sendInConversation, { conversationId: qa, content: "once", clientId: "c-1" });
    expect(c.deduped).toBe(false);
  });

  test("refuses project conversations, empty text and a quote from another chat", async () => {
    const t = makeT();
    const ids = await seed(t);
    const project = await t.mutation(api.messages.send, { projectId: ids.projectId, content: "project msg" });
    await expect(
      t.mutation(api.messages.sendInConversation, { conversationId: project.conversationId as Id<"conversations">, content: "x" })
    ).rejects.toThrow(/project chat/);
    const id = await t.mutation(api.conversations.getOrCreatePersonal, { agentId: ids.ctoId });
    await expect(t.mutation(api.messages.sendInConversation, { conversationId: id, content: "   " })).rejects.toThrow(/required/);
    await expect(
      t.mutation(api.messages.sendInConversation, { conversationId: id, content: "re", quotedMessageId: project.messageId as Id<"messages"> })
    ).rejects.toThrow(/Quoted message not found/);
    const own = await t.mutation(api.messages.sendInConversation, { conversationId: id, content: "mine" });
    await expect(
      t.mutation(api.messages.sendInConversation, { conversationId: id, content: "re", quotedMessageId: own.messageId as Id<"messages"> })
    ).resolves.toMatchObject({ deduped: false });
  });
});

describe("removePersonal", () => {
  test("deletes the conversation, its messages and participants; get-or-create returns a fresh chat", async () => {
    const t = makeT();
    const ids = await seed(t);
    const id = await t.mutation(api.conversations.getOrCreatePersonal, { agentId: ids.ctoId });
    await t.mutation(api.messages.sendInConversation, { conversationId: id, content: "hello" });
    expect(await t.query(api.conversations.get, { conversationId: id })).not.toBeNull();
    const res = await t.mutation(api.conversations.removePersonal, { conversationId: id });
    expect(res).toEqual({ deleted: true });
    expect(await t.query(api.conversations.get, { conversationId: id })).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("messages").collect())).toHaveLength(0);
    expect((await t.run((ctx) => ctx.db.query("conversationParticipants").collect())).filter((r) => r.conversationId === id)).toHaveLength(0);
    const fresh = await t.mutation(api.conversations.getOrCreatePersonal, { agentId: ids.ctoId });
    expect(fresh).not.toBe(id);
  });

  test("is idempotent and refuses project conversations", async () => {
    const t = makeT();
    const ids = await seed(t);
    const gone = await t.run(async (ctx) => {
      const row = await ctx.db.insert("conversations", { kind: "personal", agentId: ids.ctoId, status: "active", createdAt: Date.now() });
      await ctx.db.delete(row);
      return row;
    });
    await expect(t.mutation(api.conversations.removePersonal, { conversationId: gone })).resolves.toEqual({ deleted: false });
    const project = await t.mutation(api.messages.send, { projectId: ids.projectId, content: "project msg" });
    await expect(
      t.mutation(api.conversations.removePersonal, { conversationId: project.conversationId as Id<"conversations"> })
    ).rejects.toThrow(/personal chat/);
  });
});

describe("listPersonal", () => {
  test("lists enabled agents with their active chat, recent first", async () => {
    const t = makeT();
    const ids = await seed(t);
    const qa = await t.mutation(api.conversations.getOrCreatePersonal, { agentId: ids.qaId });
    await t.mutation(api.messages.sendInConversation, { conversationId: qa, content: "status of the release?" });
    const rows = await t.query(api.conversations.listPersonal, {});
    expect(rows.map((r) => r.agent.name)).toEqual(["Quinn", "Ada"]);
    expect(rows[0]).toMatchObject({ conversationId: qa, preview: "status of the release?", projectName: null });
    expect(rows[1].conversationId).toBeNull();
  });
});

describe("message actions on personal messages", () => {
  test("Remember saves agent-scoped memory for that agent only (D7)", async () => {
    const t = makeT();
    const ids = await seed(t);
    const id = await t.mutation(api.conversations.getOrCreatePersonal, { agentId: ids.qaId });
    const sent = await t.mutation(api.messages.sendInConversation, { conversationId: id, content: "Always run the smoke suite first" });
    const res = await t.mutation(api.memories.rememberMessage, { messageId: sent.messageId as Id<"messages"> });
    const memory = await t.run((ctx) => ctx.db.get(res.memoryId));
    expect(memory).toMatchObject({ scope: "agent", agentId: ids.qaId, pinned: true });
    expect(memory?.projectId).toBeUndefined();
    const again = await t.mutation(api.memories.rememberMessage, { messageId: sent.messageId as Id<"messages"> });
    expect(again).toEqual({ memoryId: res.memoryId, created: false });
  });

  test("pin works, second opinion is refused (D8), retry reschedules by conversation", async () => {
    const t = makeT();
    const ids = await seed(t);
    const id = await t.mutation(api.conversations.getOrCreatePersonal, { agentId: ids.ctoId });
    const sent = await t.mutation(api.messages.sendInConversation, { conversationId: id, content: "q" });
    const messageId = sent.messageId as Id<"messages">;
    await t.mutation(api.messages.togglePin, { messageId, pinned: true });
    expect((await t.run((ctx) => ctx.db.get(messageId)))?.pinned).toBe(true);
    const replyId = await t.run((ctx) =>
      ctx.db.insert("messages", { conversationId: id, agentId: ids.ctoId, authorType: "agent", content: "answer", replyToMessageId: messageId })
    );
    await expect(t.mutation(api.reviewer.requestMessageOpinion, { messageId: replyId })).rejects.toThrow(/personal chat/);
    await t.run((ctx) => ctx.db.patch(messageId, { replyStatus: "failed" }));
    const retried = await t.mutation(api.chatReplies.retryReply, { messageId });
    expect(retried.retried).toBe(true);
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const last = scheduled.filter((s) => s.name.includes("replyToChat")).pop();
    expect(last?.args[0]).toEqual({ conversationId: id, userMessageId: messageId });
  });
});
