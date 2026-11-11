/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { normalizeInvokedSkills } from "./lib/invokedSkillsSchema";

/**
 * Paradev C3: "/<skill> [request]" sends the message with `invokedSkills`.
 * The reply context inlines the skill for that turn only, on whichever agent
 * O3 routes the message to; a task made from it carries the skills into
 * every run (getRunContext → worker inline).
 */

const calls: Array<{ system: string }> = [];

vi.mock("./lib/chat/llm", () => ({
  getGlobalLLMConfig: () => ({ baseUrl: "http://llm.test", apiKey: "k", model: "m" }),
  resolveConfigFromProviders: async (_p: unknown, global: unknown) => global,
  completeWithAgent: async (system: string) => {
    calls.push({ system });
    return { content: "Here is the plan.", reasoning: "", reasoningDurationMs: 0 };
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
const BODY = "Use the 8px grid and theme tokens only.";

async function setup() {
  const t = convexTest(schema, modules);
  const skillId = await t.mutation(api.skills.create, { name: "frontend-design", description: "UI craft", instructions: BODY });
  const ids = await t.run(async (ctx) => {
    const ctoId = await ctx.db.insert("agents", { name: "CTO", role: "cto", status: "idle", isEnabled: true });
    const frontendId = await ctx.db.insert("agents", { name: "Frontend", role: "frontend", status: "idle", isEnabled: true });
    // Only the Designer carries the skill; whoever answers still gets it.
    const designerId = await ctx.db.insert("agents", {
      name: "Designer",
      role: "designer",
      status: "idle",
      isEnabled: true,
      skillIds: [skillId],
      skillLoading: "on_demand",
    });
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p", agentIds: [ctoId, frontendId, designerId] });
    return { ctoId, frontendId, designerId, projectId };
  });
  return { t, skillId, ...ids };
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

beforeEach(() => {
  calls.length = 0;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("messages.send invokedSkills", () => {
  test("stores the canonical name; the routed owner's reply context has the body once, for that turn only", async () => {
    const { t, projectId } = await setup();
    const { messageId } = await t.mutation(api.messages.send, {
      projectId,
      content: "/frontend-design make the header nicer",
      invokedSkills: ["Frontend-Design"],
    });
    const stored = await t.run(async (ctx) => ctx.db.get(messageId as never));
    expect((stored as { invokedSkills?: string[] }).invokedSkills).toEqual(["frontend-design"]);

    const context = await t.query(internal.chatContext.getContext, { projectId, userMessageId: messageId as never });
    for (const shape of [...context.agents, ...(context.team ?? [])]) {
      expect(count(shape.skillsSection ?? "", BODY)).toBe(1);
      expect(shape.skillsSection).toContain("## Skills invoked for this request");
    }

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const replies = await t.run(async (ctx) =>
      ctx.db.query("messages").withIndex("by_reply_to", (q) => q.eq("replyToMessageId", messageId as never)).collect()
    );
    const answered = replies.filter((r) => r.authorType === "agent" && r.agentId && r.voice !== "system");
    expect(answered.length).toBeGreaterThan(0);
    expect(calls.length).toBeGreaterThan(0);
    expect(count(calls[calls.length - 1].system, BODY)).toBe(1);

    // Next turn, no skill: not inlined any more.
    const next = await t.mutation(api.messages.send, { projectId, content: "thanks, what about the footer?" });
    const later = await t.query(internal.chatContext.getContext, { projectId, userMessageId: next.messageId as never });
    for (const shape of later.team ?? []) expect(shape.skillsSection ?? "").not.toContain(BODY);
  });

  test("a skill the team does not carry is refused inline and nothing is stored", async () => {
    const { t, projectId } = await setup();
    await expect(
      t.mutation(api.messages.send, { projectId, content: "/nope do it", invokedSkills: ["nope"] })
    ).rejects.toThrow("No skill named nope on this team.");
    const rows = await t.run(async (ctx) => ctx.db.query("messages").collect());
    expect(rows).toHaveLength(0);
  });

  test("names are trimmed, de-duplicated and capped", () => {
    expect(normalizeInvokedSkills([" a ", "A", "b"])).toEqual(["a", "b"]);
    expect(() => normalizeInvokedSkills(["a", "b", "c", "d"])).toThrow(/at most 3/);
  });
});

describe("task invokedSkills", () => {
  test("Create task on a skill message's offer copies the skills; getRunContext inlines them for every agent", async () => {
    const { t, projectId, ctoId, frontendId } = await setup();
    const { messageId } = await t.mutation(api.messages.send, {
      projectId,
      content: "/frontend-design redo the header",
      invokedSkills: ["frontend-design"],
    });
    const offerId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        projectId,
        agentId: ctoId,
        authorType: "agent",
        content: "Plan: redo the header. Create task?",
        replyToMessageId: messageId as never,
      })
    );
    const taskId = await t.mutation(api.tasks.createFromCommand, {
      projectId,
      command: "Redo the header",
      offerMessageId: offerId,
      assignedAgentIds: [frontendId],
      conversationContext: false,
    });
    const task = await t.run(async (ctx) => ctx.db.get(taskId as never));
    expect((task as { invokedSkills?: string[] }).invokedSkills).toEqual(["frontend-design"]);

    const run = await t.query(internal.orchestration.getRunContext, { taskId: taskId as never });
    // Frontend does not carry the skill; the invoked copy still reaches it.
    expect(run!.agents.map((a) => a.invokedSkills?.map((s) => s.name))).toEqual([["frontend-design"]]);
    expect(run!.agents[0].invokedSkills![0].instructions).toBe(BODY);
  });

  test("/task with an unknown skill is refused; a plain task carries none", async () => {
    const { t, projectId } = await setup();
    await expect(
      t.mutation(api.tasks.createFromCommand, { projectId, command: "x", invokedSkills: ["ghost"] })
    ).rejects.toThrow("No skill named ghost on this team.");
    const taskId = await t.mutation(api.tasks.createFromCommand, { projectId, command: "Fix the build" });
    const run = await t.query(internal.orchestration.getRunContext, { taskId: taskId as never });
    expect(run!.task.invokedSkills).toBeUndefined();
    expect(run!.agents.every((a) => a.invokedSkills === undefined)).toBe(true);
  });
});
