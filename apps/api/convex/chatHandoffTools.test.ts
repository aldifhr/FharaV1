/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  MAX_REPO_TOOL_CALLS,
  MAX_REPO_TOOL_CALLS_PER_CHAT,
  TOOL_BUDGET_EXHAUSTED,
  createRepoToolBudget,
} from "./lib/chat/repoTools";
import { isVerificationRequest } from "./lib/chat/team";
import { SELF_VERIFY_LINE, buildHandoffGuidance } from "./lib/prompts/chat";

/**
 * Teammates the CTO hands off to (and agents the user @mentions) get the
 * same read-only repo tools as the CTO, under one shared budget per chat
 * turn. Live bug: the CTO handed "verify the table list literally" to @QA
 * and @Backend, who had no tools and both answered "belum saya cek — saya
 * tidak punya akses".
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

/** A specialist reply over the short-reply limit (lib/chat/wrapUp.ts). */
const LONG_REPLY = (topic: string) =>
  Array.from({ length: 10 }, (_, i) => `Point ${i + 1} about ${topic}: ` + Array.from({ length: 14 }, (_, j) => `detail${i}_${j}`).join(" ") + ".").join("\n");

const READ = '{"tool":"read_file","arguments":{"path":"apps/api/convex/schema.ts"}}';
const GREP = '{"tool":"grep","arguments":{"pattern":"defineTable"}}';

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
const toolResults = (call: Call) => call.msgs.filter((m) => m.content.startsWith("[tool result:")).length;
const callsBy = (name: string) => calls.filter((c) => speaker(c) === name);

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

// "@CTO" typed: the CTO answers itself (no dispatch pre-route). An @Name in
// its own reply is a pointer for the user, never a handoff (live2 3d).
describe("handoff teammates get repo tools", () => {
  test("an @mention inside the CTO's reply does not pull the teammate in; the CTO prompt says verify it yourself", async () => {
    const { t, projectId, ctoId } = await setup({ worker: "new" });
    reply = (call) => {
      const who = speaker(call);
      const results = toolResults(call);
      if (who === "CTO") return results === 0 ? GREP : "Tabel ada di schema.ts. Kalau mau, izinkan @Backend atau @QA lanjut cek index users?";
      return "should not answer";
    };
    const replies = await ask(t, projectId, "@CTO tabel apa saja di schema dan apakah index users sudah benar?");
    expect(replies.map((r) => r.agentId)).toEqual([ctoId]);
    expect(callsBy("Backend")).toHaveLength(0);
    expect(callsBy("QA")).toHaveLength(0);
    expect(replies[0].toolSteps?.some((s: any) => s.tool === "handoff")).not.toBe(true);
    expect(callsBy("CTO")[0].system).toContain(SELF_VERIFY_LINE);
    expect(callsBy("CTO")[0].system).toContain("does NOT bring a teammate into this chat");
    expect(queued.count).toBe(1);
  });

  test("an agent the user @mentions directly gets the tools too", async () => {
    const { t, projectId, qaId } = await setup({ worker: "new" });
    reply = (call) => (toolResults(call) === 0 ? GREP : "Ada 1 match defineSchema.");
    const replies = await ask(t, projectId, "@QA cek defineTable di repo", [qaId]);
    expect(replies.map((r) => r.agentId)).toEqual([qaId]);
    expect(callsBy("QA")[0].system).toContain("## Repo tools");
    expect(queued.count).toBe(1);
  });
});

describe("shared repo tool budget", () => {
  test("at most 12 calls across all agents in one turn; the rest answer without tools", async () => {
    const { t, projectId, backendId, frontendId, qaId } = await setup({ worker: "new" });
    reply = (call) => {
      const who = speaker(call);
      const exhausted = call.msgs.at(-1)?.content === TOOL_BUDGET_EXHAUSTED;
      if (who === "Frontend") return "UI chat oke; belum saya cek kodenya.";
      return exhausted ? `${who} selesai.` : GREP;
    };
    // The user @mentions three teammates: they answer in order, one budget.
    const replies = await ask(t, projectId, "@Backend @QA @Frontend tolong nilai desain schema, test, dan UI", [backendId, qaId, frontendId]);
    expect(queued.count).toBe(MAX_REPO_TOOL_CALLS_PER_CHAT);
    // Backend 6 (its own cap), QA the 6 left, Frontend none.
    expect(Math.max(...callsBy("Backend").map(toolResults))).toBe(6);
    expect(Math.max(...callsBy("QA").map(toolResults))).toBe(6);
    const frontendCall = callsBy("Frontend")[0];
    expect(frontendCall.system).not.toContain("## Repo tools");
    expect(frontendCall.system).toContain("You have no repo access and no tools in this reply");
    const frontend = replies.find((r) => r.agentId === frontendId);
    expect(frontend?.content).toBe("UI chat oke; belum saya cek kodenya.");
    expect(frontend?.reasoning).toMatch(/Repo tools off: this reply's shared budget of 12 repo tool calls is used up/);
    expect(replies.find((r) => r.agentId === qaId)?.content).toBe("QA selesai.");
  });

  test("budget helper: per-reply cap and the shared total", () => {
    const budget = createRepoToolBudget();
    expect(budget.capForNextReply()).toBe(6);
    budget.spend(6);
    budget.spend(4);
    expect(budget.capForNextReply()).toBe(2);
    budget.spend(2);
    expect(budget.capForNextReply()).toBe(0);
    expect(budget.used).toBe(12);
  });
});

describe("tools off: no verification handoff", () => {
  test("the CTO is told teammates have no access either, and a check/verify handoff is dropped", async () => {
    const { t, projectId, ctoId } = await setup({ worker: "none" });
    reply = () =>
      "Daftar tabel belum saya cek. @QA tolong verifikasi daftar tabel secara literal. @Backend tolong cek nama fungsinya.";
    const replies = await ask(t, projectId, "sebutkan tabel dan nama fungsi di schema");
    expect(replies.map((r) => r.agentId)).toEqual([ctoId]);
    expect(calls).toHaveLength(1);
    expect(calls[0].system).toContain("do not @mention teammates to check, verify, or grep code");
    expect(calls[0].system).toContain("suggest restarting the worker or setting the project folder (reason: no online worker)");
    expect(calls[0].system).not.toContain(SELF_VERIFY_LINE);
    // The CTO's @mentions never hand off, with or without tools.
    expect(replies[0].reasoning ?? "").not.toContain("Handoff skipped");
    expect(queued.count).toBe(0);
  });

  test("a specialty-opinion @mention in the CTO's reply is not a handoff either", async () => {
    const { t, projectId, ctoId } = await setup({ worker: "none" });
    reply = () => "Belum saya cek. @Backend bisa beri pendapat soal desain tabel kalau Anda @mention dia.";
    const replies = await ask(t, projectId, "@CTO desain tabel log bagusnya gimana?");
    expect(replies.map((r) => r.agentId)).toEqual([ctoId]);
    expect(calls).toHaveLength(1);
  });

  test("verification wording and guidance lines", () => {
    for (const text of ["@QA tolong cek tabelnya", "@QA verifikasi nama fungsi", "@Backend periksa schema", "@QA grep defineTable", "@QA please check it", "@QA verify the names"]) {
      expect(isVerificationRequest(text)).toBe(true);
    }
    for (const text of ["@Backend beri pendapat soal desain", "@QA what tests would you add?", "@Frontend checkout page design"]) {
      expect(isVerificationRequest(text)).toBe(false);
    }
    const team = [
      { _id: "cto", name: "CTO", role: "cto" },
      { _id: "qa", name: "QA", role: "qa" },
    ];
    expect(buildHandoffGuidance(team, "cto", { hasRepoTools: true })).toContain(SELF_VERIFY_LINE);
    expect(buildHandoffGuidance(team, "cto", { hasRepoTools: false, offReason: "project folder not set" }).at(-1)).toMatch(
      /no repo access.*\(reason: project folder not set\)/
    );
  });
});

describe("CTO dispatch pre-route (no @mention)", () => {
  test("a QA question goes to QA: CTO handoff line, QA answers with tools; a short single reply gets no CTO wrap-up", async () => {
    const { t, projectId, ctoId, qaId } = await setup({ worker: "new" });
    reply = (call) => {
      const who = speaker(call);
      if (who === "QA") return toolResults(call) === 0 ? GREP : "Cakupan tes schema masih tipis: belum ada tes untuk defineTable.";
      return "QA: cakupan tes schema masih tipis.";
    };
    const replies = await ask(t, projectId, "gimana cakupan tes untuk schema kita sekarang?");
    expect(replies.map((r) => r.agentId)).toEqual([ctoId, qaId]);
    expect(replies[0].content).toBe("Saya serahkan ke @QA untuk pengecekan tes ini.");
    expect(replies[1].content).toBe("Cakupan tes schema masih tipis: belum ada tes untuk defineTable.");
    const qaFirst = callsBy("QA")[0];
    expect(qaFirst.system).toContain("## Repo tools");
    expect(qaFirst.system).toContain("handed the user's latest message to you");
    // No wrap-up call was even made.
    expect(callsBy("CTO")).toHaveLength(0);
  });

  test("the user named the specialist ('can you ask frontend …'): no CTO wrap-up", async () => {
    const { t, projectId, ctoId, frontendId } = await setup({ worker: "new" });
    const long = LONG_REPLY("HTML");
    reply = (call) => (speaker(call) === "Frontend" ? long : "HTML is the markup language. Want me to show an example?");
    const replies = await ask(t, projectId, "can you ask frontend, what is html");
    expect(replies.map((r) => r.agentId)).toEqual([ctoId, frontendId]);
    expect(callsBy("CTO")).toHaveLength(0);
  });

  test("the specialist never sees the handoff line as a transcript line, and a copied one is stripped", async () => {
    const { t, projectId, ctoId, frontendId } = await setup({ worker: "new" });
    const line = "Handing this to @Frontend for the frontend side.";
    // Live bug: Frontend opened with the CTO's handoff line.
    reply = (call) => (speaker(call) === "Frontend" ? `CTO: ${line}\n\nHTML is the markup language of the web.` : "nothing to add");
    const replies = await ask(t, projectId, "can you ask frontend, what is html");
    expect(replies.map((r) => r.agentId)).toEqual([ctoId, frontendId]);
    expect(replies[0].content).toBe(line);
    expect(replies[1].content).toBe("HTML is the markup language of the web.");
    const first = callsBy("Frontend")[0];
    expect(first.system).not.toContain("Handing this to");
    expect(first.system).toContain("handed the user's latest message to you");
    expect(first.msgs.map((m) => m.content).join("\n")).not.toContain("Handing this to");

    // Next turn: the earlier handoff line stays out of the history too.
    calls.length = 0;
    reply = (call) => (speaker(call) === "Frontend" ? "CSS styles the HTML." : "nothing to add");
    await ask(t, projectId, "can you ask frontend, what is css");
    const second = callsBy("Frontend")[0];
    const transcript = second.msgs.map((m) => m.content).join("\n");
    expect(transcript).not.toContain("Handing this to");
    expect(transcript).toContain("HTML is the markup language of the web.");
  });

  test("a long single reply gets a wrap-up of at most 2 lines with only a next step", async () => {
    const { t, projectId, ctoId, qaId } = await setup({ worker: "new" });
    const long = LONG_REPLY("coverage");
    reply = (call) => {
      const who = speaker(call);
      if (who === "QA") return toolResults(call) === 0 ? GREP : long;
      return "Keputusan: tambah tes untuk defineTable dulu.\nLangkah berikut: QA menulis tesnya.\nBaris ketiga tidak boleh tampil.";
    };
    const replies = await ask(t, projectId, "gimana cakupan tes untuk schema kita sekarang?");
    expect(replies.map((r) => r.agentId)).toEqual([ctoId, qaId, ctoId]);
    expect(replies[2].content).toBe("Keputusan: tambah tes untuk defineTable dulu.\nLangkah berikut: QA menulis tesnya.");
    const summary = callsBy("CTO").at(-1)!;
    expect(summary.system).toContain("at most 2 lines");
    expect(summary.system).toContain("Do not restate, summarise or paraphrase the reply");
    expect(summary.system).not.toContain("## Repo tools");
    expect(summary.msgs.at(-1)?.content).toContain("QA's reply:\n" + long.split("\n")[0]);
  });

  test("a wrap-up that restates the long reply is dropped, not posted", async () => {
    const { t, projectId, ctoId, qaId } = await setup({ worker: "new" });
    const long = LONG_REPLY("coverage");
    reply = (call) => {
      const who = speaker(call);
      if (who === "QA") return toolResults(call) === 0 ? GREP : long;
      return long.split("\n").slice(0, 2).join(" ");
    };
    const replies = await ask(t, projectId, "gimana cakupan tes untuk schema kita sekarang?");
    expect(replies.map((r) => r.agentId)).toEqual([ctoId, qaId]);
    expect(callsBy("CTO")).toHaveLength(1);
  });

  test("the CTO itself answers a planning question", async () => {
    const { t, projectId, ctoId } = await setup({ worker: "new" });
    reply = () => "Fokus ke login dulu.";
    const replies = await ask(t, projectId, "prioritas kita minggu ini apa?");
    expect(replies.map((r) => r.agentId)).toEqual([ctoId]);
  });

  test("a code question with repo tools off stays with the CTO", async () => {
    const { t, projectId, ctoId } = await setup({ worker: "none" });
    reply = () => "Belum saya cek.";
    const replies = await ask(t, projectId, "apakah fungsi parseConfig sudah dites?");
    expect(replies.map((r) => r.agentId)).toEqual([ctoId]);
  });

  test("'tolong jalankan tes' gets a CTO Create task offer (stored on the reply), never a task", async () => {
    const { t, projectId, ctoId } = await setup({ worker: "new" });
    // nous ignored the plan guidance in live2 3e; the offer must not depend on the wording.
    reply = () => "Saya tidak punya akses shell. Jalankan npm test di terminal lokal Anda.";
    const replies = await ask(t, projectId, "tolong jalankan tes");
    expect(replies.map((r) => r.agentId)).toEqual([ctoId]);
    expect(calls[0].system).toContain("Create task button under this reply runs `npm run test`");
    expect(calls[0].system).toContain("Never say you have no shell or terminal access");
    expect(replies[0].taskOffer).toEqual({ kind: "testing", commands: ["npm run test"] });
    const tasks = await t.run(async (ctx) => ctx.db.query("tasks").collect());
    expect(tasks).toHaveLength(0);
  });

  test("a go reply after a stored run offer starts exactly the detected command", async () => {
    const { t, projectId } = await setup({ worker: "new" });
    reply = () => "Siap.";
    await ask(t, projectId, "tolong jalankan tes");
    await ask(t, projectId, "gas");
    const tasks = await t.run(async (ctx) => ctx.db.query("tasks").collect());
    expect(tasks.map((task) => task.command)).toEqual(["jalankan npm run test"]);
    expect(tasks[0].title).toBe("tolong jalankan tes");
  });
});

// live2 3a/3f: nous labels "tolong audit kode src/" and "cek lebih dalam" as
// task/audit. The pre-route is deterministic: the LLM label never decides it.
describe("pre-route ignores the LLM's audit/review label", () => {
  test("a read-only request the LLM calls task/audit still goes to the specialist; follow-ups go back to it", async () => {
    const { t, projectId, ctoId, qaId } = await setup({ worker: "new" });
    llmIntent.intent = "task";
    llmIntent.subtype = "audit";
    reply = (call) => (speaker(call) === "QA" ? "Tes untuk main.js belum ada." : "CTO answered");
    const first = await ask(t, projectId, "tolong audit tes di src/");
    expect(first.map((r) => r.agentId)).toEqual([ctoId, qaId]);
    expect(first[0].content).toMatch(/^Saya serahkan ke @QA/);
    // The routed reply is chat: no Create task offer on anything.
    expect(first.some((r) => r.taskOffer)).toBe(false);
    for (const followUp of ["cek lebih dalam", "lanjutkan", "detailnya?"]) {
      const replies = await ask(t, projectId, followUp);
      expect(replies.map((r) => r.agentId)).toEqual([ctoId, qaId]);
    }
    const tasks = await t.run(async (ctx) => ctx.db.query("tasks").collect());
    expect(tasks).toHaveLength(0);
  });

  test("a change request stays with the CTO (plan + Create task offer), never routed", async () => {
    const { t, projectId, ctoId } = await setup({ worker: "new" });
    llmIntent.intent = "task";
    llmIntent.subtype = "implementation";
    reply = () => "Rencana singkat.";
    const replies = await ask(t, projectId, "tambahkan tes untuk main.js");
    expect(replies.map((r) => r.agentId)).toEqual([ctoId]);
    expect(replies[0].taskOffer).toEqual({ kind: "implementation" });
  });

  test("the user typed @CTO: no pre-route and no handoff", async () => {
    const { t, projectId, ctoId } = await setup({ worker: "new" });
    llmIntent.intent = "task";
    llmIntent.subtype = "audit";
    reply = () => "Kode tes di src sudah saya baca: belum ada tes untuk main.js. Kalau perlu pendapat QA, @QA bisa Anda mention.";
    const replies = await ask(t, projectId, "@CTO cek kode tes src");
    expect(replies.map((r) => r.agentId)).toEqual([ctoId]);
  });
});

