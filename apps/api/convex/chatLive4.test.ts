/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { routedAnswerSubtype } from "./lib/chat/dispatch";
import { NO_SPEAKER_PREFIX_LINE, buildPlanningGuidance } from "./lib/prompts/chat";

/**
 * Live test 4 (items 8e/8f): specialist replies opened with a speaker prefix
 * ("CTO: …", even Designer after an @mention), and the routed Reviewer
 * answered with a plan + "klik Create task" instead of auditing.
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

const READ = '{"tool":"read_file","arguments":{"path":"apps/api/convex/schema.ts"}}';
const REVIEWER_PROMPT = "REVIEWER-PERSONA: audit code for bugs and risks.";
const CTO_PROMPT = "CTO-PERSONA: plan and delegate.";

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const mk = (name: string, role: string, systemPrompt?: string) =>
      ctx.db.insert("agents", { name, role, status: "idle", isEnabled: true, ...(systemPrompt ? { systemPrompt } : {}) });
    const ctoId = await mk("CTO", "cto", CTO_PROMPT);
    const reviewerId = await mk("Reviewer", "reviewer", REVIEWER_PROMPT);
    const designerId = await mk("Designer", "designer");
    const qaId = await mk("QA", "qa");
    const projectId = await ctx.db.insert("projects", {
      name: "P",
      workspacePath: "/repo",
      agentIds: [ctoId, reviewerId, designerId, qaId],
    });
    await ctx.db.insert("workers", {
      workerId: "w1",
      capacity: 1,
      activeTasks: 0,
      status: "online",
      lastHeartbeatAt: Date.now(),
      capabilities: ["repoTools"],
    });
    return { ctoId, reviewerId, designerId, qaId, projectId };
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

describe("routed Reviewer audits with its own prompt and the repo tools", () => {
  test("'tolong audit kode src/' labelled task/audit goes to the Reviewer as an audit, not a CTO plan", async () => {
    const { t, projectId, ctoId, reviewerId } = await setup();
    llmIntent.intent = "task";
    llmIntent.subtype = "audit";
    reply = (call) => {
      if (speaker(call) === "Reviewer") return toolResults(call) === 0 ? READ : "CTO: Temuan: defineSchema tanpa index (sedang).";
      return "nothing to add";
    };
    const replies = await ask(t, projectId, "tolong audit kode src/ ya");
    expect(replies.map((r) => String(r.agentId))).toEqual([String(ctoId), String(reviewerId)]);
    // Saved without the copied speaker prefix.
    expect(replies[1].content).toBe("Temuan: defineSchema tanpa index (sedang).");
    expect(replies.some((r) => r.taskOffer)).toBe(false);
    const first = callsBy("Reviewer")[0];
    expect(first.system).toContain(REVIEWER_PROMPT);
    expect(first.system).not.toContain(CTO_PROMPT);
    expect(first.system).not.toContain("You are the orchestrator");
    expect(first.system).not.toContain("klik Create task");
    expect(first.system).toContain("## Repo tools");
    expect(first.system).toContain("Give a read-only audit");
    expect(first.system).toContain("never answer it with a plan");
    expect(first.system).toContain(NO_SPEAKER_PREFIX_LINE);
    // It actually ran a repo tool.
    expect(callsBy("Reviewer").some((c) => toolResults(c) > 0)).toBe(true);
  });

  test("routedAnswerSubtype: review/security → audit; implementation → explanation; others kept", () => {
    expect(routedAnswerSubtype("reviewer", "implementation")).toBe("audit");
    expect(routedAnswerSubtype("security", "research")).toBe("audit");
    expect(routedAnswerSubtype("qa", "implementation")).toBe("explanation");
    expect(routedAnswerSubtype("qa", "testing")).toBe("testing");
  });

  test("a specialist with repo tools is never told an audit needs a task", () => {
    const intent = { kind: "chat", frontend: false, backend: false, testing: false, security: false };
    const withTools = buildPlanningGuidance({ role: "reviewer" }, { isOrchestrator: false, hasRepoTools: true, taskIntent: intent }).join("\n");
    expect(withTools).not.toMatch(/\(audit, review, run code\) say that it needs a task/);
    expect(withTools).toContain("never answer it with a plan or by telling the user to create a task");
  });
});

describe("no speaker prefixes", () => {
  test("@Designer after a CTO reply: no 'CTO:' line in its history, and a copied '**CTO:**' prefix is stripped", async () => {
    const { t, projectId, ctoId, designerId } = await setup();
    reply = (call) => (speaker(call) === "CTO" ? "Rencana: cek palet dulu." : "ok");
    await ask(t, projectId, "kita mulai dari mana untuk tampilannya?", [ctoId]);
    calls.length = 0;
    reply = (call) => (speaker(call) === "Designer" ? "**CTO:** Kontras teks utama 12.6:1, lolos AA." : "nothing to add");
    const replies = await ask(t, projectId, "@Designer warna teks utama sudah cukup kontras?", [designerId]);
    const designerReply = replies.find((r) => String(r.agentId) === String(designerId));
    expect(designerReply?.content).toBe("Kontras teks utama 12.6:1, lolos AA.");
    const call = callsBy("Designer")[0];
    for (const m of call.msgs) expect(m.content).not.toMatch(/^CTO:/m);
    expect(call.msgs.map((m) => m.content).join("\n")).toContain("[Earlier reply from teammate CTO");
    expect(call.system).toContain(NO_SPEAKER_PREFIX_LINE);
  });

  test("a reply in a role the team lacks ('Support: …') still loses the label", async () => {
    const { t, projectId, designerId } = await setup();
    reply = () => "Support: Gunakan warna #1a1a1a.";
    const replies = await ask(t, projectId, "@Designer warna teks?", [designerId]);
    expect(replies.find((r) => String(r.agentId) === String(designerId))?.content).toBe("Gunakan warna #1a1a1a.");
  });
});

describe("a used Create task offer", () => {
  async function offerReply(t: Awaited<ReturnType<typeof setup>>["t"], projectId: any) {
    reply = () => "Siap, klik Create task untuk menjalankan npm run test.";
    const replies = await ask(t, projectId, "tolong jalankan tes");
    const offer = replies.find((r) => r.taskOffer);
    expect(offer).toBeTruthy();
    return offer!;
  }

  test("the button marks the offer used; a second click returns the same task", async () => {
    const { t, projectId } = await setup();
    const offer = await offerReply(t, projectId);
    const first = await t.mutation(api.tasks.createFromCommand, { projectId, command: "jalankan npm run test", offerMessageId: offer._id });
    const again = await t.mutation(api.tasks.createFromCommand, { projectId, command: "jalankan npm run test", offerMessageId: offer._id });
    expect(again).toBe(first);
    const row = await t.run(async (ctx) => ctx.db.get(offer._id));
    expect(row?.taskOffer).toMatchObject({ kind: offer.taskOffer!.kind, usedTaskId: first });
    expect(typeof row?.taskOffer?.usedAt).toBe("number");
    expect(await t.run(async (ctx) => ctx.db.query("tasks").collect())).toHaveLength(1);
    // "gas" after the button: the offer is used, so no second task.
    await ask(t, projectId, "gas");
    expect(await t.run(async (ctx) => ctx.db.query("tasks").collect())).toHaveLength(1);
  });

  test("a go reply marks the offer used too, so the button then opens that task", async () => {
    const { t, projectId } = await setup();
    const offer = await offerReply(t, projectId);
    await ask(t, projectId, "gas");
    const tasks = await t.run(async (ctx) => ctx.db.query("tasks").collect());
    expect(tasks).toHaveLength(1);
    const row = await t.run(async (ctx) => ctx.db.get(offer._id));
    expect(row?.taskOffer?.usedTaskId).toBe(tasks[0]._id);
    const viaButton = await t.mutation(api.tasks.createFromCommand, { projectId, command: "x", offerMessageId: offer._id });
    expect(viaButton).toBe(tasks[0]._id);
  });

  test("an offer from another project is refused", async () => {
    const { t, projectId } = await setup();
    const offer = await offerReply(t, projectId);
    const other = await t.run(async (ctx) => ctx.db.insert("projects", { name: "Other", workspacePath: "/o" }));
    await expect(t.mutation(api.tasks.createFromCommand, { projectId: other, command: "x", offerMessageId: offer._id })).rejects.toThrow(/does not belong/);
  });
});
