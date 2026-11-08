/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { classifyChatIntent, findProposalOption } from "./chat";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("chat intent (mirrors worker router)", () => {
  test("question with change verb stays chat", () => {
    expect(classifyChatIntent("How do I fix a TypeScript type error in a React component?").kind).toBe("chat");
  });
  test("advice stays chat", () => {
    expect(classifyChatIntent("Should I use Redux or Zustand for a small app?").kind).toBe("chat");
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
  test("greeting fast-path matches bare greetings only", async () => {
    const { GREETING } = await import("./chat");
    expect(GREETING.test("hi")).toBe(true);
    expect(GREETING.test("Hai!")).toBe(true);
    expect(GREETING.test("hello...")).toBe(true);
    expect(GREETING.test("hi, create a todo list")).toBe(false);
    expect(GREETING.test("hello world")).toBe(false);
  });
  test("findProposalOption resolves the picked id from the latest block", () => {
    const history = [
      { authorType: "user", content: "Give me two pricing directions" },
      {
        authorType: "agent",
        content:
          "Two directions for you.\n[options]\nA|Clean three-column table|Simple side-by-side tiers|sheet\nB|Popular tier spotlight|Center card emphasized|bold\n[/options]",
      },
    ];
    const found = findProposalOption(history, "b");
    expect(found?.id).toBe("B");
    expect(found?.title).toBe("Popular tier spotlight");
    expect(found?.summary).toBe("Center card emphasized");
    expect(found?.brief).toBe("Two directions for you.");
  });
  test("findProposalOption returns null for hallucinated ids or no block", () => {
    expect(
      findProposalOption(
        [{ authorType: "user", content: "Give me two directions" }],
        "A"
      )
    ).toBeNull();
    expect(
      findProposalOption(
        [
          {
            authorType: "agent",
            content: "[options]\nA|Only|One|plain\n[/options]",
          },
        ],
        "C"
      )
    ).toBeNull();
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
