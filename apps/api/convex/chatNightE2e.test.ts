/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { commandNeedsChatContext, composeOfferedTask, findOfferedTask, isMetaFollowUp, requestAnsweredByOffer } from "./lib/chat/intent";
import { buildChatMessages, buildSeparateSpeakersLine, buildTurnContextSection, NO_SPEAKER_PREFIX_LINE, teammateContextBlock } from "./lib/prompts/chat";
import { CALL_OR_ANSWER, FINAL_ANSWER_NOW, isNarrationOnly, runRepoToolLoop } from "./lib/chat/repoTools";
import { stripLeakedToolCallTags } from "./lib/chat/strip";

/**
 * Chat intent bugs from the night e2e (2026-11-09):
 * (1) "gas" built the task from the previous user message ("kok bikin task?")
 *     and task commands got unrelated earlier turns appended;
 * (2) a multi-line pasted request got a greeting reply (history sat inside
 *     the system prompt's tools section);
 * (3) with 3 @mentions the first agent answered for all three;
 * (4) the CTO tool loop ended on "Saya cek ulang…" with no answer;
 * (5) a leaked <longcat_tool_call> was stored in a reply.
 */

type Call = { system: string; msgs: { role: string; content: string }[] };
const calls: Call[] = [];
let replyFor: (call: Call) => string = () => "Oke.";

vi.mock("./lib/chat/llm", () => ({
  getGlobalLLMConfig: () => ({ baseUrl: "http://llm.test", apiKey: "k", model: "m" }),
  resolveConfigFromProviders: async (_p: unknown, global: unknown) => global,
  completeWithAgent: async (system: string, msgs: { role: string; content: string }[]) => {
    const call = { system, msgs: msgs.map((m) => ({ ...m })) };
    calls.push(call);
    return { content: replyFor(call), reasoning: "", reasoningDurationMs: 0 };
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
    const frontendId = await ctx.db.insert("agents", { name: "Frontend", role: "frontend", status: "idle", isEnabled: true });
    const backendId = await ctx.db.insert("agents", { name: "Backend", role: "backend", status: "idle", isEnabled: true });
    const qaId = await ctx.db.insert("agents", { name: "QA", role: "qa", status: "idle", isEnabled: true });
    const projectId = await ctx.db.insert("projects", {
      name: "demo-app",
      workspacePath: "/tmp/demo",
      agentIds: [ctoId, frontendId, backendId, qaId],
    });
    return { ctoId, frontendId, backendId, qaId, projectId };
  });
  return { t, ...ids };
}

async function send(t: Awaited<ReturnType<typeof setup>>["t"], args: { projectId: any; content: string; preferredAgentIds?: any[] }) {
  const res = await t.mutation(api.messages.send, args);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return res;
}

beforeEach(() => {
  calls.length = 0;
  replyFor = () => "Oke.";
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const CTO_FAQ_OFFER =
  "Maaf, saya memang tidak bisa menyentuh workspace. Kalau Anda tidak mau buka Create task, tinggal bilang saja dan saya panggil @Frontend supaya dia yang menyiapkan halaman FAQ-nya. Pilih: lewat Create task, atau saya delegasikan ke Frontend sekarang?";
/** The night e2e A6 sequence, in order. */
const nightHistory = [
  { authorType: "user", content: "dia bilang: buat halaman FAQ" },
  { authorType: "agent", agentId: "cto", content: "Rencana: @Frontend membuat halaman FAQ statis. To execute this plan, klik Create task." },
  { authorType: "user", content: "bisa nggak kita tambahkan fitur pencarian di halaman about?" },
  { authorType: "agent", agentId: "cto", content: "Belum perlu; pencarian browser cukup. Kalau tetap mau, silakan pakai Create task." },
  { authorType: "user", content: "kok bikin task?" },
  { authorType: "agent", agentId: "cto", content: CTO_FAQ_OFFER },
  { authorType: "user", content: "gas" },
];
const roleOf = (id: string | undefined) => (id === "cto" ? "cto" : id === "fe" ? "frontend" : undefined);

describe("(1) a go reply starts the task the CTO offered", () => {
  test("night e2e A6: 'gas' builds the FAQ task, never 'kok bikin task?'", () => {
    const offer = findOfferedTask(nightHistory, roleOf);
    expect(offer).not.toBeNull();
    expect(offer!.title).toBe("buat halaman FAQ");
    expect(offer!.command).toBe(`dia bilang: buat halaman FAQ\n\n${CTO_FAQ_OFFER}`);
    expect(offer!.command).not.toContain("kok bikin task?");
    expect(offer!.command).not.toContain("pencarian");
  });

  test("meta follow-ups are never the request", () => {
    for (const t of ["kok bikin task?", "kenapa begitu?", "gas", "lanjut", "...?", "loh kok gitu", "I choose A: X"]) expect(isMetaFollowUp(t)).toBe(true);
    for (const t of ["buat halaman FAQ", "bisa nggak tambah dark mode?", "dia bilang: buat halaman FAQ"]) expect(isMetaFollowUp(t)).toBe(false);
  });

  test("the request the offer answered: best word overlap, ties go to the nearest", () => {
    expect(requestAnsweredByOffer(nightHistory, 5)).toBe("dia bilang: buat halaman FAQ");
    const plain = [
      { authorType: "user", content: "tambah dark mode" },
      { authorType: "agent", content: "Plan… klik Create task." },
    ];
    expect(requestAnsweredByOffer(plain, 1)).toBe("tambah dark mode");
    // Only meta before the offer: the offer stands alone, titled from itself.
    const onlyMeta = [
      { authorType: "user", content: "kok bikin task?" },
      { authorType: "agent", content: "Saya sarankan @Frontend menambah toggle tema. Klik Create task." },
    ];
    expect(composeOfferedTask(onlyMeta, 1)).toEqual({
      command: onlyMeta[1].content,
      title: onlyMeta[1].content.slice(0, 80),
    });
  });

  test("an option pick right before the offer still composes like the button", () => {
    const h = [
      { authorType: "user", content: "I choose B: Sidebar layout" },
      { authorType: "agent", content: "I agree. @Backend builds it." },
    ];
    expect(composeOfferedTask(h, 1)).toEqual({
      command: "Chosen option: Sidebar layout\n\nI agree. @Backend builds it.",
      title: "Implement Sidebar layout",
      pick: "Sidebar layout",
    });
  });

  test("only back-referencing or bare commands take chat context", () => {
    for (const c of ["kerjakan yang tadi", "do that", "buatin", "push", "itu aja"]) expect(commandNeedsChatContext(c)).toBe(true);
    for (const c of ["buat halaman login, register, logout", "tambah dark mode", "line one\nline two"]) expect(commandNeedsChatContext(c)).toBe(false);
  });

  test("end to end: 'gas' after the offer creates the FAQ task with no appended turns", async () => {
    const { t, projectId, frontendId } = await setup();
    // Drive the chat through messages.send: the CTO answers each turn with
    // the reply it gave in the night run.
    const script = new Map(nightHistory.slice(0, 6).map((row, i, all) => [row.content, all[i + 1]?.content ?? ""]));
    replyFor = (call) => script.get(call.msgs[call.msgs.length - 1].content) ?? "Oke.";
    for (const row of nightHistory.slice(0, 6)) if (row.authorType === "user") await send(t, { projectId, content: row.content });
    await send(t, { projectId, content: "gas" });
    const tasks = await t.run(async (ctx) => ctx.db.query("tasks").collect());
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("buat halaman FAQ");
    expect(tasks[0].command).toBe(`dia bilang: buat halaman FAQ\n\n${CTO_FAQ_OFFER}`);
    expect(tasks[0].command).not.toContain("--- Conversation context ---");
    expect(tasks[0].assignedAgentIds).toEqual([frontendId]);
  });

  test("a self-contained /task command gets no earlier turns appended", async () => {
    const { t, projectId } = await setup();
    await send(t, { projectId, content: "apa kabar tim?" });
    await send(t, { projectId, content: "/task buat halaman login, register, logout" });
    const tasks = await t.run(async (ctx) => ctx.db.query("tasks").collect());
    expect(tasks).toHaveLength(1);
    expect(tasks[0].command).toBe("buat halaman login, register, logout");
  });
});

describe("(2) history goes in as messages, the latest user message last", () => {
  const PASTE = "Tolong buat checkout:\n- form alamat\n- pilih kurir\n- ringkasan pesanan + tombol bayar";

  test("buildChatMessages: whole latest message last, older turns before it", () => {
    const msgs = buildChatMessages(
      [
        { authorType: "user", content: "halo apa kabar" },
        { authorType: "agent", agentId: "cto", content: "Halo, kabar saya baik." },
        { authorType: "agent", agentId: "fe", content: "Halo juga." },
        { authorType: "user", content: PASTE },
      ],
      { selfAgentId: "cto", nameOf: (id) => (id === "fe" ? "Frontend" : "CTO") }
    );
    expect(msgs).toEqual([
      { role: "user", content: "halo apa kabar" },
      { role: "assistant", content: "Halo, kabar saya baik." },
      // A teammate's reply is quoted context, never a "Frontend: …" line the model copies (live test 4).
      { role: "user", content: teammateContextBlock("Frontend", "Halo juga.") },
      { role: "user", content: PASTE },
    ]);
    for (const m of msgs) expect(m.content).not.toMatch(/^(?:CTO|Frontend):/);
  });

  test("leading agent turns and empty card rows are dropped; nothing is role system", () => {
    const msgs = buildChatMessages([
      { authorType: "agent", agentId: "cto", content: "old" },
      { authorType: "agent", agentId: "cto", content: "" },
      { authorType: "user", content: "q" },
    ]);
    expect(msgs).toEqual([{ role: "user", content: "q" }]);
  });

  test("the turn section says to answer the last message and carries the summary", () => {
    const section = buildTurnContextSection({ summary: "Dibahas: FAQ.", quoteLine: "The user is replying to X" });
    expect(section).toMatch(/Answer the user's LAST message/);
    expect(section).toContain("Summary of the earlier conversation: Dibahas: FAQ.");
    expect(section).toContain("The user is replying to X");
  });

  test("end to end: a pasted multi-line request after a greeting is the last message, and history is not in the system prompt", async () => {
    const { t, projectId } = await setup();
    await send(t, { projectId, content: "halo" });
    calls.length = 0;
    await send(t, { projectId, content: PASTE });
    const reply = calls[calls.length - 1];
    expect(reply.msgs[reply.msgs.length - 1]).toEqual({ role: "user", content: PASTE });
    expect(reply.msgs[0]).toEqual({ role: "user", content: "halo" });
    expect(reply.system).not.toContain("Conversation so far");
    expect(reply.system).not.toContain(PASTE);
    expect(reply.system).toMatch(/Answer the user's LAST message/);
  });
});

describe("(3) several @mentions: each agent answers only as itself", () => {
  test("separate speakers line", () => {
    const line = buildSeparateSpeakersLine({ name: "Frontend", role: "frontend" }, [
      { name: "Frontend", role: "frontend" },
      { name: "Backend", role: "backend" },
      { name: "QA", role: "qa" },
    ]);
    expect(line).toContain("Other teammates answer this message separately, each in their own reply: Backend (backend), QA (qa).");
    expect(line).toContain("Answer only as yourself (Frontend, frontend)");
    expect(line).toMatch(/Never answer for them/);
    expect(buildSeparateSpeakersLine({ name: "CTO", role: "cto" }, [{ name: "CTO", role: "cto" }])).toBe("");
  });

  test("end to end: @Frontend @Backend @QA — three replies, each told the others answer separately", async () => {
    const { t, projectId, frontendId, backendId, qaId } = await setup();
    replyFor = (call) => `Bagian ${/You are (\w+)/.exec(call.system)?.[1]}.`;
    const ask = "@Frontend @Backend @QA review rencana checkout ini";
    await send(t, { projectId, content: ask, preferredAgentIds: [frontendId, backendId, qaId] });
    expect(calls).toHaveLength(3);
    const [fe, be, qa] = calls;
    expect(fe.system).toContain("You are Frontend");
    expect(fe.system).toContain("each in their own reply: Backend (backend), QA (qa)");
    expect(be.system).toContain("Answer only as yourself (Backend, backend)");
    // Later speakers see earlier replies in their system section, and the
    // user's message stays the last chat message.
    expect(be.system).toContain('<teammate_reply from="Frontend">\nBagian Frontend.\n</teammate_reply>');
    expect(qa.system).toContain('<teammate_reply from="Backend">\nBagian Backend.\n</teammate_reply>');
    expect(be.system).not.toContain("- Frontend: Bagian Frontend.");
    expect(be.system).toContain(NO_SPEAKER_PREFIX_LINE);
    for (const c of calls) expect(c.msgs[c.msgs.length - 1]).toEqual({ role: "user", content: ask });
  });
});

describe("(4) the tool loop always ends on an answer", () => {
  const ok = async () => ({ ok: true, text: "1 match\nsrc/a.ts:1: x", files: ["src/a.ts"] });

  test("narration detection", () => {
    for (const t of ["Saya cek ulang tiap nama secara terpisah.", "Let me check the schema.", "Oke, saya periksa dulu…", "I'll verify each name."]) {
      expect(isNarrationOnly(t)).toBe(true);
    }
    for (const t of [
      "Saya sudah cek: tidak ketemu.",
      "Saya cek sendiri. @QA bisa bantu kalau Anda minta.",
      "I'll check it if you want.",
      "Fungsi itu ada di src/a.ts:12.",
      "Tidak ada fungsi bernama foo di repo ini, saya cari lewat grep dan 0 hasil di seluruh repo; jadi itu tidak ada.",
      "",
    ]) {
      expect(isNarrationOnly(t)).toBe(false);
    }
  });

  test("night e2e R-a3: ends on narration after the budget → one forced final answer", async () => {
    const replies = ['{"tool":"grep","arguments":{"pattern":"foo"}}', "Saya cek ulang tiap nama secara terpisah.", "Tidak ketemu: foo tidak ada di repo."];
    const seen: string[] = [];
    const loop = await runRepoToolLoop({
      messages: [{ role: "user", content: "cek foo" }],
      maxCalls: 1,
      step: async (msgs) => {
        seen.push(msgs[msgs.length - 1].content);
        return { content: replies.shift() ?? "" };
      },
      callTool: ok,
    });
    expect(loop.answer).toBe("Tidak ketemu: foo tidak ada di repo.");
    expect(seen[seen.length - 1]).toBe(FINAL_ANSWER_NOW);
  });

  test("a call with no budget left gets a forced final answer, not an empty reply", async () => {
    const replies = ['{"tool":"grep","arguments":{"pattern":"a"}}', '{"tool":"grep","arguments":{"pattern":"b"}}', "Jawaban akhir."];
    const loop = await runRepoToolLoop({
      messages: [{ role: "user", content: "q" }],
      maxCalls: 1,
      step: async () => ({ content: replies.shift() ?? "" }),
      callTool: ok,
    });
    expect(loop.answer).toBe("Jawaban akhir.");
    expect(loop.repoCalls).toBe(1);
  });

  test("narration with budget left gets one nudge, then the check runs", async () => {
    const replies = ["Saya cek dulu filenya.", '{"tool":"grep","arguments":{"pattern":"x"}}', "Ada di src/a.ts:1."];
    const seen: string[] = [];
    const loop = await runRepoToolLoop({
      messages: [{ role: "user", content: "q" }],
      maxCalls: 2,
      step: async (msgs) => {
        seen.push(msgs[msgs.length - 1].content);
        return { content: replies.shift() ?? "" };
      },
      callTool: ok,
    });
    expect(seen[1]).toBe(CALL_OR_ANSWER);
    expect(loop.repoCalls).toBe(1);
    expect(loop.answer).toBe("Ada di src/a.ts:1.");
  });

  test("a model that never answers yields '' so the caller shows its fallback", async () => {
    const loop = await runRepoToolLoop({
      messages: [{ role: "user", content: "q" }],
      maxCalls: 0,
      step: async () => ({ content: "Saya cek dulu ya." }),
      callTool: ok,
    });
    expect(loop.answer).toBe("");
  });
});

describe("(5) leaked tool-call tags never reach a stored reply", () => {
  test("stripLeakedToolCallTags", () => {
    expect(stripLeakedToolCallTags('Jawaban.\n<longcat_tool_call>{"tool":"grep","arguments":{"pattern":"x"}}</longcat_tool_call>')).toBe("Jawaban.");
    expect(stripLeakedToolCallTags("Saya cek.<longcat_tool_call>read_file<longcat_arg_key>path</longcat_arg_key>")).toBe("Saya cek.");
    // JSON shown on purpose (no tags) is kept as written.
    const json = 'Contoh:\n{"tool":"grep","arguments":{"pattern":"x"}}';
    expect(stripLeakedToolCallTags(json)).toBe(json);
  });

  test("end to end: a reply carrying <longcat_tool_call> is stored without it", async () => {
    const { t, projectId } = await setup();
    replyFor = () => 'Halaman FAQ sebaiknya statis.\n<longcat_tool_call>{"tool":"grep","arguments":{"pattern":"faq"}}</longcat_tool_call>';
    const { messageId } = await send(t, { projectId, content: "halaman FAQ sebaiknya statis atau dinamis?" });
    const replies = await t.run(async (ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_reply_to", (q) => q.eq("replyToMessageId", messageId as any))
        .collect()
    );
    expect(replies.length).toBeGreaterThan(0);
    for (const r of replies) expect(r.content).not.toMatch(/longcat/);
  });

  test("storage guard: insertAgentMessage strips leaked tags", async () => {
    const { t, projectId } = await setup();
    const { internal } = await import("./_generated/api");
    const id = await t.mutation(internal.chatContext.insertAgentMessage, {
      projectId,
      content: "Oke.<longcat_tool_call>grep<longcat_arg_key>pattern</longcat_arg_key>",
    });
    const row = await t.run(async (ctx) => ctx.db.get(id as any));
    expect((row as any).content).toBe("Oke.");
  });
});
