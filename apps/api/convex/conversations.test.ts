/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

/**
 * Plan 007 (addendum §1-2): the persisted participation model and the
 * registry read models. Invariants protected here:
 *
 *  (a) participation is independent of membership and assignment, persisted,
 *      and idempotent to sync;
 *  (b) the membership + enabled gate the chat engine applied per-request
 *      before this table existed still holds (mirrored by
 *      packages/worker/tests/chatAndTasks.test.ts);
 *  (c) the default selection (preferred -> lead -> first enabled) is
 *      preserved as seeding and as the no-conversation fallback;
 *  (d) registry read models never leak credential fields.
 */

const modules = import.meta.glob("./**/*.ts");

function makeT() {
  return convexTest(schema, modules);
}
type T = ReturnType<typeof makeT>;

async function setup() {
  const t = makeT();
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", {
      name: "P",
      workspacePath: "/tmp/p",
    });
    const leadId = await ctx.db.insert("agents", {
      name: "Lead",
      role: "Software Architect",
      status: "idle",
      isEnabled: true,
    });
    const feId = await ctx.db.insert("agents", {
      name: "Frontend",
      role: "Frontend Engineer",
      status: "idle",
      isEnabled: true,
    });
    const disabledId = await ctx.db.insert("agents", {
      name: "Disabled",
      role: "Backend Engineer",
      status: "idle",
      isEnabled: false,
    });
    const outsiderId = await ctx.db.insert("agents", {
      name: "Outsider",
      role: "Designer",
      status: "idle",
      isEnabled: true,
    });
    return { projectId, leadId, feId, disabledId, outsiderId };
  });
  await t.mutation(api.projects.updateTeam, {
    projectId: ids.projectId,
    agentIds: [ids.leadId, ids.feId, ids.disabledId],
  });
  return { t, ...ids };
}

function participantRows(t: T, conversationId: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query("conversationParticipants")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId as any))
      .collect()
  );
}

describe("ensureForChat: resolve-or-create + seed", () => {
  test("creates the active conversation with no default participant (O3: To: Team)", async () => {
    const { t, projectId } = await setup();

    const conversationId = await t.mutation(internal.conversations.ensureForChat, {
      projectId,
    });

    const participants = await t.query(api.conversations.getParticipants, {
      conversationId,
    });
    // No CTO default: a message nobody was @mentioned in is routed by System.
    expect(participants).toHaveLength(0);

    const active = await t.query(api.conversations.getActive, { projectId });
    expect(active?.conversation._id).toBe(conversationId);
    expect(active?.participants).toHaveLength(0);
  });

  test("no CTO default and no migration to the CTO; chat context falls back to a non-CTO agent", async () => {
    const t = makeT();
    const ids = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
      const cto = await ctx.db.insert("agents", { name: "CTO", role: "cto", status: "idle", isEnabled: true });
      const general = await ctx.db.insert("agents", { name: "General", role: "assistant", status: "idle", isEnabled: true });
      const fe = await ctx.db.insert("agents", { name: "Frontend", role: "frontend developer", status: "idle", isEnabled: true });
      return { projectId, cto, general, fe };
    });
    await t.mutation(api.projects.updateTeam, { projectId: ids.projectId, agentIds: [ids.cto, ids.general, ids.fe] });
    const conversationId = await t.mutation(internal.conversations.ensureForChat, { projectId: ids.projectId });
    expect(await t.query(api.conversations.getParticipants, { conversationId })).toHaveLength(0);
    const context = await t.query(internal.chatContext.getContext, { projectId: ids.projectId, conversationId });
    expect(context.agents.map((a: { _id: string }) => a._id)).toEqual([ids.general]);
  });

  test("is idempotent: a second send neither duplicates rows nor conversations", async () => {
    const { t, projectId, leadId } = await setup();

    const first = await t.mutation(internal.conversations.ensureForChat, { projectId });
    const second = await t.mutation(internal.conversations.ensureForChat, { projectId });
    expect(second).toBe(first);

    expect(await participantRows(t, first)).toHaveLength(0);
    const conversations = await t.run(async (ctx) =>
      ctx.db.query("conversations").collect()
    );
    expect(conversations).toHaveLength(1);
    expect(leadId).toBeDefined();
  });

  test("an explicit selection replaces the participant set and soft-leaves the rest", async () => {
    const { t, projectId, leadId, feId } = await setup();

    // Seed the lead first (explicit), then re-select: the replace path must
    // soft-leave the previous participant.
    const conversationId = await t.mutation(internal.conversations.ensureForChat, {
      projectId,
      preferredAgentIds: [leadId],
    });
    await t.mutation(internal.conversations.ensureForChat, {
      projectId,
      preferredAgentIds: [feId],
    });

    const participants = await t.query(api.conversations.getParticipants, {
      conversationId,
    });
    expect(participants.map((p) => p.agentId)).toEqual([feId]);

    const rows = await participantRows(t, conversationId);
    expect(rows).toHaveLength(2); // history kept, not deleted
    const leftLead = rows.find((r) => r.agentId === leadId);
    expect(typeof leftLead?.leftAt).toBe("number");

    // The chat engine resolves the persisted participants.
    const context = await t.query(internal.chatContext.getContext, {
      projectId,
      conversationId,
    });
    expect(context.agents.map((a) => a._id)).toEqual([feId]);
  });

  test("refuses a conversationId belonging to another project", async () => {
    const { t, projectId } = await setup();
    const otherProjectId = await t.run(async (ctx) =>
      ctx.db.insert("projects", { name: "Other", workspacePath: "/tmp/o" })
    );
    const conversationId = await t.mutation(internal.conversations.ensureForChat, {
      projectId,
    });

    await expect(
      t.mutation(internal.conversations.ensureForChat, {
        projectId: otherProjectId,
        conversationId,
      })
    ).rejects.toThrow(/does not belong/);
  });
});

describe("participation gate: membership + enabled", () => {
  test("addParticipant refuses non-members and disabled agents", async () => {
    const { t, projectId, outsiderId, disabledId } = await setup();
    const conversationId = await t.mutation(internal.conversations.ensureForChat, {
      projectId,
    });

    await expect(
      t.mutation(api.conversations.addParticipant, {
        conversationId,
        agentId: outsiderId,
      })
    ).rejects.toThrow(/not a member/);
    await expect(
      t.mutation(api.conversations.addParticipant, {
        conversationId,
        agentId: disabledId,
      })
    ).rejects.toThrow(/disabled/);
  });

  test("removeParticipant soft-leaves; addParticipant rejoins the same row", async () => {
    const { t, projectId, leadId, feId } = await setup();
    const conversationId = await t.mutation(internal.conversations.ensureForChat, {
      projectId,
      preferredAgentIds: [feId],
    });

    await t.mutation(api.conversations.removeParticipant, {
      conversationId,
      agentId: feId,
    });
    expect(
      await t.query(api.conversations.getParticipants, { conversationId })
    ).toHaveLength(0);

    await t.mutation(api.conversations.addParticipant, {
      conversationId,
      agentId: leadId,
    });
    const participants = await t.query(api.conversations.getParticipants, {
      conversationId,
    });
    expect(participants.map((p) => p.agentId)).toEqual([leadId]);

    const rows = await participantRows(t, conversationId);
    expect(rows.filter((r) => r.agentId === leadId)).toHaveLength(1);
    expect(rows.find((r) => r.agentId === leadId)?.leftAt).toBeUndefined();
  });

  test("an empty team seeds nobody and the chat engine selects nobody", async () => {
    const t = makeT();
    const projectId = await t.run(async (ctx) =>
      ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" })
    );
    await t.run(async (ctx) =>
      ctx.db.insert("agents", {
        name: "Solo",
        role: "Engineer",
        status: "idle",
      })
    );

    const conversationId = await t.mutation(internal.conversations.ensureForChat, {
      projectId,
    });
    expect(
      await t.query(api.conversations.getParticipants, { conversationId })
    ).toHaveLength(0);

    const withConversation = await t.query(internal.chatContext.getContext, {
      projectId,
      conversationId,
    });
    expect(withConversation.agents).toHaveLength(0);

    // Fallback path: a preferred global agent is still gated by membership.
    const fallback = await t.query(internal.chatContext.getContext, {
      projectId,
    });
    expect(fallback.agents).toHaveLength(0);
  });

  test("a participant disabled after joining stops being selected", async () => {
    const { t, projectId, leadId, feId } = await setup();
    const conversationId = await t.mutation(internal.conversations.ensureForChat, {
      projectId,
      preferredAgentIds: [leadId, feId],
    });

    await t.run(async (ctx) => ctx.db.patch(feId, { isEnabled: false }));

    const context = await t.query(internal.chatContext.getContext, {
      projectId,
      conversationId,
    });
    expect(context.agents.map((a) => a._id)).toEqual([leadId]);
  });
});

describe("getContext fallback preserves the historical selection", () => {
  test("no conversationId: preferred first, else the conversational agent", async () => {
    const { t, projectId, leadId, feId } = await setup();

    // Default is the conversational agent; explicit mentions override it.
    const byDefault = await t.query(internal.chatContext.getContext, { projectId });
    expect(byDefault.agents.map((a) => a._id)).toEqual([leadId]);

    const byPreferred = await t.query(internal.chatContext.getContext, {
      projectId,
      preferredAgentIds: [leadId],
    });
    expect(byPreferred.agents.map((a) => a._id)).toEqual([leadId]);
  });
});

describe("clearChat", () => {
  test("deletes unpinned messages but keeps pinned ones", async () => {
    const { t, projectId } = await setup();

    const unpinned = await t.run(async (ctx) =>
      ctx.db.insert("messages", { projectId, authorType: "user", content: "hello" })
    );
    const pinned = await t.run(async (ctx) =>
      ctx.db.insert("messages", { projectId, authorType: "agent", content: "pinned", pinned: true })
    );

    const result = await t.mutation(api.conversations.clearChat, { projectId });
    expect(result.deletedMessages).toBe(1);

    const remaining = await t.query(api.messages.listByProject, { projectId });
    expect(remaining.map((m) => m._id)).toEqual([pinned]);
    expect(await t.run(async (ctx) => ctx.db.get(unpinned))).toBeNull();
  });
});

describe("registry read models (addendum §1)", () => {
  test("listByProject returns members without credential fields", async () => {
    const { t, projectId, leadId, feId, disabledId } = await setup();

    const members = await t.query(api.agents.listByProject, { projectId });
    expect(members.map((m) => m._id)).toEqual([leadId, feId, disabledId]);
    for (const member of members) {
      expect("llmApiKey" in member).toBe(false);
      expect("llmApiKeyEnv" in member).toBe(false);
      expect(member.llmApiKeyConfigured).toBe(false);
    }
  });

  test("getRegistryView joins availability, assignments, and participation", async () => {
    const { t, projectId, leadId, feId } = await setup();
    const conversationId = await t.mutation(internal.conversations.ensureForChat, {
      projectId,
      preferredAgentIds: [feId],
    });

    const taskId = await t.run(async (ctx) =>
      ctx.db.insert("tasks", {
        projectId,
        title: "T",
        command: "do it",
        status: "queued",
        assignedAgentIds: [feId],
      })
    );
    const subtaskId = await t.run(async (ctx) =>
      ctx.db.insert("subtasks", {
        taskId,
        projectId,
        key: "s1",
        title: "S",
        description: "d",
        kind: "code_change",
        capability: "code",
        dependencies: [],
        order: 0,
        status: "running",
        assignedAgentId: feId,
        assignedAgentName: "Frontend",
        attempts: 0,
      })
    );
    await t.run(async (ctx) =>
      ctx.db.insert("executions", {
        taskId,
        projectId,
        subtaskId,
        subtaskKey: "s1",
        agentId: feId,
        agentName: "Frontend",
        capability: "code",
        workerId: "w1",
        status: "running",
        attempt: 1,
        createdAt: 1,
      })
    );

    const view = await t.query(api.agents.getRegistryView, { projectId });
    const fe = view.find((a) => a._id === feId);
    expect(fe).toBeDefined();
    if (!fe) return;

    expect(fe.availability).toBe("idle"); // status is owned by the worker lifecycle
    expect(fe.openExecutions).toBe(1);
    expect(fe.assignedSubtasks.map((s) => s.key)).toEqual(["s1"]);
    expect(fe.assignedTasks.map((x) => x.taskId)).toEqual([taskId]);
    expect(fe.activeConversations.map((c) => c.conversationId)).toEqual([
      conversationId,
    ]);
    expect("llmApiKey" in fe).toBe(false);

    const lead = view.find((a) => a._id === leadId);
    expect(lead?.activeConversations).toHaveLength(0);
    expect(lead?.assignedTasks).toHaveLength(0);
  });

  test("a closed conversation no longer counts as participation", async () => {
    const { t, projectId, feId } = await setup();
    const conversationId = await t.mutation(internal.conversations.ensureForChat, {
      projectId,
      preferredAgentIds: [feId],
    });

    await t.mutation(api.conversations.closeConversation, { conversationId });

    const view = await t.query(api.agents.getRegistryView, { projectId });
    expect(view.find((a) => a._id === feId)?.activeConversations).toHaveLength(0);
    expect(await t.query(api.conversations.getActive, { projectId })).toBeNull();
  });
});

describe("a project with no agentIds runs with the fixed team", () => {
  test("ensureForChat seeds nobody and chat context still has agents (no 'No enabled agents')", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const cto = await ctx.db.insert("agents", { name: "CTO", role: "cto", status: "idle", isEnabled: true });
      const fe = await ctx.db.insert("agents", { name: "Frontend", role: "frontend", status: "idle", isEnabled: true });
      await ctx.db.insert("agents", { name: "Lead", role: "lead", status: "idle", isEnabled: false });
      const projectId = await ctx.db.insert("projects", { name: "API made", workspacePath: "/tmp/api-made" });
      return { cto, fe, projectId };
    });
    const conversationId = await t.mutation(internal.conversations.ensureForChat, { projectId: ids.projectId });
    const participants = await t.query(api.conversations.getParticipants, { conversationId });
    expect(participants).toHaveLength(0);
    const context = await t.query(internal.chatContext.getContext, { projectId: ids.projectId, conversationId });
    expect(context.agents.map((a: { _id: string }) => a._id)).toEqual([ids.fe]);
    expect((context.team ?? []).map((a: { _id: string }) => a._id).sort()).toEqual([ids.cto, ids.fe].sort());
    // Without a conversation (legacy path) the same default answers.
    const legacy = await t.query(internal.chatContext.getContext, { projectId: ids.projectId });
    expect(legacy.agents.map((a: { _id: string }) => a._id)).toEqual([ids.fe]);
  });
});
