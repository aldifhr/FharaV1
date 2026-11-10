/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { appendTaskEvent } from "./lib/taskEvents";
import { CLIENT_ID_MAX, normalizeClientId } from "./messages";

/**
 * Idempotency (t3code idea #2): a send carries a client message id and a
 * duplicate returns the same row without a second reply; task events can
 * carry a key so a re-emit writes nothing.
 */

const llm = { calls: 0 };

vi.mock("./lib/chat/llm", () => ({
  getGlobalLLMConfig: () => ({ baseUrl: "http://llm.test", apiKey: "k", model: "m" }),
  resolveConfigFromProviders: async (_p: unknown, global: unknown) => global,
  completeWithAgent: async () => {
    llm.calls += 1;
    return { content: "Oke.", reasoning: "", reasoningDurationMs: 0 };
  },
}));
vi.mock("./lib/chat/classify", () => ({
  classifyIntent: async () => ({
    intent: "ask",
    subtype: "explanation",
    requiresWorkspace: false,
    requiresExecution: false,
    confidence: 1,
    reasoning: "test",
  }),
  chooseAskResponder: async () => null,
}));
vi.mock("./lib/chat/repoSnapshot", () => ({ readRepoSnapshot: async () => "" }));

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const ctoId = await ctx.db.insert("agents", { name: "CTO", role: "cto", status: "idle", isEnabled: true });
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p", agentIds: [ctoId] });
    const taskId = await ctx.db.insert("tasks", { projectId, title: "T", command: "do", status: "running" });
    const otherTaskId = await ctx.db.insert("tasks", { projectId, title: "U", command: "do", status: "running" });
    return { ctoId, projectId, taskId, otherTaskId };
  });
  return { t, ...ids };
}

beforeEach(() => {
  llm.calls = 0;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("messages.send clientId", () => {
  test("a duplicate send returns the same row and schedules no second reply", async () => {
    const { t, projectId } = await setup();
    const first = await t.mutation(api.messages.send, { projectId, content: "halo tim", clientId: "c-1" });
    const second = await t.mutation(api.messages.send, { projectId, content: "halo tim", clientId: "c-1" });
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.messageId).toBe(first.messageId);
    expect(second.conversationId).toBe(first.conversationId);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const users = await t.run((ctx) =>
      ctx.db.query("messages").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect()
    );
    expect(users.filter((m) => m.authorType === "user")).toHaveLength(1);
    expect(users.filter((m) => m.authorType === "user")[0].clientId).toBe("c-1");
    const replies = users.filter((m) => m.replyToMessageId === (first.messageId as any));
    expect(replies.length).toBeGreaterThan(0);
    const callsAfterOne = llm.calls;
    // The duplicate send scheduled nothing: no extra model calls.
    await t.mutation(api.messages.send, { projectId, content: "halo tim", clientId: "c-1" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(llm.calls).toBe(callsAfterOne);
  });

  test("different client ids are different messages; no client id still works", async () => {
    const { t, projectId } = await setup();
    const a = await t.mutation(api.messages.send, { projectId, content: "x", clientId: "a" });
    const b = await t.mutation(api.messages.send, { projectId, content: "x", clientId: "b" });
    const c = await t.mutation(api.messages.send, { projectId, content: "x" });
    expect(new Set([a.messageId, b.messageId, c.messageId]).size).toBe(3);
  });

  test("client id is validated", async () => {
    const { t, projectId } = await setup();
    expect(normalizeClientId("  ")).toBeUndefined();
    expect(normalizeClientId(" id ")).toBe("id");
    await expect(
      t.mutation(api.messages.send, { projectId, content: "x", clientId: "z".repeat(CLIENT_ID_MAX + 1) })
    ).rejects.toThrow(/too long/);
  });
});

describe("task event idempotency keys", () => {
  test("same task + same key writes one row; another task is separate", async () => {
    const { t, projectId, taskId, otherTaskId } = await setup();
    const [a, b, c] = await t.run(async (ctx) => [
      await appendTaskEvent(ctx, { taskId, projectId, type: "x", eventKey: "k" }),
      await appendTaskEvent(ctx, { taskId, projectId, type: "x", eventKey: "k" }),
      await appendTaskEvent(ctx, { taskId: otherTaskId, projectId, type: "x", eventKey: "k" }),
    ]);
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    const rows = await t.run((ctx) => ctx.db.query("taskEvents").collect());
    expect(rows.filter((r) => r.taskId === taskId).map((r) => r.sequence)).toEqual([1]);
  });

  test("logEvent with a key: a replayed emit adds no event and no canonical event", async () => {
    const { t, projectId, taskId } = await setup();
    const args = { taskId, projectId, type: "subtask.completed", subtaskKey: "a", eventKey: "exec1:subtask.completed" };
    await t.mutation(internal.orchestration.logEvent, args);
    await t.mutation(internal.orchestration.logEvent, args);
    const events = await t.query(api.taskEvents.listByTask, { taskId });
    expect(events).toHaveLength(1);
    const canon = await t.query(api.orchestration.listAgentEvents, { taskId });
    expect(canon.length).toBeLessThanOrEqual(1);
  });
});
