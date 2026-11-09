/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { buildHandoffGuidance, classifyChatIntent, extractAgentMentions, parseIntentResult, parseResponderSelection, pickConversationalAgent } from "./chat";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("chat intent (mirrors worker router)", () => {
  test("question with change verb stays chat", () => {
    expect(classifyChatIntent("How do I fix a TypeScript type error in a React component?").kind).toBe("chat");
  });
  test("advice stays chat", () => {
    expect(classifyChatIntent("Should I use Redux or Zustand for a small app?").kind).toBe("chat");
  });
  test("capability confirmation questions stay chat (not tasks)", () => {
    expect(classifyChatIntent("can you be a CTO for this team?").kind).toBe("chat");
    expect(classifyChatIntent("kamu beneran kan bisa jadi CTO buat para anggota disini").kind).toBe("chat");
    expect(classifyChatIntent("bisa kah kamu review arsitektur ini?").kind).toBe("chat");
  });
  test("explicit negation always wins", () => {
    expect(classifyChatIntent("Should I use Redux or Zustand? Give pros and cons, do not create a task.").kind).toBe("chat");
    expect(classifyChatIntent("Refactor auth, jangan buat task").kind).toBe("chat");
  });
  test("imperative create still dispatches task", () => {
    expect(classifyChatIntent("Create a file called hello.txt").kind).toBe("task");
    expect(classifyChatIntent("Refactor the authentication flow across frontend and backend.").kind).toBe("task");
  });
  test("read-only audit without change verb is chat", () => {
    expect(classifyChatIntent("Audit this workspace: list risks. Read-only, do not modify files.").kind).toBe("chat");
  });
  test("greeting is chat", () => {
    expect(classifyChatIntent("hello!").kind).toBe("chat");
  });
  test("parseIntentResult validates the structured schema", () => {
    const task = parseIntentResult('{"intent":"task","subtype":"implementation","requiresWorkspace":true,"confidence":0.9,"reasoning":"add"}');
    expect(task?.intent).toBe("task");
    expect(task?.subtype).toBe("implementation");
    expect(task?.requiresExecution).toBe(true);
    const ask = parseIntentResult('{"intent":"ask","subtype":"explanation","confidence":0.7}');
    expect(ask?.intent).toBe("ask");
    expect(parseIntentResult("not json")).toBeNull();
    expect(parseIntentResult('{"intent":"nope"}')).toBeNull();
  });
  test("chooser fallback prefers General then Researcher then Support", () => {
    const pool = [
      { _id: "r1", name: "Researcher", role: "researcher" },
      { _id: "g1", name: "General", role: "general" },
      { _id: "s1", name: "Support", role: "support" },
      { _id: "c1", name: "CTO", role: "cto" },
    ];
    expect(pickConversationalAgent(pool)[0]._id).toBe("g1");
    expect(pickConversationalAgent(pool.filter((a) => a.role !== "general"))[0]._id).toBe("r1");
    expect(pickConversationalAgent(pool.filter((a) => a.role !== "general" && a.role !== "researcher"))[0]._id).toBe("s1");
  });
  test("parseResponderSelection only accepts ids from the pool", () => {
    expect(parseResponderSelection('{"agentId":"f1"}', ["f1", "r1"])).toBe("f1");
    expect(parseResponderSelection('{"agentId":"nope"}', ["f1"])).toBeNull();
    expect(parseResponderSelection("not json", ["f1"])).toBeNull();
  });
  test("greeting fast-path matches bare greetings only", async () => {
    const { GREETING } = await import("./chat");
    expect(GREETING.test("hi")).toBe(true);
    expect(GREETING.test("Hai!")).toBe(true);
    expect(GREETING.test("hello...")).toBe(true);
    expect(GREETING.test("hi, create a todo list")).toBe(false);
    expect(GREETING.test("hello world")).toBe(false);
  });
  test("duplicate reply guard still works (checkAlreadyReplied)", async () => {
    const t = convexTest(schema, modules);
    const { projectId, conversationId, userMessageId } = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
      const conversationId = await ctx.db.insert("conversations", { projectId, status: "active", createdAt: 1 });
      const userMessageId = await ctx.db.insert("messages", { projectId, conversationId, authorType: "user", content: "hi" });
      return { projectId, conversationId, userMessageId };
    });
    const { internal } = await import("./_generated/api");
    expect(await t.query(internal.chatContext.checkAlreadyReplied, { userMessageId })).toBe(false);
  });
});

describe("CTO @mention handoff", () => {
  const team = [
    { _id: "cto", name: "CTO", role: "cto" },
    { _id: "fe", name: "Frontend", role: "frontend" },
    { _id: "be", name: "Backend", role: "backend" },
    { _id: "qa", name: "QA", role: "qa" },
  ];

  test("finds teammates mentioned by name or role, in order of appearance", () => {
    const text = "Saya usul begini. @Backend tolong cek skema, lalu @frontend sesuaikan form. @QA nanti tes.";
    expect(extractAgentMentions(text, team, "cto").map((a) => a._id)).toEqual(["be", "fe", "qa"]);
  });

  test("ignores the speaker, emails, unknown names and partial words", () => {
    const text = "@CTO di sini. Kirim ke me@Backend.dev, @Designer belum ada, @Frontendish bukan nama.";
    expect(extractAgentMentions(text, team, "cto")).toEqual([]);
  });

  test("lists the other teammates in the CTO guidance", () => {
    const lines = buildHandoffGuidance(team, "cto");
    expect(lines[0]).toContain("@Frontend");
    expect(lines[0]).not.toContain("@CTO");
  });
});
