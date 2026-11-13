/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { NO_TOOLS_RETRY_LINE } from "./lib/chat/toolCallText";
import { ONE_CALL_PER_REPLY } from "./lib/chat/repoTools";

/**
 * Tool-call text never reaches a chat bubble.
 *
 * Live bug: "berapa baris apps/api/convex/schema.ts dan tabel apa saja?"
 * showed `{"tool":"read_file","arguments":{…"maxLines":1000}}` as the CTO's
 * answer. With tools on, the model put several calls plus its answer in one
 * reply, which the strict parser took for prose; without tools the plain
 * reply path printed the call. Both paths are covered here, plus the quiet
 * "Repo tools off: …" trace and the post-answer "Unverified" check.
 */

type Call = { system: string; msgs: { role: string; content: string }[] };
const calls: Call[] = [];
/** Scripted model replies, consumed in order (the last one repeats). */
let script: Array<string | ((call: Call) => string)> = [];

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
    const next = script.length > 1 ? script.shift()! : script[0];
    const content = typeof next === "function" ? next(call) : next;
    onChunk?.({ content, reasoning: "" });
    return { content, reasoning: "", reasoningDurationMs: 0 };
  },
}));
vi.mock("./lib/chat/classify", () => ({
  classifyIntent: async () => ({
    intent: "ask",
    subtype: "research",
    requiresWorkspace: false,
    requiresExecution: false,
    confidence: 1,
    reasoning: "test",
  }),
}));
vi.mock("./lib/chat/repoSnapshot", () => ({ readRepoSnapshot: async () => "" }));

const modules = import.meta.glob("./**/*.ts");

const QUESTION = "berapa baris apps/api/convex/schema.ts dan tabel apa saja di dalamnya?";
const LEAKED = '{"tool":"read_file","arguments":{"path":"apps/api/convex/schema.ts","maxLines":1000}}';

async function setup(opts: { workspacePath?: string; worker?: "none" | "old" | "new" } = {}) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const ctoId = await ctx.db.insert("agents", { name: "CTO", role: "cto", status: "idle", isEnabled: true });
    const backendId = await ctx.db.insert("agents", { name: "Backend", role: "backend", status: "idle", isEnabled: true });
    const projectId = await ctx.db.insert("projects", {
      name: "P",
      workspacePath: opts.workspacePath ?? "",
      agentIds: [ctoId, backendId],
    });
    if (opts.worker && opts.worker !== "none") {
      await ctx.db.insert("workers", {
        workerId: "w1",
        capacity: 1,
        activeTasks: 0,
        status: "online",
        lastHeartbeatAt: Date.now(),
        ...(opts.worker === "new" ? { capabilities: ["repoTools"] } : {}),
      });
    }
    return { ctoId, backendId, projectId };
  });
  return { t, ...ids };
}

async function ask(t: Awaited<ReturnType<typeof setup>>["t"], projectId: any, content = QUESTION, preferredAgentIds?: any[]) {
  const { messageId } = await t.mutation(api.messages.send, { projectId, content, ...(preferredAgentIds ? { preferredAgentIds } : {}) });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return await t.run(async (ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_reply_to", (q) => q.eq("replyToMessageId", messageId as any))
      .collect()
  ).then((rows) => rows.filter((r) => r.voice !== "system")); // O3: the "Sent to X" System line is not an answer
}

const JSONISH = /"tool"\s*:|"arguments"\s*:|tool_call/;

beforeEach(() => {
  calls.length = 0;
  script = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("no tools: a tool call is never shown", () => {
  test("retried once with the no-tools line; the prose retry is the answer; trace says why tools are off", async () => {
    const { t, projectId, backendId } = await setup({ workspacePath: "/repo", worker: "none" });
    script = [LEAKED, "Belum saya cek isi schema.ts — repo tidak bisa saya baca dari chat sekarang."];
    const replies = await ask(t, projectId);
    expect(replies).toHaveLength(1);
    // O3: no CTO default; System routes the un-mentioned question to Backend.
    expect(replies[0].agentId).toBe(backendId);
    expect(replies[0].content).toBe("Belum saya cek isi schema.ts — repo tidak bisa saya baca dari chat sekarang.");
    expect(replies[0].content).not.toMatch(JSONISH);
    expect(replies[0].streaming).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[0].system).not.toContain(NO_TOOLS_RETRY_LINE);
    expect(calls[1].system).toContain(NO_TOOLS_RETRY_LINE);
    expect(calls[0].system).not.toContain("## Repo tools");
    expect(replies[0].reasoning).toContain("Repo tools off: no online worker");
  });

  test("still a tool call after the retry → the short fallback in the user's language", async () => {
    const { t, projectId } = await setup({ workspacePath: "/repo", worker: "none" });
    script = [LEAKED, `<longcat_tool_call>${LEAKED}</longcat_tool_call>`];
    const replies = await ask(t, projectId);
    expect(replies).toHaveLength(1);
    expect(replies[0].content).toBe(
      "Belum saya cek — repo tidak bisa dibaca dari chat sekarang (worker belum online atau folder project belum di-set)."
    );
    expect(calls).toHaveLength(2);
  });

  test("English question → English fallback", async () => {
    const { t, projectId } = await setup({ workspacePath: "/repo", worker: "none" });
    script = [LEAKED];
    const replies = await ask(t, projectId, "How many lines does apps/api/convex/schema.ts have?");
    expect(replies[0].content).toMatch(/^I haven't checked that yet — the repo can't be read from chat right now/);
  });

  test("the reason names a missing project folder and an outdated worker", async () => {
    const noFolder = await setup({ worker: "new" });
    script = ["Belum saya cek."];
    expect((await ask(noFolder.t, noFolder.projectId))[0].reasoning).toContain("Repo tools off: project folder not set");

    const oldWorker = await setup({ workspacePath: "/repo", worker: "old" });
    calls.length = 0;
    script = ["Belum saya cek."];
    const replies = await ask(oldWorker.t, oldWorker.projectId);
    expect(replies[0].reasoning).toMatch(/Repo tools off: online worker is outdated/);
    // An old worker never polls the queue: no tool protocol, no queued calls.
    expect(calls[0].system).not.toContain("## Repo tools");
    expect(await oldWorker.t.run(async (ctx) => ctx.db.query("repoToolCalls").collect())).toHaveLength(0);
  });

  // The CTO's own @mentions no longer hand off (a333222): the teammate here
  // is one the user @mentions, which gets the same no-tools handling.
  test("a teammate the user @mentions has its tool call held back the same way", async () => {
    const { t, projectId, backendId } = await setup({ workspacePath: "/repo", worker: "none" });
    script = [
      '{"tool":"grep","arguments":{"query":"defineTable"}}',
      "Belum saya cek tabelnya; perlu task untuk membaca repo.",
    ];
    const replies = await ask(t, projectId, `@Backend ${QUESTION}`, [backendId]);
    const backend = replies.find((r) => r.agentId === backendId);
    expect(backend?.content).toBe("Belum saya cek tabelnya; perlu task untuk membaca repo.");
    for (const r of replies) expect(r.content).not.toMatch(JSONISH);
    expect(calls[1].system).toContain(NO_TOOLS_RETRY_LINE);
  });

  test("post-answer check: a cited path or file:line nobody checked is listed as unverified", async () => {
    const { t, projectId } = await setup({ workspacePath: "/repo", worker: "none" });
    script = ["normalizeRole ada di apps/api/convex/roleRegistry.ts line 58, dipanggil dari chat.ts:412."];
    const replies = await ask(t, projectId);
    expect(replies[0].unverifiedRefs).toEqual(["apps/api/convex/roleRegistry.ts:58", "chat.ts:412"]);
  });
});

describe("tools on: several calls + prose in one reply", () => {
  test("only the first call is queued, call text never reaches the bubble, an unclaimed call fails fast", async () => {
    const { t, projectId } = await setup({ workspacePath: "/repo", worker: "new" });
    const toolsSeen: string[] = [];
    script = [
      // One reply: two calls, then an invented answer.
      `${LEAKED}\n{"tool":"grep","arguments":{"pattern":"defineTable"}}\nSchema punya 1068 baris dan 28 tabel.`,
      (call) => {
        toolsSeen.push(call.msgs.at(-1)?.content ?? "");
        return '{"tool":"grep","arguments":{"pattern":"defineTable","path":"apps/api/convex/schema.ts"}}';
      },
      (call) => {
        toolsSeen.push(call.msgs.at(-1)?.content ?? "");
        return "Belum saya cek — worker tidak merespons, jadi jumlah baris dan tabel schema.ts belum bisa saya pastikan.";
      },
    ];
    const replies = await ask(t, projectId, `@CTO ${QUESTION}`) // typed @CTO: no dispatch pre-route;
    expect(replies).toHaveLength(1);
    expect(replies[0].content).toBe(
      "Belum saya cek — worker tidak merespons, jadi jumlah baris dan tabel schema.ts belum bisa saya pastikan."
    );
    expect(replies[0].content).not.toMatch(JSONISH);
    expect(calls[0].system).toContain("## Repo tools");
    // Step 2 saw the FIRST call's result (read_file, unclaimed) plus the one-call note.
    expect(toolsSeen[0]).toMatch(/^\[tool result: read_file apps\/api\/convex\/schema.ts — failed\]/);
    expect(toolsSeen[0]).toContain("worker tidak merespons");
    expect(toolsSeen[0]).toContain(ONE_CALL_PER_REPLY);
    // The next call failed at once (worker gone), without queueing again.
    expect(toolsSeen[1]).toContain("worker tidak merespons");
    expect(replies[0].reasoning).toContain("Repo tools off: worker tidak merespons");
    expect(await t.run(async (ctx) => ctx.db.query("repoToolCalls").collect())).toHaveLength(0);
  });
});

describe("worker capability", () => {
  const SERVICE_TOKEN = "test-service-token";
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.CONVEX_SERVICE_TOKEN;
    process.env.CONVEX_SERVICE_TOKEN = SERVICE_TOKEN;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CONVEX_SERVICE_TOKEN;
    else process.env.CONVEX_SERVICE_TOKEN = prev;
  });

  test("the heartbeat stores advertised capabilities; an old heartbeat clears them", async () => {
    const { t, projectId } = await setup({ workspacePath: "/repo" });
    const beat = (capabilities?: string[]) =>
      t.action(api.worker.heartbeat, {
        workerToken: SERVICE_TOKEN,
        workerId: "w9",
        capacity: 1,
        activeTasks: 0,
        ...(capabilities ? { capabilities } : {}),
      });
    await beat(["repoTools"]);
    expect(await t.query(internal.repoTools.availability, { projectId })).toEqual({ available: true });
    await beat();
    expect(await t.query(internal.repoTools.availability, { projectId })).toEqual({
      available: false,
      reason: "worker_outdated",
    });
  });
});
