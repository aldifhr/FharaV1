/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { ROLE_KEYS } from "./lib/roles";

const modules = import.meta.glob("./**/*.ts");

async function seedTeam() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.agents.syncFixedTeamInternal, {});
  const agents = await t.run((ctx) => ctx.db.query("agents").collect());
  return { t, agents };
}

describe("agents.remove", () => {
  test("refuses every one of the nine fixed-team agents, with a clear message", async () => {
    const { t, agents } = await seedTeam();
    expect(agents).toHaveLength(ROLE_KEYS.length);
    for (const agent of agents) {
      await expect(t.mutation(api.agents.remove, { agentId: agent._id })).rejects.toThrow(/part of the fixed team and can't be deleted/);
    }
    expect(await t.run((ctx) => ctx.db.query("agents").collect())).toHaveLength(ROLE_KEYS.length);
  });

  test("an extra agent of a fixed role can be deleted, and takes its personal chats along", async () => {
    const { t } = await seedTeam();
    const extraId = await t.mutation(api.agents.create, { name: "Second backend", role: "backend" });
    const projectId = await t.run((ctx) => ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" }));
    const ids = await t.run(async (ctx) => {
      const personalId = await ctx.db.insert("conversations", { kind: "personal", agentId: extraId, status: "active", createdAt: 1 });
      await ctx.db.insert("conversationParticipants", { conversationId: personalId, agentId: extraId, joinedAt: 1 });
      await ctx.db.insert("messages", { conversationId: personalId, authorType: "user", content: "hi" });
      const closedId = await ctx.db.insert("conversations", { kind: "personal", agentId: extraId, status: "closed", createdAt: 0 });
      const projectChatId = await ctx.db.insert("conversations", { projectId, kind: "project", status: "active", createdAt: 1 });
      await ctx.db.insert("conversationParticipants", { conversationId: projectChatId, projectId, agentId: extraId, joinedAt: 1 });
      return { personalId, closedId, projectChatId };
    });

    await t.mutation(api.agents.remove, { agentId: extraId });

    await t.run(async (ctx) => {
      expect(await ctx.db.get(extraId)).toBeNull();
      expect(await ctx.db.get(ids.personalId)).toBeNull();
      expect(await ctx.db.get(ids.closedId)).toBeNull();
      expect(await ctx.db.query("messages").collect()).toHaveLength(0);
      // The project chat stays; the deleted agent's seat in it does not.
      expect(await ctx.db.get(ids.projectChatId)).not.toBeNull();
      expect(await ctx.db.query("conversationParticipants").collect()).toHaveLength(0);
    });
  });

  test("pruneOrphanPersonalChats removes chats whose agent is already gone", async () => {
    const { t, agents } = await seedTeam();
    const ids = await t.run(async (ctx) => {
      const goneId = await ctx.db.insert("agents", { name: "Gone", role: "qa", status: "idle", isEnabled: true });
      const orphanId = await ctx.db.insert("conversations", { kind: "personal", agentId: goneId, status: "active", createdAt: 1 });
      await ctx.db.insert("messages", { conversationId: orphanId, authorType: "user", content: "hi" });
      const liveId = await ctx.db.insert("conversations", { kind: "personal", agentId: agents[0]._id, status: "active", createdAt: 1 });
      await ctx.db.delete(goneId);
      return { orphanId, liveId };
    });
    expect(await t.mutation(internal.agents.pruneOrphanPersonalChats, {})).toEqual({ deleted: 1, more: false });
    await t.run(async (ctx) => {
      expect(await ctx.db.get(ids.orphanId)).toBeNull();
      expect(await ctx.db.get(ids.liveId)).not.toBeNull();
      expect(await ctx.db.query("messages").collect()).toHaveLength(0);
    });
  });
});
