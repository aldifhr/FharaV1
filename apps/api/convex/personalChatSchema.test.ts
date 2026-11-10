/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  chatScopeOf,
  conversationKind,
  conversationShapeError,
  messageProjectIdFor,
  personalNoTaskReply,
} from "./lib/conversationShape";
import type { Id } from "./_generated/dataModel";

/**
 * Plan 039 PC1: the additive schema, kind invariants, the backfill and
 * the must-fix guards (project lookups filter by kind, task conversation
 * ownership, cascade detach, "." project path).
 */

const modules = import.meta.glob("./**/*.ts");
const makeT = () => convexTest(schema, modules);
type T = ReturnType<typeof makeT>;

async function seed(t: T) {
  return t.run(async (ctx) => {
    const now = Date.now();
    const ctoId = await ctx.db.insert("agents", { name: "Ada", role: "CTO", status: "idle", isEnabled: true });
    const qaId = await ctx.db.insert("agents", { name: "Quinn", role: "QA", status: "idle", isEnabled: true });
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p", agentIds: [ctoId, qaId] });
    const otherProjectId = await ctx.db.insert("projects", { name: "Q", workspacePath: "/tmp/q", agentIds: [ctoId] });
    // Legacy project conversation (no kind).
    const legacyId = await ctx.db.insert("conversations", { projectId, status: "active", createdAt: now - 10_000, lastMessageAt: now - 10_000 });
    await ctx.db.insert("conversationParticipants", { conversationId: legacyId, projectId, agentId: ctoId, joinedAt: now - 10_000 });
    // Personal conversation attached to P, with newer activity.
    const personalId = await ctx.db.insert("conversations", {
      kind: "personal",
      agentId: ctoId,
      projectId,
      projectAttachedAt: now,
      status: "active",
      createdAt: now - 5_000,
      lastMessageAt: now,
    });
    await ctx.db.insert("conversationParticipants", { conversationId: personalId, projectId, agentId: ctoId, joinedAt: now - 5_000 });
    const personalMsgId = await ctx.db.insert("messages", { conversationId: personalId, agentId: undefined, authorType: "user", content: "hello personal" });
    const otherConversationId = await ctx.db.insert("conversations", { projectId: otherProjectId, kind: "project", status: "active", createdAt: now });
    return { ctoId, qaId, projectId, otherProjectId, legacyId, personalId, personalMsgId, otherConversationId };
  });
}

describe("conversationShape (pure)", () => {
  test("legacy rows read as project; personal needs an agent; project needs a project", () => {
    expect(conversationKind({})).toBe("project");
    expect(conversationKind(null)).toBe("project");
    expect(conversationKind({ kind: "personal" })).toBe("personal");
    expect(conversationShapeError({ kind: "personal" })).toMatch(/agent/);
    expect(conversationShapeError({ kind: "personal", agentId: "a" })).toBeNull();
    expect(conversationShapeError({})).toMatch(/project/);
    expect(conversationShapeError({ kind: "team" })).toMatch(/project/);
    expect(conversationShapeError({ kind: "project", projectId: "p", agentId: "a" })).toMatch(/single agent/);
    expect(conversationShapeError({ kind: "project", projectId: "p" })).toBeNull();
  });

  test("scope comes from the row; personal messages never carry a project (D1)", () => {
    expect(chatScopeOf({ kind: "personal", agentId: "a" as Id<"agents"> })).toEqual({ kind: "personal", agentId: "a", projectId: null });
    expect(chatScopeOf({ projectId: "p" as Id<"projects"> })).toEqual({ kind: "project", agentId: null, projectId: "p" });
    expect(messageProjectIdFor({ kind: "personal" }, "p" as Id<"projects">)).toBeUndefined();
    expect(messageProjectIdFor({}, "p" as Id<"projects">)).toBe("p");
    expect(personalNoTaskReply("tolong kerjakan ini")).toMatch(/chat pribadi/);
    expect(personalNoTaskReply("please build it")).toMatch(/personal chat with no project/);
  });
});

describe("backfillConversationKinds", () => {
  test("stamps project on legacy rows, keeps ids, is idempotent, verify passes", async () => {
    const t = makeT();
    const ids = await seed(t);
    const before = await t.run((ctx) => ctx.db.query("conversations").collect());
    const first = await t.mutation(internal.migrations.backfillConversationKinds, {});
    expect(first.done).toBe(true);
    expect(first.patched).toBe(1);
    const second = await t.mutation(internal.migrations.backfillConversationKinds, {});
    expect(second.patched).toBe(0);
    const after = await t.run((ctx) => ctx.db.query("conversations").collect());
    expect(after.map((r) => r._id).sort()).toEqual(before.map((r) => r._id).sort());
    expect((await t.run((ctx) => ctx.db.get(ids.legacyId)))?.kind).toBe("project");
    expect((await t.run((ctx) => ctx.db.get(ids.personalId)))?.kind).toBe("personal");
    const verify = await t.query(internal.migrations.verifyConversationKinds, {});
    expect(verify).toMatchObject({ withoutKind: 0, personal: 1, personalMessagesWithProject: 0, ok: true });
  });

  test("verify flags a personal message that carries a projectId", async () => {
    const t = makeT();
    const ids = await seed(t);
    await t.run((ctx) => ctx.db.insert("messages", { projectId: ids.projectId, conversationId: ids.personalId, authorType: "user", content: "leak" }));
    const verify = await t.query(internal.migrations.verifyConversationKinds, {});
    expect(verify.personalMessagesWithProject).toBe(1);
    expect(verify.ok).toBe(false);
  });

  test("batches past one page", async () => {
    const t = makeT();
    const ids = await seed(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 205; i++) await ctx.db.insert("conversations", { projectId: ids.projectId, status: "closed", createdAt: i });
    });
    const first = await t.mutation(internal.migrations.backfillConversationKinds, {});
    expect(first.done).toBe(false);
    let cursor = first.cursor;
    let patched = first.patched;
    while (cursor) {
      const next = await t.mutation(internal.migrations.backfillConversationKinds, { cursor, patched, scanned: 0 });
      cursor = next.cursor;
      patched = next.patched;
    }
    expect(patched).toBe(206);
    expect((await t.query(internal.migrations.verifyConversationKinds, {})).withoutKind).toBe(0);
  });
});

describe("project chat ignores personal conversations (QA 11)", () => {
  test("getActive / send / listByProject / clearChat never use an attached personal chat", async () => {
    const t = makeT();
    const ids = await seed(t);
    const active = await t.query(api.conversations.getActive, { projectId: ids.projectId });
    expect(active?.conversation._id).toBe(ids.legacyId);
    const sent = await t.mutation(api.messages.send, { projectId: ids.projectId, content: "project hello" });
    expect(sent.conversationId).toBe(ids.legacyId);
    const list = await t.query(api.conversations.listByProject, { projectId: ids.projectId });
    expect(list.map((c) => c._id)).not.toContain(ids.personalId);
    const timeline = await t.query(api.messages.listByProject, { projectId: ids.projectId });
    expect(timeline.map((m) => m.content)).not.toContain("hello personal");
    await t.mutation(api.conversations.clearChat, { projectId: ids.projectId });
    const personal = await t.run((ctx) => ctx.db.get(ids.personalId));
    expect(personal?.status).toBe("active");
    expect(await t.run((ctx) => ctx.db.get(ids.personalMsgId))).not.toBeNull();
  });

  test("messages.send refuses a personal conversation id", async () => {
    const t = makeT();
    const ids = await seed(t);
    await expect(
      t.mutation(api.messages.send, { projectId: ids.projectId, conversationId: ids.personalId, content: "x" })
    ).rejects.toThrow(/personal chat/);
  });

  test("participant edits refuse a personal conversation", async () => {
    const t = makeT();
    const ids = await seed(t);
    await expect(
      t.mutation(api.conversations.addParticipant, { conversationId: ids.personalId, agentId: ids.qaId })
    ).rejects.toThrow(/exactly one agent/);
  });
});

describe("tasks.createFromCommand conversation ownership", () => {
  test("refuses a conversation of another project", async () => {
    const t = makeT();
    const ids = await seed(t);
    await expect(
      t.mutation(api.tasks.createFromCommand, { projectId: ids.projectId, command: "fix it", conversationId: ids.otherConversationId })
    ).rejects.toThrow(/does not belong/);
  });

  test("refuses an unattached personal conversation, accepts one attached to the project", async () => {
    const t = makeT();
    const ids = await seed(t);
    const loose = await t.run((ctx) =>
      ctx.db.insert("conversations", { kind: "personal", agentId: ids.qaId, status: "active", createdAt: Date.now() })
    );
    await expect(
      t.mutation(api.tasks.createFromCommand, { projectId: ids.projectId, command: "fix it", conversationId: loose })
    ).rejects.toThrow(/does not belong/);
    const taskId = await t.mutation(api.tasks.createFromCommand, { projectId: ids.projectId, command: "fix it", conversationId: ids.personalId });
    const task = await t.run((ctx) => ctx.db.get(taskId as Id<"tasks">));
    expect(task?.conversationId).toBe(ids.personalId);
  });
});

describe("project delete cascade", () => {
  test("detaches an attached personal chat and keeps its messages", async () => {
    const t = makeT();
    const ids = await seed(t);
    await t.run((ctx) => ctx.db.delete(ids.projectId));
    let step = 0;
    let deleted = 0;
    for (let i = 0; i < 50; i++) {
      const res = await t.mutation(internal.projects.cascadeDelete, { projectId: ids.projectId, step, deleted });
      step = res.step;
      deleted = res.deleted;
      if (res.done) break;
    }
    const personal = await t.run((ctx) => ctx.db.get(ids.personalId));
    expect(personal).not.toBeNull();
    expect(personal?.projectId).toBeUndefined();
    expect(personal?.projectAttachedAt).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.get(ids.personalMsgId))).not.toBeNull();
    const parts = await t.run((ctx) =>
      ctx.db.query("conversationParticipants").withIndex("by_conversation", (q) => q.eq("conversationId", ids.personalId)).collect()
    );
    expect(parts).toHaveLength(1);
    expect(parts[0].projectId).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.get(ids.legacyId))).toBeNull();
  });
});

describe("project path", () => {
  test("'.' and './' are refused", async () => {
    const t = makeT();
    for (const workspacePath of [".", "./", ".\\"]) {
      await expect(t.mutation(api.projects.create, { name: "Root", workspacePath })).rejects.toThrow(/not '\.'/);
    }
    await expect(t.mutation(api.projects.create, { name: "Ok", workspacePath: "./repo" })).resolves.toBeTruthy();
  });
});
