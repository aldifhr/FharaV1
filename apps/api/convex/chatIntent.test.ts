/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, it } from "vitest";
import { classifyChatIntent, explicitTaskCommand, parseIntentResult } from "./lib/chat/intent";
import { resolveAssignees, suggestAssigneesByKeywords, extractAgentMentions, selectHandoffs, handoffRequestFor, parseResponderSelection, pickConversationalAgent, pickGreetingResponders } from "./lib/chat/team";
import { stripToolCallMarkup } from "./lib/chat/strip";
import { buildAssignmentGuidance, buildHandoffGuidance } from "./lib/prompts/chat";
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
  test("imperative create is only a work suggestion, never a dispatch", () => {
    // kind "task" shapes the CTO reply (plan + Create task button); chat
    // starts a task only from an explicit command or the button.
    expect(classifyChatIntent("Create a file called hello.txt").kind).toBe("task");
    expect(classifyChatIntent("Refactor the authentication flow across frontend and backend.").kind).toBe("task");
    expect(explicitTaskCommand("Create a file called hello.txt")).toBeNull();
    expect(explicitTaskCommand("Refactor the authentication flow across frontend and backend.")).toBeNull();
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
    const { GREETING } = await import("./lib/chat/intent");
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

  test("a roster of the whole team is not a handoff", () => {
    const big = [...team, { _id: "ds", name: "Designer", role: "designer" }];
    const text = "Bisa. Saya koordinasi dengan @Designer untuk UX, @Frontend untuk UI, @QA untuk tes, @Backend untuk server.";
    expect(selectHandoffs(text, big, "cto")).toEqual([]);
    expect(selectHandoffs("@Backend tolong cek skema. @QA nanti tes.", big, "cto").map((a) => a._id)).toEqual(["be", "qa"]);
  });

  test("handoff request is the sentence addressed to the teammate", () => {
    const text = "Saya usul begini. @Backend tolong cek skema users. @QA nanti tes.";
    expect(handoffRequestFor(text, { name: "Backend", role: "backend" })).toBe("@Backend tolong cek skema users.");
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

describe("CTO task assignment", () => {
  const team = [
    { _id: "cto", name: "CTO", role: "cto" },
    { _id: "fe", name: "Frontend", role: "frontend" },
    { _id: "be", name: "Backend", role: "backend" },
    { _id: "qa", name: "QA", role: "qa" },
    { _id: "rv", name: "Reviewer", role: "reviewer" },
  ];

  test("keeps the CTO, the assignees, and Reviewer/QA in the pool", () => {
    const pool = resolveAssignees(team, team[0], [team[1]]).map((a) => a._id).sort();
    expect(pool).toEqual(["cto", "fe", "qa", "rv"]);
  });

  test("returns no pool when nobody was assigned", () => {
    expect(resolveAssignees(team, team[0], [])).toEqual([]);
  });

  test("assignment guidance lists teammates and the user's picks", () => {
    const lines = buildAssignmentGuidance(team, "cto", [{ name: "Backend" }]).join("\n");
    expect(lines).toContain("@Frontend");
    expect(lines).toContain("include them");
    expect(lines).not.toContain("@CTO,");
  });
});

describe("stripToolCallMarkup", () => {
  it("drops complete and dangling tool-call blocks", () => {
    expect(stripToolCallMarkup("Cek dulu.<longcat_tool_call>X\n<a>b</a></longcat_tool_call> ok")).toBe("Cek dulu. ok");
    expect(stripToolCallMarkup("Saya lihat file.<longcat_tool_call>DevOps\n<longcat_arg_ke")).toBe("Saya lihat file.");
    expect(stripToolCallMarkup("plain")).toBe("plain");
  });
});

describe("suggestAssigneesByKeywords", () => {
  const team = ["Frontend", "Backend", "Designer", "DevOps", "Researcher", "Support", "QA", "Reviewer"].map((r) => ({ _id: r, name: r, role: r.toLowerCase() }));
  it("picks owners from the request", () => {
    expect(suggestAssigneesByKeywords("Implement helper countGraphemes di src/lib/resume", team).map((a) => a.name)).toEqual(["Backend"]);
    expect(suggestAssigneesByKeywords("ubah tampilan halaman login dan update README", team).map((a) => a.name)).toEqual(["Frontend", "Support"]);
  });
  it("falls back to Backend, never the whole team", () => {
    expect(suggestAssigneesByKeywords("kerjain ini dong", team).map((a) => a.name)).toEqual(["Backend"]);
  });
});

describe("chat dispatch safety (e2e safety probe)", () => {
  test("paths outside the repository are detected", async () => {
    const { targetsOutsideRepo } = await import("./lib/chat/intent");
    expect(targetsOutsideRepo("hapus /etc/hosts dan edit ../outside.txt")).toBe("/etc/hosts");
    expect(targetsOutsideRepo("edit ../outside.txt")).toBe("../outside.txt");
    expect(targetsOutsideRepo("write ~/.ssh/config")).toBe("~/.ssh/config");
    expect(targetsOutsideRepo("delete C:\\Windows\\system32")).toBe("C:\\Windows\\system32");
    expect(targetsOutsideRepo("change /usr/bin/node")).toBe("/usr/bin/node");
    // In-repo paths and plain words are fine.
    expect(targetsOutsideRepo("Tambahkan dark mode dengan toggle di header, refactor header jadi komponen terpisah, tambah test, dan update README")).toBeNull();
    expect(targetsOutsideRepo("update src/etc/config.ts and ./docs/README.md")).toBeNull();
    expect(targetsOutsideRepo("fix the /api/users endpoint")).toBeNull();
    expect(targetsOutsideRepo("bump version 1.2..3")).toBeNull();
  });

  test("CTO refusals are recognised, hand-offs are not", async () => {
    const { isRefusalReply } = await import("./lib/chat/intent");
    expect(isRefusalReply("I can't do that: /etc/hosts is outside the project repository.")).toBe(true);
    expect(isRefusalReply("Saya tidak bisa menghapus /etc/hosts karena itu di luar repository.")).toBe(true);
    expect(isRefusalReply("Maaf, permintaan ini di luar repo project, jadi tidak saya kerjakan.")).toBe(true);
    expect(isRefusalReply("I won't edit files outside the workspace.")).toBe(true);
    expect(isRefusalReply("Plan: @Frontend adds the dark-mode toggle, @Support updates the README.")).toBe(false);
    expect(isRefusalReply("I can't wait to ship this", 2)).toBe(false);
    expect(isRefusalReply("Sounds good — @Frontend will build the header component.", 1)).toBe(false);
  });
});

describe("pickGreetingResponders", () => {
  const cto = { _id: "c", name: "CTO", role: "cto" };
  const researcher = { _id: "r", name: "Researcher", role: "researcher" };
  const frontend = { _id: "f", name: "Frontend", role: "frontend" };
  const team = [cto, researcher, frontend];

  it("lets the CTO answer a bare greeting, not the Researcher", () => {
    expect(pickGreetingResponders([], cto, team)).toEqual([cto]);
  });

  it("an @mention wins", () => {
    expect(pickGreetingResponders([frontend], cto, team)).toEqual([frontend]);
  });

  it("falls back to the conversational agent when no CTO is in the chat", () => {
    expect(pickGreetingResponders([], null, [researcher, frontend])).toEqual([researcher]);
  });
});

describe("O7 /research is an explicit command", () => {
  test("keeps the marker so the worker plans the fan-out", () => {
    expect(explicitTaskCommand("/research compare A vs B")).toBe("/research compare A vs B");
    expect(explicitTaskCommand("/research")).toBeNull();
    expect(explicitTaskCommand("research compare A vs B")).toBeNull();
  });
});
