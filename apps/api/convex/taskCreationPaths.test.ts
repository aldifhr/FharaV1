/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

/**
 * P1a: every way a task is created gets the same pool and keeps chat's
 * routing hint. Before, the Create task button and "gas" ran with a one-agent
 * pool (the offer's assignee), so review and QA nodes were dropped as
 * unroutable, "/task" fell back to Backend, and "kerjakan itu" dropped the
 * offer's assignee. The team here has a Reviewer: the pool must be
 * CTO + owner + Reviewer + QA, and tasks.routingHint must be stored.
 */

type Call = { system: string; msgs: { role: string; content: string }[] };
const calls: Call[] = [];
let reply: (call: Call) => string = () => "ok";

const queued = vi.hoisted(() => ({ count: 0 }));

vi.mock("./lib/chat/llm", () => ({
  getGlobalLLMConfig: () => ({ baseUrl: "http://llm.test", apiKey: "k", model: "m", provider: "openai-compatible" }),
  resolveConfigFromProviders: async (_p: unknown, global: unknown) => global,
  completeWithAgent: async (
    system: string,
    msgs: { role: string; content: string }[],
    _config: unknown,
    onChunk?: (c: { content: string; reasoning: string }) => void
  ) => {
    const call = { system, msgs: msgs.map((m) => ({ ...m })) };
    calls.push(call);
    const content = reply(call);
    onChunk?.({ content, reasoning: "" });
    return { content, reasoning: "", reasoningDurationMs: 0 };
  },
}));
const llmIntent = vi.hoisted(() => ({ intent: "ask", subtype: "research" }));
vi.mock("./lib/chat/classify", () => ({
  classifyIntent: async () => ({
    intent: llmIntent.intent,
    subtype: llmIntent.subtype,
    requiresWorkspace: false,
    requiresExecution: false,
    confidence: 1,
    reasoning: "test",
  }),
}));
vi.mock("./lib/chat/repoSnapshot", () => ({ readRepoSnapshot: async () => "" }));
// A stand-in worker: every queued repo tool call is answered at once.
vi.mock("./repoTools", async (importOriginal) => {
  const original = await importOriginal<typeof import("./repoTools")>();
  const { internalQuery, internalMutation } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...original,
    enqueue: internalMutation({
      args: { projectId: v.id("projects"), tool: v.string(), args: v.string() },
      handler: async (ctx, args) => {
        queued.count += 1;
        return await ctx.db.insert("repoToolCalls", { ...args, status: "pending", createdAt: Date.now() } as any);
      },
    }),
    get: internalQuery({
      args: { callId: v.id("repoToolCalls") },
      handler: async (ctx, args) => {
        const row = await ctx.db.get(args.callId);
        if (!row) return null;
        const file = "apps/api/convex/schema.ts";
        return row.tool === "read_file"
          ? { status: "done", result: `${file}: 100 bytes, 3 lines\n1: export default defineSchema({`, files: [file] }
          : { status: "done", result: `1 match\n${file}:1: export default defineSchema({`, files: [] };
      },
    }),
  };
});

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const mk = (name: string, role: string) => ctx.db.insert("agents", { name, role, status: "idle", isEnabled: true });
    const ctoId = await mk("CTO", "cto");
    const backendId = await mk("Backend", "backend");
    const frontendId = await mk("Frontend", "frontend");
    const reviewerId = await mk("Reviewer", "reviewer");
    const qaId = await mk("QA", "qa");
    const projectId = await ctx.db.insert("projects", {
      name: "P",
      workspacePath: "/repo",
      agentIds: [ctoId, backendId, frontendId, reviewerId, qaId],
    });
    const now = Date.now();
    const personalId = await ctx.db.insert("conversations", {
      kind: "personal",
      agentId: ctoId,
      projectId,
      projectAttachedAt: now,
      status: "active",
      createdAt: now,
      lastMessageAt: now,
    });
    return { ctoId, backendId, frontendId, reviewerId, qaId, projectId, personalId };
  });
  return { t, ...ids };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function ask(s: Setup, content: string, preferredAgentIds?: any[]) {
  const { messageId } = await s.t.mutation(api.messages.send, { projectId: s.projectId, content, ...(preferredAgentIds ? { preferredAgentIds } : {}) });
  await s.t.finishAllScheduledFunctions(vi.runAllTimers);
  return await s.t.run(async (ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_reply_to", (q) => q.eq("replyToMessageId", messageId as any))
      .collect()
  );
}

const tasksOf = (s: Setup) => s.t.run(async (ctx) => ctx.db.query("tasks").collect());

/** The one task created, with its pool checked: CTO + Frontend (owner) + Reviewer + QA, and no Backend fallback. */
async function onlyTask(s: Setup) {
  const tasks = await tasksOf(s);
  expect(tasks).toHaveLength(1);
  const pool = (tasks[0].assignedAgentIds ?? []).map(String);
  expect([...pool].sort()).toEqual([s.ctoId, s.frontendId, s.reviewerId, s.qaId].map(String).sort());
  expect(pool).not.toContain(String(s.backendId));
  expect(tasks[0].routingHint).toBeDefined();
  return tasks[0];
}

const FILE_REQUEST = "buatkan file ultimate.html dengan teks 'Ultimate is a new vision' dengan background yang menarik";

/** An un-mentioned file request: Frontend answers with a Create task offer. */
async function offer(s: Setup) {
  reply = () => "Siap, ini dikerjakan lewat task — balas gas atau tekan Create task.";
  const replies = (await ask(s, FILE_REQUEST)).filter((r) => r.voice !== "system");
  expect(replies[0].taskOffer).toMatchObject({ assigneeAgentId: String(s.frontendId), hint: { source: "offer", role: "frontend" } });
  expect(await tasksOf(s)).toHaveLength(0);
  return replies[0];
}

beforeEach(() => {
  llmIntent.intent = "ask";
  llmIntent.subtype = "research";
  calls.length = 0;
  queued.count = 0;
  reply = () => "ok";
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("every task creation path: CTO + owner + Reviewer + QA, hint stored", () => {
  test("Create task button (web ChatPanel): the offer's assignee and hint come from the offer message", async () => {
    const s = await setup();
    const message = await offer(s);
    // What ChatPanel sends when the reply @mentions nobody: no assignees, the offer message id.
    const taskId = await s.t.mutation(api.tasks.createFromCommand, {
      projectId: s.projectId,
      command: message.taskOffer!.brief!,
      title: "ultimate.html",
      conversationContext: false,
      offerMessageId: message._id,
    });
    const task = await onlyTask(s);
    expect(task._id).toBe(taskId);
    expect(task.routingHint).toMatchObject({ source: "offer", role: "frontend", kind: "implementation", files: ["ultimate.html"] });
    const used = await s.t.run(async (ctx) => ctx.db.get(message._id));
    expect(used?.taskOffer?.usedTaskId).toBe(taskId);
  });

  test("'gas' after the offer", async () => {
    const s = await setup();
    await offer(s);
    await ask(s, "gas");
    const task = await onlyTask(s);
    expect(task.command).toContain("ultimate.html");
    expect(task.routingHint).toMatchObject({ source: "offer", role: "frontend", files: ["ultimate.html"] });
  });

  test("'/task …' in the project chat: routed like chat, no Backend fallback", async () => {
    const s = await setup();
    await ask(s, "/task buatkan halaman landing.html dengan tombol biru");
    const task = await onlyTask(s);
    expect(task.command).toBe("buatkan halaman landing.html dengan tombol biru");
    expect(task.routingHint).toMatchObject({ source: "command", role: "frontend", files: ["landing.html"] });
    expect(task.routingHint?.hard).toBeUndefined();
  });

  test("'kerjakan …' in the project chat", async () => {
    const s = await setup();
    await ask(s, "kerjakan halaman landing.html dengan tombol biru");
    const task = await onlyTask(s);
    expect(task.command).toContain("landing.html");
    expect(task.routingHint).toMatchObject({ source: "command", role: "frontend" });
  });

  test("'/task @Frontend …' with a mention: the hint is hard", async () => {
    const s = await setup();
    await ask(s, "/task @Frontend rapikan landing.html", [s.frontendId]);
    const task = await onlyTask(s);
    expect(task.routingHint).toMatchObject({ source: "mention", role: "frontend", hard: true });
  });

  test("'kerjakan itu' after the offer keeps the offer's assignee and hint", async () => {
    const s = await setup();
    await offer(s);
    await ask(s, "kerjakan itu");
    const task = await onlyTask(s);
    expect(task.command).toContain("ultimate.html");
    expect(task.routingHint).toMatchObject({ source: "offer", role: "frontend", files: ["ultimate.html"] });
  });

  test("web /task (personal chat attached to the project): routed on the server", async () => {
    const s = await setup();
    // What PersonalChatPanel.runSlash sends: the text after "/task" and the conversation.
    await s.t.mutation(api.tasks.createFromCommand, {
      projectId: s.projectId,
      command: "buatkan halaman landing.html dengan tombol biru",
      conversationId: s.personalId,
    });
    const task = await onlyTask(s);
    expect(task.conversationId).toBe(s.personalId);
    expect(task.routingHint).toMatchObject({ source: "command", role: "frontend", files: ["landing.html"] });
  });

  test("TaskBoard (no conversation): routed on the server", async () => {
    const s = await setup();
    await s.t.mutation(api.tasks.createFromCommand, { projectId: s.projectId, command: "buatkan halaman landing.html dengan tombol biru" });
    const task = await onlyTask(s);
    expect(task.conversationId).toBeUndefined();
    expect(task.routingHint).toMatchObject({ source: "command", role: "frontend" });
  });

  test("a command nobody owns is never given a Backend default", async () => {
    const s = await setup();
    await s.t.mutation(api.tasks.createFromCommand, { projectId: s.projectId, command: "halo semuanya" });
    const tasks = await tasksOf(s);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assignedAgentIds ?? []).not.toEqual([s.backendId]);
  });
});
