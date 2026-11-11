/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { quoteContextLine, quoteSnippet, quotedResponderId, stripMarkdown } from "./lib/chat/quote";

/**
 * Chat "Reply": a user message quoting an earlier message. A quoted
 * teammate answers (unless the user @mentioned someone, or the quote is the
 * CTO's), and the quoted text rides into the agent's context.
 */

const calls: Array<{ system: string; msgs: { role: string; content: string }[] }> = [];

vi.mock("./lib/chat/llm", () => ({
  getGlobalLLMConfig: () => ({ baseUrl: "http://llm.test", apiKey: "k", model: "m" }),
  resolveConfigFromProviders: async (_p: unknown, global: unknown) => global,
  completeWithAgent: async (system: string, msgs: { role: string; content: string }[]) => {
    calls.push({ system, msgs: msgs.map((m) => ({ ...m })) });
    return { content: "Maksudnya bagian header.", reasoning: "", reasoningDurationMs: 0 };
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
    const designerId = await ctx.db.insert("agents", { name: "Designer", role: "designer", status: "idle", isEnabled: true });
    const projectId = await ctx.db.insert("projects", {
      name: "P",
      workspacePath: "/tmp/p",
      agentIds: [ctoId, frontendId, designerId],
    });
    return { ctoId, frontendId, designerId, projectId };
  });
  return { t, ...ids };
}

/** Sends via messages.send and runs the scheduled replyToChat. */
async function send(
  t: Awaited<ReturnType<typeof setup>>["t"],
  args: { projectId: any; content: string; preferredAgentIds?: any[]; quotedMessageId?: any }
) {
  const res = await t.mutation(api.messages.send, args);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return res;
}

async function repliesTo(t: Awaited<ReturnType<typeof setup>>["t"], userMessageId: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_reply_to", (q) => q.eq("replyToMessageId", userMessageId as any))
      .collect()
  );
}

beforeEach(() => {
  calls.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("reply quote routing", () => {
  test("a quoted teammate answers and the quoted text is in its context", async () => {
    const { t, projectId, ctoId, frontendId } = await setup();
    const quotedId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        projectId,
        agentId: frontendId,
        authorType: "agent",
        content: "I'd move the **header** into `components/Header.tsx`.",
      })
    );
    // The composer's receiver picker defaults to the CTO; the quote wins.
    const { messageId } = await send(t, {
      projectId,
      content: "kenapa ini perlu?",
      preferredAgentIds: [ctoId],
      quotedMessageId: quotedId,
    });

    const stored = await t.run(async (ctx) => ctx.db.get(messageId as any));
    expect((stored as any).quotedMessageId).toBe(quotedId);
    expect((stored as any).replyToMessageId).toBeUndefined();

    const replies = await repliesTo(t, messageId);
    expect(replies.map((r) => r.agentId)).toEqual([frontendId]);

    expect(calls).toHaveLength(1);
    const line = `The user is replying to Frontend's message: "I'd move the header into components/Header.tsx."`;
    expect(calls[0].system).toContain(line);
    // The line lives in the system prompt only; the user's reply is the
    // last chat message and no system-role row sits in the history.
    const msgs = calls[0].msgs;
    expect(msgs[msgs.length - 1]).toEqual({ role: "user", content: "kenapa ini perlu?" });
    expect(msgs.some((m: { role: string }) => m.role === "system")).toBe(false);
  });

  test("an @mention in the reply beats the quoted teammate", async () => {
    const { t, projectId, frontendId, designerId } = await setup();
    const quotedId = await t.run(async (ctx) =>
      ctx.db.insert("messages", { projectId, agentId: frontendId, authorType: "agent", content: "Header first." })
    );
    const { messageId } = await send(t, {
      projectId,
      content: "@Designer setuju?",
      preferredAgentIds: [designerId],
      quotedMessageId: quotedId,
    });
    const replies = await repliesTo(t, messageId);
    expect(replies.map((r) => r.agentId)).toEqual([designerId]);
    expect(calls[0].system).toContain(`The user is replying to Frontend's message: "Header first."`);
  });

  test("a quoted CTO message and the user's own message route as usual, with the context line", async () => {
    const { t, projectId, ctoId, frontendId } = await setup();
    const ctoMsg = await t.run(async (ctx) =>
      ctx.db.insert("messages", { projectId, agentId: ctoId, authorType: "agent", content: "Plan: header, then footer." })
    );
    const first = await send(t, { projectId, content: "kenapa header dulu?", preferredAgentIds: [ctoId], quotedMessageId: ctoMsg });
    expect((await repliesTo(t, first.messageId)).map((r) => r.agentId)).toEqual([ctoId]);
    expect(calls[0].system).toContain(`The user is replying to CTO's message: "Plan: header, then footer."`);

    calls.length = 0;
    const second = await send(t, {
      projectId,
      content: "maksudku yang ini?",
      preferredAgentIds: [ctoId],
      quotedMessageId: first.messageId as any,
    });
    // O3: the untyped CTO pick is the old default receiver (To: Team), so System routes it to a topic owner.
    const routed = await repliesTo(t, second.messageId);
    expect(routed.filter((r) => r.voice === "system").map((r) => r.content)).toEqual(["Sent to Frontend"]);
    expect(routed.filter((r) => r.voice !== "system").map((r) => r.agentId)).toEqual([frontendId]);
    expect(calls[0].system).toContain(`The user is replying to their own earlier message: "kenapa header dulu?"`);
  });

  test("a quote from another project is rejected", async () => {
    const { t, projectId, frontendId } = await setup();
    const otherQuote = await t.run(async (ctx) => {
      const other = await ctx.db.insert("projects", { name: "O", workspacePath: "/tmp/o" });
      return ctx.db.insert("messages", { projectId: other, agentId: frontendId, authorType: "agent", content: "x" });
    });
    await expect(t.mutation(api.messages.send, { projectId, content: "ini?", quotedMessageId: otherQuote })).rejects.toThrow(
      /Quoted message not found/
    );
  });
});

describe("quote helpers", () => {
  test("snippets strip markdown and truncate to one line", () => {
    expect(stripMarkdown("## Plan\n- **Bold** and `code`\n- [link](http://x)")).toBe("Plan Bold and code link");
    expect(quoteSnippet("a".repeat(200), 20)).toBe(`${"a".repeat(19)}…`);
  });

  test("responder: teammate yes, CTO / mention / user / off-team no", () => {
    const agent = { authorType: "agent" as const, agentId: "a1", role: "frontend", content: "x", inTeam: true };
    expect(quotedResponderId(agent, 0)).toBe("a1");
    expect(quotedResponderId(agent, 1)).toBeNull();
    // O3: the CTO is a teammate like any other; quoting it routes to it.
    expect(quotedResponderId({ ...agent, role: "cto" }, 0)).toBe("a1");
    expect(quotedResponderId({ ...agent, inTeam: false }, 0)).toBeNull();
    expect(quotedResponderId({ authorType: "user", content: "x" }, 0)).toBeNull();
    expect(quoteContextLine({ authorType: "user", content: "x" })).toBe(`The user is replying to their own earlier message: "x"`);
  });

  test("context line caps the quoted text at about 600 chars", () => {
    const line = quoteContextLine({ authorType: "agent", role: "designer", content: "b".repeat(2000) });
    expect(line.startsWith(`The user is replying to Designer's message: "`)).toBe(true);
    expect(line.length).toBeLessThan(700);
  });
});
