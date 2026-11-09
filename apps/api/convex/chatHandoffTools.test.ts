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
vi.mock("./lib/chat/classify", () => ({
  classifyIntent: async () => ({
    intent: "ask",
    subtype: "research",
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
  const { messageId } = await t.action(api.messages.send, { projectId, content, ...(preferredAgentIds ? { preferredAgentIds } : {}) });
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
  calls.length = 0;
  queued.count = 0;
  reply = () => "ok";
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("handoff teammates get repo tools", () => {
  test("a teammate the CTO hands off to reads the repo itself; the CTO prompt says verify it yourself", async () => {
    const { t, projectId, backendId } = await setup({ worker: "new" });
    reply = (call) => {
      const who = speaker(call);
      const results = toolResults(call);
      if (who === "CTO") return results === 0 ? GREP : "Tabel ada di schema.ts. @Backend tolong beri pendapat soal desain index tabel users.";
      return results === 0 ? READ : "Index users sudah sesuai: schema.ts baris 1 saya baca.";
    };
    const replies = await ask(t, projectId, "tabel apa saja di schema dan apakah index users sudah benar?");
    const backend = replies.find((r) => r.agentId === backendId);
    expect(backend?.content).toBe("Index users sudah sesuai: schema.ts baris 1 saya baca.");
    expect(backend?.checkedFiles).toEqual(["apps/api/convex/schema.ts"]);
    const backendFirst = callsBy("Backend")[0];
    expect(backendFirst.system).toContain("## Repo tools");
    expect(backendFirst.system).toContain(`At most ${MAX_REPO_TOOL_CALLS} tool calls per reply`);
    expect(backendFirst.system).toContain("brought you into this chat");
    expect(backendFirst.system).not.toContain("read beyond the snapshot");
    expect(callsBy("CTO")[0].system).toContain(SELF_VERIFY_LINE);
    expect(queued.count).toBe(2);
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
    const { t, projectId, frontendId, qaId } = await setup({ worker: "new" });
    reply = (call) => {
      const who = speaker(call);
      const results = toolResults(call);
      const exhausted = call.msgs.at(-1)?.content === TOOL_BUDGET_EXHAUSTED;
      if (who === "CTO") {
        return results < 4
          ? GREP
          : "Ringkasan. @Backend tolong nilai desain tabel. @QA tolong nilai cakupan test. @Frontend tolong nilai UI chat.";
      }
      if (who === "Frontend") return "UI chat oke; belum saya cek kodenya.";
      return exhausted ? `${who} selesai.` : GREP;
    };
    const replies = await ask(t, projectId, "tolong nilai desain schema, test, dan UI");
    expect(queued.count).toBe(MAX_REPO_TOOL_CALLS_PER_CHAT);
    // CTO 4, Backend 6 (its own cap), QA gets the 2 left, Frontend none.
    expect(Math.max(...callsBy("CTO").map(toolResults))).toBe(4);
    expect(Math.max(...callsBy("Backend").map(toolResults))).toBe(6);
    expect(Math.max(...callsBy("QA").map(toolResults))).toBe(2);
    expect(callsBy("QA")[0].system).toContain("At most 2 tool calls per reply");
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
    expect(replies[0].reasoning).toContain("Handoff skipped (@QA, @Backend)");
    expect(queued.count).toBe(0);
  });

  test("a specialty-opinion handoff still goes through without tools", async () => {
    const { t, projectId, backendId } = await setup({ worker: "none" });
    let n = 0;
    reply = () => (n++ === 0 ? "Belum saya cek. @Backend tolong beri pendapat soal desain tabel." : "Pendapat saya: pisahkan tabel log.");
    const replies = await ask(t, projectId, "desain tabel log bagusnya gimana?");
    expect(replies.find((r) => r.agentId === backendId)?.content).toBe("Pendapat saya: pisahkan tabel log.");
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
