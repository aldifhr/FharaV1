/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

/**
 * Write requests in chat (live transcripts 2026-11-11): "@Frontend tolong
 * buatkan bold.html …" got a full HTML dump plus "save it yourself", and the
 * CTO answered "buatkan file ultimate.html …" with an architecture lecture and
 * a fixed English "To execute this plan" line. Both showed "Unverified: <file>".
 * Now: a short reply, a Create task offer routed to the code role, no task
 * until the button or "gas", and no Unverified line for the requested file.
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
  chooseAskResponder: async () => null,
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


async function setup(opts: { worker: "none" | "new" }) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const mk = (name: string, role: string) => ctx.db.insert("agents", { name, role, status: "idle", isEnabled: true });
    const ctoId = await mk("CTO", "cto");
    const backendId = await mk("Backend", "backend");
    const qaId = await mk("QA", "qa");
    const frontendId = await mk("Frontend", "frontend");
    const projectId = await ctx.db.insert("projects", {
      name: "P",
      workspacePath: "/repo",
      agentIds: [ctoId, backendId, qaId, frontendId],
    });
    if (opts.worker === "new") {
      await ctx.db.insert("workers", {
        workerId: "w1",
        capacity: 1,
        activeTasks: 0,
        status: "online",
        lastHeartbeatAt: Date.now(),
        capabilities: ["repoTools"],
      });
    }
    return { ctoId, backendId, qaId, frontendId, projectId };
  });
  return { t, ...ids };
}

async function ask(t: Awaited<ReturnType<typeof setup>>["t"], projectId: any, content: string, preferredAgentIds?: any[]) {
  const { messageId } = await t.mutation(api.messages.send, { projectId, content, ...(preferredAgentIds ? { preferredAgentIds } : {}) });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return await t.run(async (ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_reply_to", (q) => q.eq("replyToMessageId", messageId as any))
      .collect()
  );
}

const speaker = (call: Call) => /^You are (\w+),/.exec(call.system)?.[1] ?? "?";

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


describe("write requests in chat get a short reply and a routed Create task offer", () => {
  test("@Frontend asked to create bold.html: short-reply prompt, offer routed to Frontend, no task, no Unverified line", async () => {
    const { t, projectId, frontendId } = await setup({ worker: "none" });
    reply = () => "Siap, bold.html akan saya buat lewat task — balas gas atau tekan Create task.";
    const replies = await ask(t, projectId, "@Frontend tolong buatkan bold.html dengan teks 'Hello World' dengan menggunakan css dan js serta teksnya bold", [frontendId]);
    expect(replies.map((r) => r.agentId)).toEqual([frontendId]);
    const system = calls.find((c) => speaker(c) === "Frontend")!.system;
    expect(system).toContain("Do not paste the file, its contents or any code block");
    expect(system).toContain("override any persona or skill instruction");
    expect(system).not.toContain("helpfully and completely");
    expect(replies[0].taskOffer).toEqual({ kind: "implementation", assigneeAgentId: String(frontendId) });
    expect(replies[0].unverifiedRefs).toBeUndefined();
    expect(await t.run(async (ctx) => ctx.db.query("tasks").collect())).toHaveLength(0);
  });

  test("'gas' after the Frontend offer starts the task, assigned to Frontend", async () => {
    const { t, projectId, frontendId } = await setup({ worker: "none" });
    reply = () => "Siap, saya kerjakan lewat task.";
    await ask(t, projectId, "@Frontend tolong buatkan bold.html dengan teks 'Hello World'", [frontendId]);
    await ask(t, projectId, "gas");
    const tasks = await t.run(async (ctx) => ctx.db.query("tasks").collect());
    expect(tasks).toHaveLength(1);
    expect(tasks[0].command).toContain("bold.html");
    expect(tasks[0].assignedAgentIds).toEqual([frontendId]);
  });

  test("an un-mentioned HTML file request goes to Frontend directly (System line, no CTO); the offer still appears", async () => {
    const { t, projectId, frontendId } = await setup({ worker: "none" });
    reply = () => "Siap, ini dikerjakan lewat task — balas gas atau tekan Create task.";
    const all = await ask(t, projectId, "buatkan file ultimate.html dengan teks 'Ultimate is a new vision' dengan background yang menarik");
    const system = all.filter((r) => r.voice === "system");
    const replies = all.filter((r) => r.voice !== "system");
    expect(system.map((r) => r.content)).toEqual(["Sent to Frontend"]);
    expect(system[0].agentId).toBeUndefined();
    expect(replies.map((r) => r.agentId)).toEqual([frontendId]);
    expect(calls.some((c) => speaker(c) === "CTO")).toBe(false);
    const prompt = calls.find((c) => speaker(c) === "Frontend")!.system;
    expect(prompt).toContain("Do not paste the file, its contents or any code block");
    expect(prompt).not.toContain("To execute this plan");
    expect(replies[0].taskOffer).toEqual({ kind: "implementation", assigneeAgentId: String(frontendId) });
    expect(replies[0].unverifiedRefs).toBeUndefined();
    await ask(t, projectId, "gas");
    const tasks = await t.run(async (ctx) => ctx.db.query("tasks").collect());
    expect(tasks.map((task) => task.assignedAgentIds)).toEqual([[frontendId]]);
  });

  test("a question to @Frontend stays a normal answer with no offer", async () => {
    const { t, projectId, frontendId } = await setup({ worker: "none" });
    reply = () => "Pakai font-weight: 700.";
    const replies = await ask(t, projectId, "@Frontend gimana cara bikin teks bold di css?", [frontendId]);
    expect(replies[0].taskOffer).toBeUndefined();
  });
});
